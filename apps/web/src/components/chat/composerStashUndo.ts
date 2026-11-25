import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

import { THREAD_UNDO_NOTICE_TIMEOUT_MS } from "../../hooks/showThreadUndoNotice";
import { releasePersistedAttachmentUpload } from "../../lib/attachmentUploadQueue";
import {
  MAX_STASH_ENTRIES,
  type PromptStashEntry,
  type StashRestoreAnchor,
  usePromptStashStore,
} from "../../promptStashStore";
import { toastManager } from "../ui/toast";

export const STASH_DELETE_UNDO_TIMEOUT_MS = THREAD_UNDO_NOTICE_TIMEOUT_MS;
const STASH_UNDO_SNIPPET_MAX_CHARS = 24;

export interface StashUndoDeps {
  readonly releaseUpload?: typeof releasePersistedAttachmentUpload;
  readonly toast?: typeof toastManager;
  readonly store?: Pick<
    ReturnType<typeof usePromptStashStore.getState>,
    "takeEntry" | "insertEntry"
  >;
}

const activeTimers = new Set<ReturnType<typeof setTimeout>>();

export function clearPendingStashUndosForTest(): void {
  for (const timer of activeTimers) {
    clearTimeout(timer);
  }
  activeTimers.clear();
}

function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function stashEntryUndoSnippet(entry: PromptStashEntry): string {
  const plain = assistantCitationsToPlainText(entry.prompt).trim().replace(/\s+/g, " ");
  if (plain.length > 0) {
    return truncateChars(plain, STASH_UNDO_SNIPPET_MAX_CHARS);
  }
  const imageCount = entry.attachments.length + entry.droppedImageNames.length;
  const fileCount = entry.files?.length ?? 0;
  const total = imageCount + fileCount;
  if (total === 0) return "";
  if (imageCount > 0 && fileCount > 0) return `${total} 个附件`;
  if (fileCount > 0) return `${fileCount} 个文件`;
  return `${imageCount} 张图片`;
}

function registerStashEntryUndo(input: {
  readonly entry: PromptStashEntry;
  readonly anchor: StashRestoreAnchor;
  readonly durable: boolean;
  readonly title: string;
  readonly description?: string;
  readonly deps?: StashUndoDeps | undefined;
}): void {
  const releaseUpload = input.deps?.releaseUpload ?? releasePersistedAttachmentUpload;
  const toast = input.deps?.toast ?? toastManager;
  const store = input.deps?.store ?? usePromptStashStore.getState();

  let settled = false;
  let toastId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      activeTimers.delete(timer);
      timer = undefined;
    }
  };

  const commit = () => {
    if (settled) return;
    settled = true;
    stopTimer();
    if (toastId) {
      const id = toastId;
      toastId = null;
      toast.close(id);
    }
    if (!input.durable) return;
    for (const file of input.entry.files ?? []) {
      releaseUpload({
        id: file.id,
        environmentId: file.environmentId,
        attachmentId: file.attachmentId,
      });
    }
  };

  const undo = () => {
    if (settled) return;
    // Mark settled before closing the toast so toast onClose/onRemove cannot trigger commit cleanup.
    settled = true;
    stopTimer();
    const id = toastId;
    toastId = null;
    if (id) {
      toast.close(id);
    }
    const { inserted, durable: restoredDurable } = store.insertEntry(input.entry, input.anchor);
    if (inserted && !restoredDurable) {
      toast.add({
        type: "warning",
        title: "已撤销删除，但刷新后可能丢失",
        description: "浏览器存储拒绝了写入，刷新页面后这条暂存记录可能不会保留。",
        data: { hideCopyButton: true },
      });
    }
  };

  timer = setTimeout(commit, STASH_DELETE_UNDO_TIMEOUT_MS);
  activeTimers.add(timer);

  toastId =
    toast.add({
      type: "success",
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      // Managed by the explicit 8s timer above so each deleted entry keeps its own undo window.
      timeout: 0,
      actionProps: {
        children: "撤销",
        onClick: undo,
      },
      data: {
        hideCopyButton: true,
        onClose: commit,
      },
      onRemove: commit,
    }) ?? null;
}

export function deleteStashEntryWithUndo(
  entry: PromptStashEntry,
  deps?: StashUndoDeps,
): { readonly deleted: boolean; readonly remainingCount: number } {
  const store = deps?.store ?? usePromptStashStore.getState();
  const { entry: removed, durable, anchor } = store.takeEntry(entry.id);
  const remainingCount = usePromptStashStore.getState().entries.length;
  if (!removed || !anchor) {
    return { deleted: false, remainingCount };
  }
  const snippet = stashEntryUndoSnippet(removed);
  const title = snippet ? `已删除暂存「${snippet}」` : "已删除暂存";
  registerStashEntryUndo({
    entry: removed,
    anchor,
    durable,
    title,
    ...(durable ? {} : { description: "浏览器存储未能同步这次删除，刷新后这条记录可能仍在。" }),
    deps,
  });
  return { deleted: true, remainingCount };
}

export function registerEvictedStashUndo(
  evicted: PromptStashEntry,
  anchor: StashRestoreAnchor,
  deps?: StashUndoDeps,
): void {
  const snippet = stashEntryUndoSnippet(evicted);
  const title = snippet ? `暂存已满，已移除最早的暂存「${snippet}」` : "暂存已满，已移除最早的一条";
  registerStashEntryUndo({
    entry: evicted,
    anchor,
    durable: true,
    title,
    description: `暂存最多保留 ${MAX_STASH_ENTRIES} 条，点「撤销」可放回原位。`,
    deps,
  });
}
