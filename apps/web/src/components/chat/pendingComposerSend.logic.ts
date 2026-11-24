import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import { create } from "zustand";
import type { ComposerSubmissionIntent } from "../../composer-logic";

export type PendingSendBlocker =
  | "preparing-images"
  | "loading-context"
  | "reconnecting"
  | "previous-send-busy";

export interface PendingSendBlockerInput {
  readonly preparingImages: boolean;
  readonly loadingContext: boolean;
  readonly reconnecting: boolean;
  readonly previousSendBusy: boolean;
  readonly waitingForAttachmentCapabilities?: boolean;
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
      readonly kind: "preparing-images" | "loading-context" | "previous-send-busy" | "hard-blocked";
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
    case "previous-send-busy":
      return "上一条还在发送，之后自动发送";
  }
}

export function evaluatePendingComposerSend(input: {
  readonly pending: PendingComposerSend;
  readonly blockers: ReadonlyArray<PendingSendBlocker>;
  readonly failures: PendingSendFailureSnapshot;
  readonly hardBlockedReason: string | null;
}): PendingSendEvaluation {
  const { pending, blockers, failures, hardBlockedReason } = input;
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

const usePendingComposerSendStore = create<{
  readonly byTargetKey: Readonly<Record<string, PendingComposerSend>>;
}>(() => ({ byTargetKey: {} }));

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
  usePendingComposerSendStore.setState((state) => ({
    byTargetKey: {
      ...state.byTargetKey,
      [input.targetKey]: created,
    },
  }));
  return created;
}

export function cancelPendingComposerSend(targetKey: string): boolean {
  const current = getPendingComposerSend(targetKey);
  if (current === null) return false;
  usePendingComposerSendStore.setState((state) => {
    if (!(targetKey in state.byTargetKey)) return state;
    const byTargetKey = { ...state.byTargetKey };
    delete byTargetKey[targetKey];
    return { byTargetKey };
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
