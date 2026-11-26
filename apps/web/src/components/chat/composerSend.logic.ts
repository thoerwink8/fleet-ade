import type { EnvironmentId, ThreadContextRecord } from "@t3tools/contracts";
import { collectInlineContextIds } from "../../lib/composerContextReferences";

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "正在检查电脑资源",
      description: "资源检查仍在进行，你可以在输入框中手动选择电脑。",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "请选择一台电脑以继续",
    description: noMachineReadsEveryThread
      ? "没有一台电脑能读取全部附加的会话。请在输入框中选择电脑，或移除这些会话。"
      : "没有符合条件且资源充足的电脑。请在输入框中手动选择电脑。",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "已拒绝审批。由于你的消息有改动，所以没有发送。"
      : "你的消息有改动，所以没有发送。";
  }
  if (input.approvalResponding) {
    return "正在回应另一个审批，所以你的消息没有发送。";
  }
  if (input.declined && input.approvalArrived) {
    return "又来了一个审批，所以你的消息没有发送。";
  }
  return null;
}

export function resetSentComposerPrompt(input: {
  readonly currentRouteThreadKey: string | null;
  readonly sentRouteThreadKey: string;
  readonly clearPrompt: () => void;
  readonly resetCursor: () => void;
}) {
  if (input.currentRouteThreadKey !== input.sentRouteThreadKey) return;
  input.clearPrompt();
  input.resetCursor();
}
