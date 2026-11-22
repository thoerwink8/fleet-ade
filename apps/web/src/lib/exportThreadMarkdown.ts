import { type AtomCommandSuccess, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { toastManager } from "../components/ui/toast";
import { downloadPlanAsTextFile } from "../proposedPlan";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { buildThreadExportFilename, buildThreadMarkdown } from "./threadExport";

const MAX_EXPORT_HISTORY_PAGES = 50;

type HistoryPageResult = AtomCommandSuccess<
  Awaited<ReturnType<typeof threadEnvironment.loadEarlierHistory.run>>
>;

export interface ExportThreadSnapshot {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage> | undefined;
  readonly hasMoreHistory: boolean;
  readonly loadFailed?: true;
}

export type LoadAllThreadHistoryOutcome =
  | {
      readonly _tag: "ready";
      readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
      readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
      readonly truncated: boolean;
    }
  | { readonly _tag: "failed" };

export async function loadAllThreadHistory(input: {
  readonly readThread: () => Promise<ExportThreadSnapshot>;
  readonly loadEarlier: () => Promise<HistoryPageResult>;
  readonly maxPages?: number;
}): Promise<LoadAllThreadHistoryOutcome> {
  const maxPages = input.maxPages ?? MAX_EXPORT_HISTORY_PAGES;
  for (let pages = 0; ; pages += 1) {
    const snapshot = await input.readThread();
    if (snapshot.loadFailed) return { _tag: "failed" };
    if (!snapshot.hasMoreHistory) {
      return {
        _tag: "ready",
        items: snapshot.visibleTurnItems,
        messages: snapshot.messages ?? [],
        truncated: false,
      };
    }
    if (pages >= maxPages) {
      return {
        _tag: "ready",
        items: snapshot.visibleTurnItems,
        messages: snapshot.messages ?? [],
        truncated: true,
      };
    }
    const result = await input.loadEarlier();
    if (result._tag === "error") return { _tag: "failed" };
    // Noop means no older cursor exists; stop instead of re-reading the same snapshot.
    if (result._tag === "noop") {
      return {
        _tag: "ready",
        items: snapshot.visibleTurnItems,
        messages: snapshot.messages ?? [],
        truncated: false,
      };
    }
  }
}

type ThreadDetail<K extends keyof typeof environmentThreadDetails> = Atom.Type<
  ReturnType<(typeof environmentThreadDetails)[K]>
>;

function exportThreadSnapshot(input: {
  readonly thread: ThreadDetail<"threadAtom">;
  readonly history: ThreadDetail<"historyAtom">;
  readonly status: ThreadDetail<"statusAtom">;
  readonly error: ThreadDetail<"errorAtom">;
}): ExportThreadSnapshot | null {
  if (input.history.loading) return null;
  if (input.thread === null) {
    if (input.status === "deleted" || input.error !== null) {
      return { visibleTurnItems: [], messages: [], hasMoreHistory: false, loadFailed: true };
    }
    return null;
  }
  return {
    visibleTurnItems: input.thread.projection.visibleTurnItems,
    messages: input.thread.projection.messages,
    hasMoreHistory: input.history.hasMoreHistory,
  };
}

function waitForSettledThread(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<ExportThreadSnapshot | null>,
): Promise<ExportThreadSnapshot> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const finish = (value: ExportThreadSnapshot) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve(value);
    };
    const check = (value: ExportThreadSnapshot | null) => {
      if (value !== null) finish(value);
    };
    unsubscribe = registry.subscribe(atom, check);
    if (settled) unsubscribe();
    else check(registry.get(atom));
  });
}

const inFlightExports = new Set<string>();

export async function exportThreadMarkdown(input: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly projectName?: string | null | undefined;
  readonly registry?: AtomRegistry.AtomRegistry;
}): Promise<void> {
  const key = `${input.threadRef.environmentId}:${input.threadRef.threadId}`;
  if (inFlightExports.has(key)) return;
  inFlightExports.add(key);

  const registry = input.registry ?? appAtomRegistry;
  // Read full threadAtom instead of quietThreadAtom, which strips assistant message text.
  const threadAtom = environmentThreadDetails.threadAtom(input.threadRef);
  const historyAtom = environmentThreadDetails.historyAtom(input.threadRef);
  const statusAtom = environmentThreadDetails.statusAtom(input.threadRef);
  const errorAtom = environmentThreadDetails.errorAtom(input.threadRef);
  const settledThreadAtom = Atom.make((get) =>
    exportThreadSnapshot({
      thread: get(threadAtom),
      history: get(historyAtom),
      status: get(statusAtom),
      error: get(errorAtom),
    }),
  );

  const loadingToastId = toastManager.add({
    type: "loading",
    title: "正在加载历史…",
  });

  try {
    const outcome = await loadAllThreadHistory({
      readThread: () => waitForSettledThread(registry, settledThreadAtom),
      loadEarlier: async () => {
        const result = await runAtomCommand(
          registry,
          threadEnvironment.loadEarlierHistory,
          {
            environmentId: input.threadRef.environmentId,
            input: { threadId: input.threadRef.threadId },
          },
          { label: "export thread markdown history", reportFailure: false },
        );
        return result._tag === "Success"
          ? result.value
          : { _tag: "error", message: "无法加载历史记录。" };
      },
    });

    if (outcome._tag === "failed") {
      toastManager.add({
        type: "error",
        title: "无法加载历史记录，请稍后重试",
      });
      return;
    }

    const exportedAt = new Date();
    const markdown = buildThreadMarkdown({
      title: input.title,
      projectName: input.projectName,
      exportedAt,
      items: outcome.items,
      messages: outcome.messages,
      truncated: outcome.truncated,
    });
    const filename = buildThreadExportFilename(input.title, exportedAt);
    downloadPlanAsTextFile(filename, markdown);
    toastManager.add({
      type: "success",
      title: "已导出",
      description: "分享前请检查内容里有没有密钥或令牌",
    });
  } finally {
    toastManager.close(loadingToastId);
    inFlightExports.delete(key);
  }
}
