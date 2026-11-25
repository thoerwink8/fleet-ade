import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import { create } from "zustand";
import type { ComposerSubmissionIntent } from "../../composer-logic";

export type PendingSendBlocker =
  | "preparing-images"
  | "loading-context"
  | "reconnecting"
  | "previous-send-busy"
  | "uploading-attachments";

export interface PendingSendBlockerInput {
  readonly preparingImages: boolean;
  readonly loadingContext: boolean;
  readonly reconnecting: boolean;
  readonly previousSendBusy: boolean;
  readonly waitingForAttachmentCapabilities?: boolean;
  /** Answers and approval redirects need their uploads first; they finish on their own. */
  readonly uploadingAttachments?: boolean;
}

export interface PendingSendFailureBaseline {
  readonly imageFailureSeq: number;
  readonly contextFailureSeq: number;
  readonly previousSendFailureSeq: number;
}

export interface PendingSendFailureSnapshot {
  readonly imageFailure: {
    readonly sequence: number;
    readonly fileName: string;
    readonly reason: "unreadable" | "too-large";
  } | null;
  readonly contextFailure: {
    readonly sequence: number;
    readonly reason: string;
  } | null;
  readonly previousSendFailure: {
    readonly sequence: number;
    readonly reason: string;
  } | null;
}

export interface PendingComposerSend {
  readonly id: number;
  readonly targetKey: string;
  readonly dispatchMode: ComposerDispatchMode;
  readonly submissionIntent: ComposerSubmissionIntent;
  readonly submissionTarget: "provider-turn" | "pending-user-input";
  readonly waitedForPreviousSend: boolean;
  readonly baseline: PendingSendFailureBaseline;
}

export type PendingSendEvaluation =
  | {
      readonly status: "waiting";
      readonly primaryBlocker: PendingSendBlocker;
      readonly message: string;
    }
  | { readonly status: "ready" }
  | {
      readonly status: "failed";
      readonly kind:
        | "preparing-images"
        | "loading-context"
        | "previous-send-busy"
        | "hard-blocked"
        | "target-changed";
      readonly title: string;
      readonly description: string;
      readonly canRetryDirect: boolean;
    };

export function collectPendingSendBlockers(
  input: PendingSendBlockerInput,
): ReadonlyArray<PendingSendBlocker> {
  const blockers: PendingSendBlocker[] = [];
  if (input.preparingImages) blockers.push("preparing-images");
  if (input.loadingContext) blockers.push("loading-context");
  if (input.reconnecting || input.waitingForAttachmentCapabilities === true) {
    blockers.push("reconnecting");
  }
  if (input.uploadingAttachments === true) blockers.push("uploading-attachments");
  if (input.previousSendBusy) blockers.push("previous-send-busy");
  return blockers;
}

export function pendingSendWaitingMessage(blocker: PendingSendBlocker): string {
  switch (blocker) {
    case "preparing-images":
      return "正在压缩图片，好了自动发送";
    case "loading-context":
      return "正在加载上下文，好了自动发送";
    case "reconnecting":
      return "正在重新连接，连上后自动发送";
    case "uploading-attachments":
      return "附件还在上传，传完自动发送";
    case "previous-send-busy":
      return "上一条还在发送，之后自动发送";
  }
}

export function evaluatePendingComposerSend(input: {
  readonly pending: PendingComposerSend;
  readonly blockers: ReadonlyArray<PendingSendBlocker>;
  readonly failures: PendingSendFailureSnapshot;
  readonly hardBlockedReason: string | null;
  /** What a send would address right now: a question can arrive, or be closed, while waiting. */
  readonly currentSubmissionTarget: PendingComposerSend["submissionTarget"];
  /** Loading a queued message for editing replaces the draft, so the armed send no longer matches it. */
  readonly editingQueuedMessage: boolean;
}): PendingSendEvaluation {
  const { pending, blockers, failures, hardBlockedReason } = input;
  if (pending.submissionTarget !== input.currentSubmissionTarget || input.editingQueuedMessage) {
    return {
      status: "failed",
      kind: "target-changed",
      title: "等待发送已取消",
      description:
        "会话状态变了（出现或结束了提问，或正在编辑排队消息），消息没有发出，内容还在输入框里。",
      canRetryDirect: false,
    };
  }
  if (failures.imageFailure && failures.imageFailure.sequence > pending.baseline.imageFailureSeq) {
    return {
      status: "failed",
      kind: "preparing-images",
      title: "图片没压缩成功，消息没有发出",
      description:
        failures.imageFailure.reason === "too-large"
          ? `“${failures.imageFailure.fileName}”即使压缩后也过大，内容还在输入框里。请移除这张图片，或直接发送其余内容。`
          : `无法读取“${failures.imageFailure.fileName}”，内容还在输入框里。请移除这张图片，或直接发送其余内容。`,
      canRetryDirect: true,
    };
  }
  if (
    failures.contextFailure &&
    failures.contextFailure.sequence > pending.baseline.contextFailureSeq
  ) {
    return {
      status: "failed",
      kind: "loading-context",
      title: "上下文加载失败，消息没有发出",
      description: `${failures.contextFailure.reason} 内容还在输入框里，请移除对应标签或重试。`,
      canRetryDirect: true,
    };
  }
  if (
    pending.waitedForPreviousSend &&
    failures.previousSendFailure &&
    failures.previousSendFailure.sequence > pending.baseline.previousSendFailureSeq
  ) {
    return {
      status: "failed",
      kind: "previous-send-busy",
      title: "上一条消息没能发出，当前消息也没有发出",
      description: `${failures.previousSendFailure.reason} 内容还在输入框里，可以直接重试。`,
      canRetryDirect: true,
    };
  }
  const primaryBlocker = blockers[0];
  if (primaryBlocker !== undefined) {
    return {
      status: "waiting",
      primaryBlocker,
      message: pendingSendWaitingMessage(primaryBlocker),
    };
  }
  if (hardBlockedReason !== null) {
    return {
      status: "failed",
      kind: "hard-blocked",
      title: "消息未能自动发送",
      description: `${hardBlockedReason} 内容还在输入框里。`,
      canRetryDirect: false,
    };
  }
  return { status: "ready" };
}

export function resolvePendingSendDispatchMode(input: {
  readonly requestedMode: ComposerDispatchMode;
  readonly isRunning: boolean;
  readonly followUpBehavior: "queue" | "steer";
  readonly canSteer: boolean;
}): ComposerDispatchMode {
  if (!input.isRunning) return "auto";
  if (input.requestedMode === "queue") return "queue";
  if (input.requestedMode === "steer") {
    return input.canSteer ? "steer" : "queue";
  }
  if (!input.canSteer) return "queue";
  return input.followUpBehavior;
}

let nextPendingSendId = 0;

/** Said when an edit or another action of the user drops an armed send, so nobody waits for a send that is gone. */
export const PENDING_SEND_EDITED_NOTICE = "你改了内容，自动发送已取消，内容还在输入框里。";
/** Said when a stash or restore takes the draft away from an armed send. */
export const PENDING_SEND_STASH_NOTICE = "自动发送已取消。";
/** Said on return, because leaving a conversation drops its armed send. */
export const PENDING_SEND_LEFT_NOTICE = "你离开过这个会话，自动发送已取消，内容还在输入框里。";

const usePendingComposerSendStore = create<{
  readonly byTargetKey: Readonly<Record<string, PendingComposerSend>>;
  readonly cancelNoticeByTargetKey: Readonly<Record<string, string>>;
}>(() => ({ byTargetKey: {}, cancelNoticeByTargetKey: {} }));

export function usePendingSendCancelNotice(targetKey: string): string | null {
  return usePendingComposerSendStore((state) => state.cancelNoticeByTargetKey[targetKey] ?? null);
}

export function getPendingSendCancelNotice(targetKey: string): string | null {
  return usePendingComposerSendStore.getState().cancelNoticeByTargetKey[targetKey] ?? null;
}

export function dismissPendingSendCancelNotice(targetKey: string): void {
  usePendingComposerSendStore.setState((state) => {
    if (!(targetKey in state.cancelNoticeByTargetKey)) return state;
    const cancelNoticeByTargetKey = { ...state.cancelNoticeByTargetKey };
    delete cancelNoticeByTargetKey[targetKey];
    return { cancelNoticeByTargetKey };
  });
}

export function usePendingComposerSend(targetKey: string): PendingComposerSend | null {
  return usePendingComposerSendStore((state) => state.byTargetKey[targetKey] ?? null);
}

export function getPendingComposerSend(targetKey: string): PendingComposerSend | null {
  return usePendingComposerSendStore.getState().byTargetKey[targetKey] ?? null;
}

export function armPendingComposerSend(
  input: Omit<PendingComposerSend, "id">,
): PendingComposerSend {
  const existing = getPendingComposerSend(input.targetKey);
  if (existing !== null) return existing;
  const created: PendingComposerSend = {
    ...input,
    id: ++nextPendingSendId,
  };
  dismissPendingSendCancelNotice(input.targetKey);
  usePendingComposerSendStore.setState((state) => ({
    byTargetKey: {
      ...state.byTargetKey,
      [input.targetKey]: created,
    },
  }));
  return created;
}

/**
 * Removes the armed send. Pass `notice` when the user did not ask for the cancel (an edit, leaving
 * the conversation), so the composer can say the send will not happen. Without `notice` (the
 * user's own Cancel or Escape, or a direct send) any older notice is cleared too.
 */
export function cancelPendingComposerSend(targetKey: string, notice?: string): boolean {
  const current = getPendingComposerSend(targetKey);
  if (current === null) {
    if (notice === undefined) dismissPendingSendCancelNotice(targetKey);
    return false;
  }
  usePendingComposerSendStore.setState((state) => {
    const byTargetKey = { ...state.byTargetKey };
    delete byTargetKey[targetKey];
    const cancelNoticeByTargetKey = { ...state.cancelNoticeByTargetKey };
    if (notice === undefined) delete cancelNoticeByTargetKey[targetKey];
    else cancelNoticeByTargetKey[targetKey] = notice;
    return { byTargetKey, cancelNoticeByTargetKey };
  });
  return true;
}

/** Atomically removes and returns the pending send only if its id matches `expectedId`. */
export function claimPendingComposerSend(
  targetKey: string,
  expectedId: number,
): PendingComposerSend | null {
  let claimed: PendingComposerSend | null = null;
  usePendingComposerSendStore.setState((state) => {
    const current = state.byTargetKey[targetKey];
    if (!current || current.id !== expectedId) return state;
    claimed = current;
    const byTargetKey = { ...state.byTargetKey };
    delete byTargetKey[targetKey];
    return { byTargetKey };
  });
  return claimed;
}
