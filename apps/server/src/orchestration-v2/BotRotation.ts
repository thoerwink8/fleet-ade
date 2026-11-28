import type {
  OrchestrationV2AppThread,
  OrchestrationV2ContextTransfer,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ServerCommand,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentStatus,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { isActiveRun } from "./CommandPolicy.ts";
import { isUndeliveredMailboxSteer } from "./NotificationMailbox.ts";

const TERMINAL_SUBAGENT_STATUS: Record<OrchestrationV2SubagentStatus, boolean> = {
  completed: true,
  failed: true,
  cancelled: true,
  interrupted: true,
  idle: false,
  pending: false,
  running: false,
  waiting: false,
};

export interface RotationQuietInput {
  readonly thread: OrchestrationV2AppThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly contextTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly providerSessions: ReadonlyArray<OrchestrationV2ProviderSession>;
  readonly unsettledEffectCount: number;
}

/**
 * Why an old thread cannot be sealed, or null when nothing in flight would write back to it.
 * Queued messages, including held ones, are not quiet: slice 4a does not move them.
 */
export function rotationBlockedReason(input: RotationQuietInput): string | null {
  const { thread } = input;
  if (thread.deletedAt !== null) return "is deleted";
  if (input.runs.some((run) => run.status === "queued")) return "has queued messages";
  if (input.runs.some(isActiveRun)) return "has a live run";
  if (input.runtimeRequests.some((request) => request.status === "pending")) {
    return "has a pending runtime request";
  }
  if (thread.pendingRollback != null || thread.rollbackInProgressRequestId != null) {
    return "has a rewind in progress";
  }
  // An unconsumed merge-back is written only by a message on this thread, which rotation
  // would seal read-only, so it blocks. An unconsumed fork is carried onto the new thread.
  if (
    input.contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    )
  ) {
    return "has unconsumed merge-back context";
  }
  const latestRun = input.runs.reduce<OrchestrationV2Run | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  if (
    derivePendingBackgroundWork({
      latestRun,
      runs: input.runs,
      providerThreads: input.providerThreads,
      turnItems: input.turnItems,
      activeProviderThreadId: thread.activeProviderThreadId,
    }).length > 0
  ) {
    return "has background work";
  }
  if (
    input.subagents.some(
      (subagent) =>
        !TERMINAL_SUBAGENT_STATUS[subagent.status] ||
        subagent.completionDelivery?.state === "pending" ||
        subagent.completionDelivery?.state === "claimed",
    )
  ) {
    return "has an open delegation";
  }
  if (
    input.messages.some((message) =>
      isUndeliveredMailboxSteer(
        {
          messages: input.messages,
          runs: input.runs,
          providerTurns: input.providerTurns,
        },
        message.id,
      ),
    )
  ) {
    return "has an undelivered mailbox delivery";
  }
  if (
    input.providerSessions.some(
      (session) =>
        session.status === "starting" ||
        session.status === "running" ||
        session.status === "waiting",
    )
  ) {
    return "has a live provider session";
  }
  if (input.unsettledEffectCount > 0) return "has unfinished effects";
  return null;
}

/** Continuations and steering name a run on the thread the bot left. */
export function messageBindsOldRun(
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
): boolean {
  return (
    command.dispatchMode.type === "steer_active" ||
    command.dispatchMode.type === "restart_active" ||
    command.restartContinuationOfRunId !== undefined ||
    command.usageLimitContinuationOfRunId !== undefined ||
    command.manualContinuationOfRunId !== undefined ||
    command.steerFollowUpOfRunId !== undefined ||
    command.delegatedCompletion !== undefined
  );
}
