import {
  OrchestrationV2CheckpointUnavailableError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2RollbackFailureCode,
  type OrchestrationV2CheckpointRestoreBlockedReason,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export type RevertRestoreAvailability =
  | { readonly status: "ready" }
  | {
      readonly status: "blocked";
      readonly reason: OrchestrationV2CheckpointRestoreBlockedReason;
      readonly inProjectDirectory?: boolean | undefined;
    }
  | { readonly status: "unavailable" };

export interface RevertConfirmPresentation {
  readonly title: string;
  readonly description: string;
  readonly restoreUnavailableReason: string | null;
  readonly cancelActionLabel: string;
  readonly showRestoreFilesAction: boolean;
  readonly restoreFilesActionLabel: string | null;
  readonly primaryActionLabel: string;
}

export class RewindFailureError extends Schema.TaggedError<RewindFailureError>()(
  "RewindFailureError",
  {
    rawMessage: Schema.String,
    code: Schema.optional(OrchestrationV2RollbackFailureCode),
  },
) {
  override get message(): string {
    return this.rawMessage;
  }
}

const isRollbackFailureCode = Schema.is(OrchestrationV2RollbackFailureCode);
const isRewindFailureError = Schema.is(RewindFailureError);
const isDispatchCommandError = Schema.is(OrchestrationV2DispatchCommandError);
const isCheckpointUnavailableError = Schema.is(OrchestrationV2CheckpointUnavailableError);

/** Codes without an entry here (stop-and-rewind) fall back to the server detail. */
const ROLLBACK_FAILURE_MESSAGES: Readonly<
  Partial<Record<OrchestrationV2RollbackFailureCode, string>>
> & {
  readonly "checkpoint-unavailable": string;
  readonly "rollback-failed": string;
} = {
  "shared-workspace":
    "无法还原文件：这个目录现在和别的会话或侧聊共用。请重新点回退，选择「只回退会话」保留当前文件改动。",
  "checkpoint-unavailable":
    "无法还原文件：这一轮的文件快照不可用。请重新点回退，选择「只回退会话」保留当前文件改动。",
  "git-index-locked": "无法还原文件：Git 正在执行其他操作。请稍等片刻后重试，或选择只回退会话。",
  "rollback-failed": "无法回退会话。请重试；如果多次失败，请查看后台服务日志。",
};

/** Count settled runs that a rollback to `turnCount` removes, matching ProjectionStore. */
export function countRollbackTurns(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status">>,
  turnCount: number,
): number {
  return runs.filter(
    (run) =>
      run.ordinal > turnCount &&
      (run.status === "completed" ||
        run.status === "interrupted" ||
        run.status === "failed" ||
        run.status === "cancelled"),
  ).length;
}

export function describeRevertConfirm(input: {
  readonly availability: RevertRestoreAvailability;
  readonly removedTurnCount: number;
}): RevertConfirmPresentation {
  const baseDescription =
    input.removedTurnCount > 0
      ? `将删除从这条消息起的 ${input.removedTurnCount} 轮会话记录，并把这条消息的提示词和附件放回输入框。`
      : "会话将回退到这条消息之前，这条消息的提示词和附件会回到输入框。";

  switch (input.availability.status) {
    case "ready":
      return {
        title: "回退到这条消息之前？",
        description: `${baseDescription}选择「同时还原文件」会把这些轮次里的文件改动一并撤销。`,
        restoreUnavailableReason: null,
        cancelActionLabel: "取消",
        showRestoreFilesAction: true,
        restoreFilesActionLabel: "同时还原文件",
        primaryActionLabel: "回退并保留文件改动",
      };
    case "blocked":
      return {
        title: "回退到这条消息之前？",
        description: baseDescription,
        restoreUnavailableReason:
          input.availability.reason === "checkpoint-missing"
            ? "这一轮的文件快照没有存下来，所以不会还原文件。"
            : input.availability.inProjectDirectory === true
              ? "这个会话直接在项目目录里工作，文件和别的会话共用，所以不会还原文件。"
              : "这个工作树正和别的会话或侧聊共用，所以不会还原文件。",
        cancelActionLabel: "取消",
        showRestoreFilesAction: false,
        restoreFilesActionLabel: null,
        primaryActionLabel: "只回退会话",
      };
    case "unavailable":
      return {
        title: "回退到这条消息之前？",
        description: baseDescription,
        restoreUnavailableReason: "暂时确认不了能不能还原文件，这次只会回退会话记录。",
        cancelActionLabel: "取消",
        showRestoreFilesAction: false,
        restoreFilesActionLabel: null,
        primaryActionLabel: "只回退会话",
      };
  }
}

export function formatRollbackFailureMessage(error: unknown): string {
  if (isRewindFailureError(error)) {
    return (
      ROLLBACK_FAILURE_MESSAGES[error.code ?? "rollback-failed"] ??
      (error.rawMessage.trim() || ROLLBACK_FAILURE_MESSAGES["rollback-failed"])
    );
  }
  if (
    isDispatchCommandError(error) ||
    (Predicate.isObject(error) && error._tag === "OrchestrationV2DispatchCommandError")
  ) {
    if ("code" in error && isRollbackFailureCode(error.code)) {
      const known = ROLLBACK_FAILURE_MESSAGES[error.code];
      if (known !== undefined) return known;
    }
    if ("detail" in error && typeof error.detail === "string" && error.detail.trim().length > 0) {
      return error.detail.trim();
    }
    return ROLLBACK_FAILURE_MESSAGES["rollback-failed"];
  }
  if (
    isCheckpointUnavailableError(error) ||
    (Predicate.isObject(error) && error._tag === "OrchestrationV2CheckpointUnavailableError")
  ) {
    return ROLLBACK_FAILURE_MESSAGES["checkpoint-unavailable"];
  }
  if (Predicate.isObject(error) && error._tag === "EnvironmentAuthorizationError") {
    return "没有操作此电脑会话的权限。";
  }
  if (Predicate.isObject(error) && error._tag === "EnvironmentRpcUnavailableError") {
    return "此电脑暂时未连接。请重新连接后再回退。";
  }
  return error instanceof Error ? error.message : "无法回退会话。";
}

export function revertButtonLabel(input: {
  readonly isWorking: boolean;
  readonly isRevertingCheckpoint: boolean;
}): string {
  if (input.isWorking) return "正在运行，先停止再回退";
  if (input.isRevertingCheckpoint) return "正在回退…";
  return "回退到这条消息之前";
}
