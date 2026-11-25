import { CommandId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyRewindOutcome,
  deriveRollbackProgress,
  hasActiveRun,
  resolveRewindRoute,
  rollbackSendBlockReason,
} from "./stopAndRewind.logic";

const requestId = CommandId.make("rewind-1");
const pending = {
  requestId,
  turnCount: 1,
  restoreFiles: true,
  requestedAt: "2026-11-25T00:00:00.000Z",
} as never;

describe("resolveRewindRoute", () => {
  const idle = {
    runActive: false,
    sendBusy: false,
    supportsStopAndRollback: true,
    pendingRollback: false,
  };

  it("keeps the idle path for a thread that is not running", () => {
    expect(resolveRewindRoute(idle)).toEqual({ kind: "checkpoint" });
    expect(resolveRewindRoute({ ...idle, supportsStopAndRollback: false })).toEqual({
      kind: "checkpoint",
    });
  });

  it("rewinds a running thread in one step when the server can", () => {
    expect(resolveRewindRoute({ ...idle, runActive: true })).toEqual({
      kind: "stop-and-rollback",
    });
  });

  it("keeps the three-step path on an older server", () => {
    expect(
      resolveRewindRoute({ ...idle, runActive: true, supportsStopAndRollback: false }),
    ).toEqual({ kind: "blocked", message: "正在运行，请先停止再回退。" });
  });

  it("refuses a second rewind while one is pending", () => {
    expect(resolveRewindRoute({ ...idle, runActive: true, pendingRollback: true }).kind).toBe(
      "blocked",
    );
  });

  it("waits for a message that is still being sent", () => {
    expect(resolveRewindRoute({ ...idle, runActive: true, sendBusy: true }).kind).toBe("blocked");
  });
});

describe("hasActiveRun", () => {
  it("counts every run that has not settled, waiting included", () => {
    for (const status of ["preparing", "starting", "running", "waiting"] as const) {
      expect(hasActiveRun([{ status }])).toBe(true);
    }
    for (const status of [
      "completed",
      "interrupted",
      "failed",
      "cancelled",
      "rolled_back",
    ] as const) {
      expect(hasActiveRun([{ status }])).toBe(false);
    }
  });
});

describe("deriveRollbackProgress", () => {
  const base = {
    pendingRollback: null,
    rollbackFailure: null,
    hasActiveRun: false,
    localRewinding: false,
  };

  it("is idle with nothing pending", () => {
    expect(deriveRollbackProgress(base)).toEqual({ step: "idle" });
  });

  it("shows stopping while a pending rewind still has a run, for any client", () => {
    expect(
      deriveRollbackProgress({ ...base, pendingRollback: pending, hasActiveRun: true }),
    ).toEqual({ step: "stopping", forceStop: false, canCancel: true });
  });

  it("shows rewinding once the run settled but the rewind is still pending", () => {
    expect(deriveRollbackProgress({ ...base, pendingRollback: pending })).toEqual({
      step: "rewinding",
      canCancel: true,
    });
  });

  it("shows rewinding for the starting client after the server cleared the pending rewind", () => {
    expect(deriveRollbackProgress({ ...base, localRewinding: true })).toEqual({
      step: "rewinding",
      canCancel: false,
    });
  });

  it("shows rewinding for any client while the server marks a rewind in progress", () => {
    expect(deriveRollbackProgress({ ...base, rollbackInProgressRequestId: requestId })).toEqual({
      step: "rewinding",
      canCancel: false,
    });
    // Pending still wins while the run has not stopped: the rewind is not queued yet.
    expect(
      deriveRollbackProgress({
        ...base,
        pendingRollback: pending,
        hasActiveRun: true,
        rollbackInProgressRequestId: null,
      }),
    ).toEqual({ step: "stopping", forceStop: false, canCancel: true });
  });

  it("offers force stop when this rewind's stop went unanswered", () => {
    const failure = { requestId, message: "x", code: "interrupt-unresponsive" } as const;
    expect(
      deriveRollbackProgress({ ...base, pendingRollback: pending, rollbackFailure: failure }),
    ).toEqual({ step: "stopping", forceStop: true, canCancel: true });
    // A failure from another request says nothing about this one.
    expect(
      deriveRollbackProgress({
        ...base,
        pendingRollback: pending,
        hasActiveRun: true,
        rollbackFailure: { ...failure, requestId: CommandId.make("other") },
      }),
    ).toEqual({ step: "stopping", forceStop: false, canCancel: true });
  });
});

describe("rollbackSendBlockReason", () => {
  it("names the step that blocks sending, and is silent when idle", () => {
    expect(rollbackSendBlockReason({ step: "idle" })).toBeNull();
    expect(
      rollbackSendBlockReason({ step: "stopping", forceStop: false, canCancel: true }),
    ).toContain("正在停止");
    expect(rollbackSendBlockReason({ step: "rewinding", canCancel: false })).toContain("正在回退");
  });
});

describe("classifyRewindOutcome", () => {
  const thread = {
    pendingRollback: null,
    rollbackFailure: null,
    rollbackCompletedRequestId: undefined,
  } as Parameters<typeof classifyRewindOutcome>[0];

  it("completes only for the id this client sent", () => {
    expect(
      classifyRewindOutcome({ ...thread, rollbackCompletedRequestId: requestId }, requestId),
    ).toEqual({ kind: "completed" });
    expect(
      classifyRewindOutcome(
        { ...thread, rollbackCompletedRequestId: CommandId.make("someone-else") },
        requestId,
      ),
    ).toEqual({ kind: "waiting" });
  });

  it("fails with the code and text of this request's failure", () => {
    expect(
      classifyRewindOutcome(
        {
          ...thread,
          rollbackFailure: { requestId, message: "no snapshot", code: "checkpoint-missing" },
        },
        requestId,
      ),
    ).toEqual({ kind: "failed", message: "no snapshot", code: "checkpoint-missing" });
    expect(
      classifyRewindOutcome(
        { ...thread, rollbackFailure: { requestId: CommandId.make("other"), message: "x" } },
        requestId,
      ),
    ).toEqual({ kind: "waiting" });
  });

  it("reports a cancel and a queued rewind only for the id this client sent", () => {
    expect(
      classifyRewindOutcome({ ...thread, rollbackCancelledRequestId: requestId }, requestId),
    ).toEqual({ kind: "cancelled" });
    expect(
      classifyRewindOutcome({ ...thread, rollbackInProgressRequestId: requestId }, requestId),
    ).toEqual({ kind: "rewinding" });
    const other = CommandId.make("other");
    expect(
      classifyRewindOutcome(
        { ...thread, rollbackCancelledRequestId: other, rollbackInProgressRequestId: other },
        requestId,
      ),
    ).toEqual({ kind: "waiting" });
    // A finished rewind outranks a marker left over from an earlier step.
    expect(
      classifyRewindOutcome(
        {
          ...thread,
          rollbackInProgressRequestId: requestId,
          rollbackCompletedRequestId: requestId,
        },
        requestId,
      ),
    ).toEqual({ kind: "completed" });
  });

  it("keeps waiting when the stop went unanswered but the rewind is still held", () => {
    expect(
      classifyRewindOutcome(
        {
          ...thread,
          pendingRollback: pending,
          rollbackFailure: { requestId, message: "x", code: "interrupt-unresponsive" },
        },
        requestId,
      ),
    ).toEqual({ kind: "waiting" });
    // Once the hold is gone the same code is final.
    expect(
      classifyRewindOutcome(
        { ...thread, rollbackFailure: { requestId, message: "x", code: "interrupt-unresponsive" } },
        requestId,
      ).kind,
    ).toBe("failed");
  });
});
