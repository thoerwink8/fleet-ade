import {
  CommandId,
  OrchestrationV2CheckpointUnavailableError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2RollbackFailureCode,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  RewindFailureError,
  countRollbackTurns,
  describeRevertConfirm,
  formatRollbackFailureMessage,
  revertButtonLabel,
  rollbackFailurePresentation,
} from "./revertConfirm.logic";

describe("describeRevertConfirm", () => {
  it("shows both restore and conversation actions when restore is ready", () => {
    const view = describeRevertConfirm({
      availability: { status: "ready" },
      removedTurnCount: 3,
    });

    expect(view).toEqual({
      title: "回退到这条消息之前？",
      description:
        "将删除从这条消息起的 3 轮会话记录，并把这条消息的提示词和附件放回输入框。选择「同时还原文件」会把这些轮次里的文件改动一并撤销。",
      restoreUnavailableReason: null,
      cancelActionLabel: "取消",
      showRestoreFilesAction: true,
      restoreFilesActionLabel: "同时还原文件",
      primaryActionLabel: "回退并保留文件改动",
    });
  });

  it("hides restore action and allows conversation-only rewind when checkpoint is missing", () => {
    const view = describeRevertConfirm({
      availability: { status: "blocked", reason: "checkpoint-missing" },
      removedTurnCount: 2,
    });

    expect(view.showRestoreFilesAction).toBe(false);
    expect(view.restoreFilesActionLabel).toBeNull();
    expect(view.primaryActionLabel).toBe("只回退会话");
    expect(view.description).toContain("2 轮会话记录");
    expect(view.restoreUnavailableReason).toBe("这一轮的文件快照没有存下来，所以不会还原文件。");
  });

  it("explains shared workspace when thread runs in the project directory", () => {
    const view = describeRevertConfirm({
      availability: {
        status: "blocked",
        reason: "shared-workspace",
        inProjectDirectory: true,
      },
      removedTurnCount: 1,
    });

    expect(view.showRestoreFilesAction).toBe(false);
    expect(view.primaryActionLabel).toBe("只回退会话");
    expect(view.description).toContain("1 轮会话记录");
    expect(view.restoreUnavailableReason).toBe(
      "这个会话直接在项目目录里工作，文件和别的会话共用，所以不会还原文件。",
    );
  });

  it("explains shared worktree when another thread or side chat overlaps", () => {
    const view = describeRevertConfirm({
      availability: {
        status: "blocked",
        reason: "shared-workspace",
        inProjectDirectory: false,
      },
      removedTurnCount: 1,
    });

    expect(view.showRestoreFilesAction).toBe(false);
    expect(view.restoreUnavailableReason).toBe(
      "这个工作树正和别的会话或侧聊共用，所以不会还原文件。",
    );
  });

  it("falls back to conversation-only rewind when availability check is unavailable", () => {
    const view = describeRevertConfirm({
      availability: { status: "unavailable" },
      removedTurnCount: 2,
    });

    expect(view.showRestoreFilesAction).toBe(false);
    expect(view.restoreFilesActionLabel).toBeNull();
    expect(view.primaryActionLabel).toBe("只回退会话");
    expect(view.description).toContain("2 轮会话记录");
    expect(view.restoreUnavailableReason).toBe(
      "暂时确认不了能不能还原文件，这次只会回退会话记录。",
    );
  });
});

describe("describeRevertConfirm while running", () => {
  it("says the agent is stopped first and does not promise the prompt comes back", () => {
    for (const availability of [
      { status: "ready" },
      { status: "blocked", reason: "checkpoint-missing" },
      { status: "unavailable" },
    ] as const) {
      const view = describeRevertConfirm({ availability, removedTurnCount: 2, whileRunning: true });
      expect(view.description).toContain("先停止");
      expect(view.description).not.toContain("输入框");
    }
  });
});

describe("countRollbackTurns", () => {
  it("counts only settled runs strictly after the target turn ordinal", () => {
    const runs = [
      { id: RunId.make("r1"), ordinal: 1, status: "completed" as const },
      { id: RunId.make("r2"), ordinal: 2, status: "rolled_back" as const },
      { id: RunId.make("r3"), ordinal: 3, status: "interrupted" as const },
      { id: RunId.make("r4"), ordinal: 4, status: "failed" as const },
      { id: RunId.make("r5"), ordinal: 5, status: "cancelled" as const },
      { id: RunId.make("r6"), ordinal: 6, status: "running" as const },
    ];

    expect(countRollbackTurns(runs, 1)).toBe(3);
    expect(countRollbackTurns(runs, 0)).toBe(4);
  });
});

describe("formatRollbackFailureMessage", () => {
  it("maps structured failure codes to Chinese next-step guidance without matching English copy", () => {
    const sharedDispatch = new OrchestrationV2DispatchCommandError({
      commandId: CommandId.make("cmd-1"),
      commandType: "checkpoint.rollback",
      message: "File restore requires an isolated worktree.",
      detail: "File restore requires an isolated worktree.",
      code: "shared-workspace",
    });
    expect(formatRollbackFailureMessage(sharedDispatch)).toContain("无法还原文件");
    expect(formatRollbackFailureMessage(sharedDispatch)).toContain("只回退会话");
    expect(formatRollbackFailureMessage(sharedDispatch)).not.toContain("isolated worktree");

    // Same English text with another code must follow the code, not the English string.
    const runtimeSharedFailure = new RewindFailureError({
      rawMessage: "File restore requires an isolated worktree.",
      code: "rollback-failed",
    });
    expect(formatRollbackFailureMessage(runtimeSharedFailure)).toBe(
      "无法回退会话。请重试；如果多次失败，请查看后台服务日志。",
    );

    const locked = new RewindFailureError({
      rawMessage: "Git's index is locked.",
      code: "git-index-locked",
    });
    expect(formatRollbackFailureMessage(locked)).toContain("Git 正在执行其他操作");

    const missingCheckpoint = new OrchestrationV2CheckpointUnavailableError({
      threadId: ThreadId.make("thread-1"),
      target: "run ordinal 1",
    });
    expect(formatRollbackFailureMessage(missingCheckpoint)).toContain("文件快照不可用");
    expect(formatRollbackFailureMessage(new Error("请等附件准备完成后再回退。"))).toBe(
      "请等附件准备完成后再回退。",
    );
  });
});

describe("revertButtonLabel", () => {
  it("reports why revert is disabled while the thread is working", () => {
    expect(revertButtonLabel({ isWorking: true, isRevertingCheckpoint: false })).toBe(
      "正在运行，先停止再回退",
    );
    expect(revertButtonLabel({ isWorking: false, isRevertingCheckpoint: true })).toBe("正在回退…");
    expect(revertButtonLabel({ isWorking: false, isRevertingCheckpoint: false })).toBe(
      "回退到这条消息之前",
    );
  });
});

describe("rollbackFailurePresentation", () => {
  it.each(OrchestrationV2RollbackFailureCode.literals)(
    "gives %s a Chinese sentence without the code name and one next step",
    (code) => {
      const view = rollbackFailurePresentation(code);
      expect(view.message).toMatch(/[一-鿿]/u);
      expect(view.message).not.toContain(code);
      expect(view.message).not.toMatch(/[A-Za-z]{4,}/u);
      expect(["retry", "force-stop", "cancel", "dismiss"]).toContain(view.action);
    },
  );

  it("sends an unanswered stop to force stop and a busy turn to retry", () => {
    expect(rollbackFailurePresentation("interrupt-unresponsive").action).toBe("force-stop");
    expect(rollbackFailurePresentation("provider-turn-active").action).toBe("retry");
  });

  it("uses the mapped text for a stored failure instead of the server English", () => {
    const failure = new RewindFailureError({
      rawMessage: "Rollback target is invalid.",
      code: "target-invalid",
    });
    expect(formatRollbackFailureMessage(failure)).toBe(
      rollbackFailurePresentation("target-invalid").message,
    );
  });
});
