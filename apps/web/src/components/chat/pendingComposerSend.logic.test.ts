import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  armPendingComposerSend,
  cancelPendingComposerSend,
  claimPendingComposerSend,
  dismissPendingSendCancelNotice,
  getPendingSendCancelNotice,
  PENDING_SEND_EDITED_NOTICE,
  PENDING_SEND_LEFT_NOTICE,
  collectPendingSendBlockers,
  evaluatePendingComposerSend,
  getPendingComposerSend,
  pendingSendWaitingMessage,
  resolvePendingSendDispatchMode,
} from "./pendingComposerSend.logic";

const TARGET_A = "env-1:thread-a";
const TARGET_B = "env-1:thread-b";

const noFailures = {
  imageFailure: null,
  contextFailure: null,
  previousSendFailure: null,
};

const zeroBaseline = {
  imageFailureSeq: 0,
  contextFailureSeq: 0,
  previousSendFailureSeq: 0,
};

afterEach(() => {
  cancelPendingComposerSend(TARGET_A);
  cancelPendingComposerSend(TARGET_B);
  dismissPendingSendCancelNotice(TARGET_A);
  dismissPendingSendCancelNotice(TARGET_B);
});

describe("collectPendingSendBlockers", () => {
  it("detects each of the four transient blockers with its waiting copy", () => {
    const cases = [
      {
        input: {
          preparingImages: true,
          loadingContext: false,
          reconnecting: false,
          previousSendBusy: false,
        },
        blocker: "preparing-images",
        message: "正在压缩图片，好了自动发送",
      },
      {
        input: {
          preparingImages: false,
          loadingContext: true,
          reconnecting: false,
          previousSendBusy: false,
        },
        blocker: "loading-context",
        message: "正在加载上下文，好了自动发送",
      },
      {
        input: {
          preparingImages: false,
          loadingContext: false,
          reconnecting: true,
          previousSendBusy: false,
        },
        blocker: "reconnecting",
        message: "正在重新连接，连上后自动发送",
      },
      {
        input: {
          preparingImages: false,
          loadingContext: false,
          reconnecting: false,
          previousSendBusy: true,
        },
        blocker: "previous-send-busy",
        message: "上一条还在发送，之后自动发送",
      },
    ] as const;

    for (const testCase of cases) {
      const blockers = collectPendingSendBlockers(testCase.input);
      expect(blockers).toEqual([testCase.blocker]);
      expect(pendingSendWaitingMessage(blockers[0]!)).toBe(testCase.message);
    }
  });

  it("treats pending attachment capabilities during reconnect as a single reconnecting blocker", () => {
    expect(
      collectPendingSendBlockers({
        preparingImages: false,
        loadingContext: false,
        reconnecting: true,
        previousSendBusy: false,
        waitingForAttachmentCapabilities: true,
      }),
    ).toEqual(["reconnecting"]);
  });
});

describe("pendingComposerSend state machine", () => {
  it("waits when two blockers are active, updates as one clears, and fires exactly once when all clear", () => {
    const pending = armPendingComposerSend({
      targetKey: TARGET_A,
      dispatchMode: "auto",
      submissionIntent: "foreground",
      submissionTarget: "provider-turn",
      waitedForPreviousSend: false,
      baseline: zeroBaseline,
    });

    const bothActive = collectPendingSendBlockers({
      preparingImages: true,
      loadingContext: false,
      reconnecting: true,
      previousSendBusy: false,
    });
    expect(
      evaluatePendingComposerSend({
        pending,
        blockers: bothActive,
        failures: noFailures,
        hardBlockedReason: null,
        currentSubmissionTarget: "provider-turn",
        editingQueuedMessage: false,
      }),
    ).toEqual({
      status: "waiting",
      primaryBlocker: "preparing-images",
      message: "正在压缩图片，好了自动发送",
    });

    // Image compression finishes first while still reconnecting: must stay waiting, NOT send.
    const onlyReconnecting = collectPendingSendBlockers({
      preparingImages: false,
      loadingContext: false,
      reconnecting: true,
      previousSendBusy: false,
    });
    expect(
      evaluatePendingComposerSend({
        pending,
        blockers: onlyReconnecting,
        failures: noFailures,
        hardBlockedReason: null,
        currentSubmissionTarget: "provider-turn",
        editingQueuedMessage: false,
      }),
    ).toEqual({
      status: "waiting",
      primaryBlocker: "reconnecting",
      message: "正在重新连接，连上后自动发送",
    });
    expect(getPendingComposerSend(TARGET_A)).toEqual(pending);

    // Reconnection finishes: now ready, and atomic claim allows exactly one dispatch.
    expect(
      evaluatePendingComposerSend({
        pending,
        blockers: [],
        failures: noFailures,
        hardBlockedReason: null,
        currentSubmissionTarget: "provider-turn",
        editingQueuedMessage: false,
      }),
    ).toEqual({ status: "ready" });

    expect(claimPendingComposerSend(TARGET_A, pending.id)).toEqual(pending);
    expect(claimPendingComposerSend(TARGET_A, pending.id)).toBeNull();
    expect(getPendingComposerSend(TARGET_A)).toBeNull();
  });

  it("never double-arms or double-claims under concurrent resolution or remounts", () => {
    const first = armPendingComposerSend({
      targetKey: TARGET_A,
      dispatchMode: "queue",
      submissionIntent: "foreground",
      submissionTarget: "provider-turn",
      waitedForPreviousSend: false,
      baseline: zeroBaseline,
    });
    const second = armPendingComposerSend({
      targetKey: TARGET_A,
      dispatchMode: "steer",
      submissionIntent: "alternate",
      submissionTarget: "provider-turn",
      waitedForPreviousSend: false,
      baseline: zeroBaseline,
    });
    expect(second).toEqual(first);

    expect(claimPendingComposerSend(TARGET_A, first.id + 1)).toBeNull();
    expect(claimPendingComposerSend(TARGET_A, first.id)).toEqual(first);
    expect(claimPendingComposerSend(TARGET_A, first.id)).toBeNull();
  });

  it("does not fire after cancellation or user editing", () => {
    armPendingComposerSend({
      targetKey: TARGET_A,
      dispatchMode: "auto",
      submissionIntent: "foreground",
      submissionTarget: "provider-turn",
      waitedForPreviousSend: false,
      baseline: zeroBaseline,
    });

    expect(cancelPendingComposerSend(TARGET_A)).toBe(true);
    expect(getPendingComposerSend(TARGET_A)).toBeNull();
    expect(cancelPendingComposerSend(TARGET_A)).toBe(false);
  });

  it("isolates pending sends per thread without cross-thread leakage or merging", () => {
    const pendingA = armPendingComposerSend({
      targetKey: TARGET_A,
      dispatchMode: "queue",
      submissionIntent: "foreground",
      submissionTarget: "provider-turn",
      waitedForPreviousSend: false,
      baseline: zeroBaseline,
    });
    const pendingB = armPendingComposerSend({
      targetKey: TARGET_B,
      dispatchMode: "auto",
      submissionIntent: "background",
      submissionTarget: "provider-turn",
      waitedForPreviousSend: true,
      baseline: zeroBaseline,
    });

    expect(getPendingComposerSend(TARGET_A)).toEqual(pendingA);
    expect(getPendingComposerSend(TARGET_B)).toEqual(pendingB);

    // Cancelling or claiming thread B does not touch thread A, so switching back preserves A.
    expect(claimPendingComposerSend(TARGET_B, pendingB.id)).toEqual(pendingB);
    expect(getPendingComposerSend(TARGET_B)).toBeNull();
    expect(getPendingComposerSend(TARGET_A)).toEqual(pendingA);
    expect(claimPendingComposerSend(TARGET_A, pendingA.id)).toEqual(pendingA);
    expect(claimPendingComposerSend(TARGET_A, pendingA.id)).toBeNull();
  });

  it("stops waiting and surfaces actionable Chinese error on preparation failures", () => {
    const pending = armPendingComposerSend({
      targetKey: TARGET_A,
      dispatchMode: "auto",
      submissionIntent: "foreground",
      submissionTarget: "provider-turn",
      waitedForPreviousSend: true,
      baseline: {
        imageFailureSeq: 2,
        contextFailureSeq: 1,
        previousSendFailureSeq: 3,
      },
    });

    // Older failures at or below baseline must not abort the new pending send.
    expect(
      evaluatePendingComposerSend({
        pending,
        blockers: ["preparing-images"],
        failures: {
          imageFailure: { sequence: 2, fileName: "old.png", reason: "unreadable" },
          contextFailure: { sequence: 1, reason: "old error" },
          previousSendFailure: { sequence: 3, reason: "old send error" },
        },
        hardBlockedReason: null,
        currentSubmissionTarget: "provider-turn",
        editingQueuedMessage: false,
      }),
    ).toEqual({
      status: "waiting",
      primaryBlocker: "preparing-images",
      message: "正在压缩图片，好了自动发送",
    });

    const imageFailed = evaluatePendingComposerSend({
      pending,
      blockers: [],
      failures: {
        ...noFailures,
        imageFailure: { sequence: 3, fileName: "huge.png", reason: "too-large" },
      },
      hardBlockedReason: null,
      currentSubmissionTarget: "provider-turn",
      editingQueuedMessage: false,
    });
    expect(imageFailed).toMatchObject({
      status: "failed",
      kind: "preparing-images",
      title: "图片没压缩成功，消息没有发出",
      canRetryDirect: true,
    });
    if (imageFailed.status === "failed") {
      expect(imageFailed.description).toContain("huge.png");
      expect(imageFailed.description).toContain("内容还在输入框里");
    }

    const contextFailed = evaluatePendingComposerSend({
      pending,
      blockers: [],
      failures: {
        ...noFailures,
        contextFailure: { sequence: 2, reason: "从来源下载失败。" },
      },
      hardBlockedReason: null,
      currentSubmissionTarget: "provider-turn",
      editingQueuedMessage: false,
    });
    expect(contextFailed).toMatchObject({
      status: "failed",
      kind: "loading-context",
      title: "上下文加载失败，消息没有发出",
      canRetryDirect: true,
    });
    if (contextFailed.status === "failed") {
      expect(contextFailed.description).toContain("内容还在输入框里");
    }

    const previousFailed = evaluatePendingComposerSend({
      pending,
      blockers: [],
      failures: {
        ...noFailures,
        previousSendFailure: { sequence: 4, reason: "网络超时" },
      },
      hardBlockedReason: null,
      currentSubmissionTarget: "provider-turn",
      editingQueuedMessage: false,
    });
    expect(previousFailed).toMatchObject({
      status: "failed",
      kind: "previous-send-busy",
      title: "上一条消息没能发出，当前消息也没有发出",
      canRetryDirect: true,
    });

    const hardBlocked = evaluatePendingComposerSend({
      pending,
      blockers: [],
      failures: noFailures,
      hardBlockedReason: "这个后台服务目前不接受文件附件。请移除文件后再发送。",
      currentSubmissionTarget: "provider-turn",
      editingQueuedMessage: false,
    });
    expect(hardBlocked).toMatchObject({
      status: "failed",
      kind: "hard-blocked",
      title: "消息未能自动发送",
      canRetryDirect: false,
    });
  });

  it("ignores previous-send failures when the pending send did not wait for a previous send", () => {
    const pending = armPendingComposerSend({
      targetKey: TARGET_A,
      dispatchMode: "auto",
      submissionIntent: "foreground",
      submissionTarget: "provider-turn",
      waitedForPreviousSend: false,
      baseline: zeroBaseline,
    });

    expect(
      evaluatePendingComposerSend({
        pending,
        blockers: ["preparing-images"],
        failures: {
          ...noFailures,
          previousSendFailure: { sequence: 1, reason: "unrelated failure" },
        },
        hardBlockedReason: null,
        currentSubmissionTarget: "provider-turn",
        editingQueuedMessage: false,
      }),
    ).toEqual({
      status: "waiting",
      primaryBlocker: "preparing-images",
      message: "正在压缩图片，好了自动发送",
    });
  });
});

describe("evaluatePendingComposerSend when the composer changed under the armed send", () => {
  const arm = (submissionTarget: "provider-turn" | "pending-user-input") =>
    armPendingComposerSend({
      targetKey: TARGET_A,
      dispatchMode: "auto",
      submissionIntent: "foreground",
      submissionTarget,
      waitedForPreviousSend: false,
      baseline: zeroBaseline,
    });

  it("drops a message armed for a provider turn once a question takes over the composer", () => {
    const pending = arm("provider-turn");
    const result = evaluatePendingComposerSend({
      pending,
      blockers: [],
      failures: noFailures,
      hardBlockedReason: null,
      currentSubmissionTarget: "pending-user-input",
      editingQueuedMessage: false,
    });
    expect(result).toMatchObject({
      status: "failed",
      kind: "target-changed",
      canRetryDirect: false,
    });
  });

  it("drops a question answer armed earlier once the question is gone", () => {
    const pending = arm("pending-user-input");
    const result = evaluatePendingComposerSend({
      pending,
      blockers: ["reconnecting"],
      failures: noFailures,
      hardBlockedReason: null,
      currentSubmissionTarget: "provider-turn",
      editingQueuedMessage: false,
    });
    expect(result).toMatchObject({ status: "failed", kind: "target-changed" });
  });

  it("drops the armed send when a queued message is loaded for editing in its place", () => {
    const pending = arm("provider-turn");
    const result = evaluatePendingComposerSend({
      pending,
      blockers: ["previous-send-busy"],
      failures: noFailures,
      hardBlockedReason: null,
      currentSubmissionTarget: "provider-turn",
      editingQueuedMessage: true,
    });
    expect(result).toMatchObject({ status: "failed", kind: "target-changed" });
  });
});

describe("uploads that an answer or approval redirect needs first", () => {
  it("keeps the send waiting while attachments upload, then lets it go once they are done", () => {
    const pending = armPendingComposerSend({
      targetKey: TARGET_A,
      dispatchMode: "auto",
      submissionIntent: "foreground",
      submissionTarget: "provider-turn",
      waitedForPreviousSend: false,
      baseline: zeroBaseline,
    });
    const evaluate = (uploading: boolean) =>
      evaluatePendingComposerSend({
        pending,
        blockers: collectPendingSendBlockers({
          preparingImages: false,
          loadingContext: false,
          reconnecting: false,
          previousSendBusy: false,
          uploadingAttachments: uploading,
        }),
        failures: noFailures,
        hardBlockedReason: null,
        currentSubmissionTarget: "provider-turn",
        editingQueuedMessage: false,
      });
    expect(evaluate(true)).toEqual({
      status: "waiting",
      primaryBlocker: "uploading-attachments",
      message: "附件还在上传，传完自动发送",
    });
    expect(evaluate(false)).toEqual({ status: "ready" });
  });

  it("reports the compression step first when images are still being prepared as well", () => {
    expect(
      collectPendingSendBlockers({
        preparingImages: true,
        loadingContext: false,
        reconnecting: false,
        previousSendBusy: false,
        uploadingAttachments: true,
      }),
    ).toEqual(["preparing-images", "uploading-attachments"]);
  });
});

describe("cancel notices", () => {
  const arm = (targetKey: string) =>
    armPendingComposerSend({
      targetKey,
      dispatchMode: "auto",
      submissionIntent: "foreground",
      submissionTarget: "provider-turn",
      waitedForPreviousSend: false,
      baseline: zeroBaseline,
    });

  it("leaves a notice when an edit drops the armed send, and none when the user cancels", () => {
    arm(TARGET_A);
    expect(cancelPendingComposerSend(TARGET_A, PENDING_SEND_EDITED_NOTICE)).toBe(true);
    expect(getPendingComposerSend(TARGET_A)).toBeNull();
    expect(getPendingSendCancelNotice(TARGET_A)).toBe(PENDING_SEND_EDITED_NOTICE);

    arm(TARGET_B);
    expect(cancelPendingComposerSend(TARGET_B)).toBe(true);
    expect(getPendingSendCancelNotice(TARGET_B)).toBeNull();
  });

  it("keeps the notice across later keystrokes, so it is still there when the user looks", () => {
    arm(TARGET_A);
    cancelPendingComposerSend(TARGET_A, PENDING_SEND_EDITED_NOTICE);
    expect(cancelPendingComposerSend(TARGET_A, PENDING_SEND_EDITED_NOTICE)).toBe(false);
    expect(getPendingSendCancelNotice(TARGET_A)).toBe(PENDING_SEND_EDITED_NOTICE);
  });

  it("keeps the leave notice on the conversation that was left, not on the other one", () => {
    arm(TARGET_A);
    cancelPendingComposerSend(TARGET_A, PENDING_SEND_LEFT_NOTICE);
    expect(getPendingSendCancelNotice(TARGET_A)).toBe(PENDING_SEND_LEFT_NOTICE);
    expect(getPendingSendCancelNotice(TARGET_B)).toBeNull();
  });

  it("clears the notice when the user sends directly, arms again, or dismisses it", () => {
    arm(TARGET_A);
    cancelPendingComposerSend(TARGET_A, PENDING_SEND_EDITED_NOTICE);
    cancelPendingComposerSend(TARGET_A);
    expect(getPendingSendCancelNotice(TARGET_A)).toBeNull();

    arm(TARGET_A);
    cancelPendingComposerSend(TARGET_A, PENDING_SEND_EDITED_NOTICE);
    arm(TARGET_A);
    expect(getPendingSendCancelNotice(TARGET_A)).toBeNull();
    cancelPendingComposerSend(TARGET_A, PENDING_SEND_EDITED_NOTICE);

    arm(TARGET_B);
    cancelPendingComposerSend(TARGET_B, PENDING_SEND_EDITED_NOTICE);
    dismissPendingSendCancelNotice(TARGET_B);
    expect(getPendingSendCancelNotice(TARGET_B)).toBeNull();
  });
});

describe("resolvePendingSendDispatchMode", () => {
  it("preserves queue choice instead of interrupting when a running turn is still active", () => {
    expect(
      resolvePendingSendDispatchMode({
        requestedMode: "queue",
        isRunning: true,
        followUpBehavior: "steer",
        canSteer: true,
      }),
    ).toBe("queue");
  });

  it("preserves steer when still running and steerable, or degrades to queue if steering is blocked", () => {
    expect(
      resolvePendingSendDispatchMode({
        requestedMode: "steer",
        isRunning: true,
        followUpBehavior: "queue",
        canSteer: true,
      }),
    ).toBe("steer");
    expect(
      resolvePendingSendDispatchMode({
        requestedMode: "steer",
        isRunning: true,
        followUpBehavior: "steer",
        canSteer: false,
      }),
    ).toBe("queue");
  });

  it("uses auto when the active turn ended while waiting", () => {
    expect(
      resolvePendingSendDispatchMode({
        requestedMode: "queue",
        isRunning: false,
        followUpBehavior: "queue",
        canSteer: true,
      }),
    ).toBe("auto");
    expect(
      resolvePendingSendDispatchMode({
        requestedMode: "steer",
        isRunning: false,
        followUpBehavior: "steer",
        canSteer: true,
      }),
    ).toBe("auto");
  });

  it("follows current followUpBehavior if a turn started while an idle send was waiting", () => {
    expect(
      resolvePendingSendDispatchMode({
        requestedMode: "auto",
        isRunning: true,
        followUpBehavior: "queue",
        canSteer: true,
      }),
    ).toBe("queue");
    expect(
      resolvePendingSendDispatchMode({
        requestedMode: "auto",
        isRunning: true,
        followUpBehavior: "steer",
        canSteer: true,
      }),
    ).toBe("steer");
  });
});
