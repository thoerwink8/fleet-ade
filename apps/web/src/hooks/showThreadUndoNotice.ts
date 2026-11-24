import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { shouldHideKeyboardShortcutHints } from "./useKeyboardShortcutHints";
import { shortcutLabelForCommand } from "../keybindings";
import { announce, cancelAnnouncement } from "../lib/announce";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "../state/server";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";

export const THREAD_UNDO_NOTICE_TIMEOUT_MS = 8_000;
const MAX_UNDO_TITLE_UNITS = 32;

type UndoActionKind =
  | "Settled"
  | "Snoozed"
  | "Unpinned"
  | "Archived"
  | "Discarded"
  | "DismissedAttention";

type UndoOptions = {
  action: UndoActionKind;
  title?: string | null | undefined;
  undo: () => Promise<AtomCommandResult<unknown, unknown>>;
  failureTitle: string;
  claim: ReturnType<typeof ThreadUndo.begin>;
  commit?: () => void;
};

type UndoNotice = {
  action: UndoOptions["action"];
  count: number;
  title: string | null;
  undo: () => Promise<void>;
};

export const useThreadUndoNotice = create<{ notice: UndoNotice | null }>(() => ({ notice: null }));

const ACTION_TEXT = {
  Settled: { label: "已标为完成", verb: "已标为完成", noun: "会话", undone: "已取消完成" },
  Snoozed: { label: "已暂缓", verb: "已暂缓", noun: "会话", undone: "已取消暂缓" },
  Unpinned: { label: "已取消置顶", verb: "已取消置顶", noun: "会话", undone: "已重新置顶" },
  Archived: { label: "已归档", verb: "已归档", noun: "会话", undone: "已取消归档" },
  Discarded: { label: "已丢弃草稿", verb: "已丢弃", noun: "草稿", undone: "已恢复" },
  DismissedAttention: {
    label: "已移出等你处理",
    verb: "已移出等你处理",
    noun: "会话",
    undone: "已标为未读",
  },
} satisfies Record<
  UndoOptions["action"],
  { label: string; verb: string; noun: string; undone: string }
>;

function charDisplayUnits(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  return codePoint > 0xff ? 2 : 1;
}

function truncateUndoNoticeTitle(title: string): string | null {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  const chars = Array.from(normalized);
  let totalUnits = 0;
  for (const ch of chars) totalUnits += charDisplayUnits(ch);
  if (totalUnits <= MAX_UNDO_TITLE_UNITS) return normalized;
  let prefix = "";
  let units = 0;
  for (const ch of chars) {
    const nextUnits = charDisplayUnits(ch);
    if (units + nextUnits > MAX_UNDO_TITLE_UNITS - 2) break;
    prefix += ch;
    units += nextUnits;
  }
  return `${prefix}…`;
}

export function threadUndoNoticeSummary(
  notice: Pick<UndoNotice, "action" | "count"> & { readonly title?: string | null },
): string {
  const text = ACTION_TEXT[notice.action];
  if (notice.count > 1) return `${text.verb} ${notice.count} 个${text.noun}`;
  const title = notice.title ? truncateUndoNoticeTitle(notice.title) : null;
  return title ? `${text.label}「${title}」` : text.label;
}

function threadUndoLabel(keybindings: Parameters<typeof shortcutLabelForCommand>[0]) {
  if (shouldHideKeyboardShortcutHints()) return "撤销";
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");
  return shortcut ? `按 ${shortcut} 撤销` : "撤销";
}

let announcedSummary: string | null = null;
let undoToastId: ReturnType<typeof toastManager.add> | null = null;
let shownToastTitle: string | null = null;

function closeUndoToast() {
  if (undoToastId == null) return;
  const id = undoToastId;
  undoToastId = null;
  shownToastTitle = null;
  toastManager.close(id);
}

function syncUndoToast(notice: UndoNotice | null) {
  if (notice === null) {
    closeUndoToast();
    return;
  }
  const title = threadUndoNoticeSummary(notice);
  const actionProps = {
    children: "撤销",
    onClick: () => {
      void undoLatestThreadAction();
    },
  };
  if (undoToastId != null) {
    if (shownToastTitle === title) return;
    shownToastTitle = title;
    toastManager.update(undoToastId, { title, timeout: 0, actionProps });
    return;
  }
  shownToastTitle = title;
  let addedId: ReturnType<typeof toastManager.add> | null = null;
  const clearIfCurrent = () => {
    if (addedId !== null && undoToastId === addedId) {
      undoToastId = null;
      shownToastTitle = null;
    }
  };
  const id = toastManager.add({
    type: "success",
    title,
    timeout: 0,
    actionProps,
    data: { onClose: clearIfCurrent },
    onRemove: clearIfCurrent,
  });
  addedId = id ?? null;
  undoToastId = addedId;
}

// A live region that mounts already filled is skipped by screen readers, and settling
// usually moves focus to the next thread at the same moment, so the notice is announced
// separately from the alert that shows it.
function setNotice(notice: UndoNotice | null) {
  useThreadUndoNotice.setState({ notice });
  syncUndoToast(notice);
  const summary = notice ? threadUndoNoticeSummary(notice) : null;
  if (summary === announcedSummary) return;
  announcedSummary = summary;
  if (summary) {
    const label = threadUndoLabel(appAtomRegistry.get(primaryServerKeybindingsAtom));
    announce(`${summary}，${label}`, "thread-undo-notice");
  } else {
    cancelAnnouncement("thread-undo-notice");
  }
}

let liveUndos: UndoOptions[] = [];
let expiry: ReturnType<typeof setTimeout> | undefined;
// A new notice owns mod+z even inside a text field, until the user presses
// another key or edits text. After that, mod+z is the field's own undo again.
let shortcutClaimed = false;

function refreshNotice() {
  const stale = liveUndos.filter(({ claim }) => !claim.isCurrent());
  liveUndos = liveUndos.filter((entry) => !stale.includes(entry));
  for (const entry of stale) entry.commit?.();
  const latest = liveUndos.at(-1);
  if (!latest) {
    clearTimeout(expiry);
    setNotice(null);
    return;
  }
  const group: UndoOptions[] = [];
  for (let index = liveUndos.length - 1; index >= 0; index--) {
    const entry = liveUndos[index]!;
    if (entry.action !== latest.action) break;
    group.push(entry);
  }
  setNotice({
    action: latest.action,
    count: group.length,
    title: group.length === 1 ? (latest.title ?? null) : null,
    undo: async () => {
      const current = group.filter((entry) => liveUndos.includes(entry) && entry.claim.isCurrent());
      liveUndos = liveUndos.filter((entry) => !group.includes(entry));
      // Claim before awaiting to prevent repeated actions restoring a group twice.
      for (const entry of current) entry.claim.finish();
      refreshNotice();
      let undone = 0;
      await Promise.all(
        current.map(async ({ undo, failureTitle }) => {
          const reportFailure = (error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: failureTitle,
                description: error instanceof Error ? error.message : "发生错误。",
              }),
            );
          };
          try {
            const result = await undo();
            if (result._tag === "Success") undone++;
            else if (!isAtomCommandInterrupted(result)) {
              reportFailure(squashAtomCommandFailure(result));
            }
          } catch (error) {
            reportFailure(error);
          }
        }),
      );
      // Failures already raise a toast, so only what was actually restored is spoken.
      if (undone > 0) {
        const text = ACTION_TEXT[latest.action];
        announce(`${text.undone} ${undone} 个${text.noun}`);
      }
    },
  });
}

ThreadUndo.subscribe(refreshNotice);

export function undoLatestThreadAction(): boolean {
  const notice = useThreadUndoNotice.getState().notice;
  if (!notice) return false;
  void notice.undo();
  return true;
}

/** Whether mod+z should undo the notice's actions even while a text field is focused. */
export function threadUndoClaimsShortcut(): boolean {
  return shortcutClaimed && useThreadUndoNotice.getState().notice !== null;
}

/** Called on any other keypress or text edit; hands mod+z back to text fields. */
export function releaseThreadUndoShortcut() {
  shortcutClaimed = false;
}

/** Shows one compact confirmation for a batch of undoable thread actions. */
export function showThreadUndoNotices(entries: readonly UndoOptions[]) {
  const current = entries.filter((entry) => entry.claim.isCurrent());
  if (current.length === 0) return;
  liveUndos.push(...current);
  shortcutClaimed = true;
  refreshNotice();
  clearTimeout(expiry);
  expiry = setTimeout(() => {
    const expired = liveUndos;
    liveUndos = [];
    for (const { claim, commit } of expired) {
      claim.finish();
      commit?.();
    }
    refreshNotice();
  }, THREAD_UNDO_NOTICE_TIMEOUT_MS);
}

/** Shows one compact confirmation for the currently undoable thread action. */
export function showThreadUndoNotice(options: UndoOptions) {
  showThreadUndoNotices([options]);
}
