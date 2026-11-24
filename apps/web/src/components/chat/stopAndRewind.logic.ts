import type {
  CommandId,
  OrchestrationV2AppThread,
  OrchestrationV2PendingRollback,
  OrchestrationV2RollbackFailureCode,
  OrchestrationV2Run,
} from "@t3tools/contracts";

/** Where a click on "rewind to before this message" goes. Every entry point asks this one place. */
export type RewindRoute =
  | { readonly kind: "checkpoint" }
  | { readonly kind: "stop-and-rollback" }
  | { readonly kind: "blocked"; readonly message: string };

export function resolveRewindRoute(input: {
  /** A run is preparing, starting, running, or waiting for its checkpoint. */
  readonly runActive: boolean;
  /** This client has a send in flight. */
  readonly sendBusy: boolean;
  /** The server advertises `threadStopAndRollback`. */
  readonly supportsStopAndRollback: boolean;
  /** The thread already holds a rewind that is waiting for the run to stop. */
  readonly pendingRollback: boolean;
}): RewindRoute {
  if (input.pendingRollback) {
    return { kind: "blocked", message: "已经有一次回退在进行。请等它完成，或先取消。" };
  }
  if (input.sendBusy) {
    return { kind: "blocked", message: "消息正在发送，请稍后再回退。" };
  }
  if (!input.runActive) return { kind: "checkpoint" };
  if (input.supportsStopAndRollback) return { kind: "stop-and-rollback" };
  return { kind: "blocked", message: "正在运行，请先停止再回退。" };
}

/** Matches the server's `isActiveRun`: `waiting` still has a checkpoint capture in flight. */
export function hasActiveRun(runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>): boolean {
  return runs.some(
    (run) =>
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting",
  );
}

export type RollbackProgress =
  | { readonly step: "idle" }
  | { readonly step: "stopping"; readonly forceStop: boolean; readonly canCancel: true }
  | { readonly step: "rewinding"; readonly canCancel: boolean };

/**
 * Which step a rewind is on, read from the thread alone so a second client agrees with the first.
 * The server clears `pendingRollback` when it queues the rewind itself, so the last moments are
 * known only to the client that started it (`localRewinding`).
 */
export function deriveRollbackProgress(input: {
  readonly pendingRollback: OrchestrationV2PendingRollback | null | undefined;
  readonly rollbackFailure: OrchestrationV2AppThread["rollbackFailure"];
  readonly hasActiveRun: boolean;
  readonly localRewinding: boolean;
}): RollbackProgress {
  const pending = input.pendingRollback;
  if (pending != null) {
    const unanswered =
      input.rollbackFailure?.requestId === pending.requestId &&
      input.rollbackFailure.code === "interrupt-unresponsive";
    if (unanswered || input.hasActiveRun) {
      return { step: "stopping", forceStop: unanswered, canCancel: true };
    }
    return { step: "rewinding", canCancel: true };
  }
  if (input.localRewinding) return { step: "rewinding", canCancel: false };
  return { step: "idle" };
}

/** Why Send is off during a rewind, or null when it is not. */
export function rollbackSendBlockReason(progress: RollbackProgress): string | null {
  switch (progress.step) {
    case "idle":
      return null;
    case "stopping":
      return "正在停止，回退完成后才能发送";
    case "rewinding":
      return "正在回退，完成后才能发送";
  }
}

export type RewindOutcome =
  | { readonly kind: "waiting" }
  | { readonly kind: "completed" }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly code?: OrchestrationV2RollbackFailureCode;
    };

/** What the thread says about the rewind this client started under `requestId`. */
export function classifyRewindOutcome(
  thread: Pick<
    OrchestrationV2AppThread,
    "pendingRollback" | "rollbackFailure" | "rollbackCompletedRequestId"
  >,
  requestId: CommandId,
): RewindOutcome {
  if (thread.rollbackCompletedRequestId === requestId) return { kind: "completed" };
  const failure = thread.rollbackFailure;
  if (failure?.requestId !== requestId) return { kind: "waiting" };
  // An unanswered stop keeps the rewind held: force stop lets it finish, so it is not the end.
  if (
    failure.code === "interrupt-unresponsive" &&
    thread.pendingRollback?.requestId === requestId
  ) {
    return { kind: "waiting" };
  }
  return {
    kind: "failed",
    message: failure.message,
    ...(failure.code === undefined ? {} : { code: failure.code }),
  };
}
