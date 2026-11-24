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

/** The one thing a person can do about a failed rewind. */
export type RollbackFailureAction = "retry" | "force-stop" | "cancel" | "dismiss";

export interface RollbackFailurePresentation {
  readonly message: string;
  readonly action: RollbackFailureAction;
}

/**
 * Every failure code the server can send, with what happened and what to do next. The record is
 * exhaustive on purpose: a code added to the contract fails to compile until it has a sentence.
 */
const ROLLBACK_FAILURE_PRESENTATIONS: Readonly<
  Record<OrchestrationV2RollbackFailureCode, RollbackFailurePresentation>
> = {
  "shared-workspace": {
    message:
      "无法还原文件：这个目录现在和别的会话或侧聊共用。请重新点回退，选择「只回退会话」保留当前文件改动。",
    action: "retry",
  },
  "checkpoint-unavailable": {
    message:
      "无法还原文件：这一轮的文件快照不可用。请重新点回退，选择「只回退会话」保留当前文件改动。",
    action: "retry",
  },
  "git-index-locked": {
    message: "无法还原文件：Git 正在执行其他操作。请稍等片刻后重试，或选择只回退会话。",
    action: "retry",
  },
  "rollback-failed": {
    message: "无法回退会话。请重试；如果多次失败，请查看后台服务日志。",
    action: "retry",
  },
  "target-invalid": {
    message: "这条消息已经不能回退，可能是会话刚发生了变化。智能体已停止，请重新选择要回退的消息。",
    action: "dismiss",
  },
  "checkpoint-missing": {
    message: "这一轮的文件快照没有存下来，无法还原文件。请重新点回退，选择「只回退会话」。",
    action: "retry",
  },
  "provider-cannot-rollback": {
    message: "这个智能体不支持回退会话记录。请改为新建会话。",
    action: "dismiss",
  },
  "provider-cannot-interrupt": {
    message: "这个智能体在运行中无法被停止，所以不能直接回退。请等它运行结束后再回退。",
    action: "dismiss",
  },
  "provider-turn-unavailable": {
    message: "智能体找不到这条消息对应的那一轮，无法回退到这里。请选择更早的消息，或新建会话。",
    action: "dismiss",
  },
  "provider-turn-active": {
    message: "智能体还没完全结束这一轮，暂时不能回退。请稍等几秒后重试。",
    action: "retry",
  },
  "interrupt-unresponsive": {
    message: "智能体没有响应停止。点「强制停止」结束它，回退会接着完成；也可以取消这次回退。",
    action: "force-stop",
  },
  "pending-rollback": {
    message: "上一次回退还在等智能体停止。请等它完成，或先取消再操作。",
    action: "cancel",
  },
  "rollback-already-pending": {
    message: "已经有一次回退在等智能体停止。请等它完成，或先取消再回退。",
    action: "cancel",
  },
};

const FALLBACK_FAILURE = ROLLBACK_FAILURE_PRESENTATIONS["rollback-failed"];

export function rollbackFailurePresentation(
  code: OrchestrationV2RollbackFailureCode,
): RollbackFailurePresentation {
  return ROLLBACK_FAILURE_PRESENTATIONS[code];
}

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
  /** The agent is running, so it is stopped first. The prompt may not come back if this tab closes. */
  readonly whileRunning?: boolean;
}): RevertConfirmPresentation {
  const baseDescription = input.whileRunning
    ? "智能体正在运行，会先停止这一轮，再回退到这条消息之前。"
    : input.removedTurnCount > 0
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
    return error.code === undefined
      ? error.rawMessage.trim() || FALLBACK_FAILURE.message
      : ROLLBACK_FAILURE_PRESENTATIONS[error.code].message;
  }
  if (
    isDispatchCommandError(error) ||
    (Predicate.isObject(error) && error._tag === "OrchestrationV2DispatchCommandError")
  ) {
    if ("code" in error && isRollbackFailureCode(error.code)) {
      return ROLLBACK_FAILURE_PRESENTATIONS[error.code].message;
    }
    if ("detail" in error && typeof error.detail === "string" && error.detail.trim().length > 0) {
      return error.detail.trim();
    }
    return FALLBACK_FAILURE.message;
  }
  if (
    isCheckpointUnavailableError(error) ||
    (Predicate.isObject(error) && error._tag === "OrchestrationV2CheckpointUnavailableError")
  ) {
    return ROLLBACK_FAILURE_PRESENTATIONS["checkpoint-unavailable"].message;
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
  /** The server stops a running thread itself, so the button needs no prior Stop. */
  readonly canRewindWhileWorking?: boolean;
}): string {
  if (input.isWorking && input.canRewindWhileWorking !== true) return "正在运行，先停止再回退";
  if (input.isRevertingCheckpoint) return "正在回退…";
  return "回退到这条消息之前";
}
