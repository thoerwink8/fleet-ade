import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { interruptResultDetail, subagentResumedSince } from "./V2LifecycleRow.logic";

const failedAt = "2026-10-09T12:21:00.000Z";
const beforeFailure = DateTime.makeUnsafe("2026-10-09T12:05:00.000Z");
const afterFailure = DateTime.makeUnsafe("2026-10-09T12:48:00.000Z");

describe("subagentResumedSince", () => {
  it("is true while it runs even when the notification was delivered after the resume", () => {
    expect(
      subagentResumedSince(
        { status: "running", startedAt: afterFailure },
        "2026-10-09T12:50:00.000Z",
      ),
    ).toBe(true);
  });

  // regression: #18099 a resumed subagent's old failure notification row showed failed instead of resumed
  it("is true once a run started after the notification has settled", () => {
    expect(subagentResumedSince({ status: "completed", startedAt: afterFailure }, failedAt)).toBe(
      true,
    );
  });

  it("is false for the run the notification reported on", () => {
    expect(subagentResumedSince({ status: "failed", startedAt: beforeFailure }, failedAt)).toBe(
      false,
    );
  });
});

describe("interruptResultDetail", () => {
  it("translates the legacy English interrupt message into Chinese", () => {
    expect(interruptResultDetail("Run interrupted before provider start")).toBe(
      "任务在智能体启动前被打断",
    );
    expect(interruptResultDetail("Interrupted before provider start")).toBe("在智能体启动前被打断");
  });

  it("keeps the current Chinese message unchanged", () => {
    expect(interruptResultDetail("任务在智能体启动前被打断")).toBe("任务在智能体启动前被打断");
  });
});
