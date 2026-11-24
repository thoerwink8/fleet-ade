import { CHATGPT_WORKSPACE_USAGE_LIMIT_CODE } from "@t3tools/shared/usageLimits";
import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  getUsageLimitRecoveryButtonsState,
  usageLimitRecoveryBannerItem,
} from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "下午5:30 重置"],
    ["24-hour", "17:30 重置"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe("明天 17:30 重置");
  });

  it("describes a workspace cap the same way as a personal ChatGPT limit", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    const item = usageLimitRecoveryBannerItem({
      runId: RunId.make("run-1"),
      errorCode: CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
      resetAt: new Date(2026, 9, 20, 17, 30).toISOString(),
      stoppedAt: stoppedAt.toISOString(),
      settled: false,
      requestPending: false,
      snoozedUntil: null,
      recovery: null,
      timestampFormat: "24-hour",
      onChange: async () => {},
    });
    expect(item.title).toBe("已达到 ChatGPT 用量上限");
    expect(item.description).toBe("17:30 重置");
  });

  it("keeps resume and snooze saving states independent", () => {
    const resuming = getUsageLimitRecoveryButtonsState({
      pendingAction: "resume",
      scheduled: false,
      snoozed: false,
      resetPassed: false,
    });
    expect(resuming.resume).toEqual({ disabled: true, label: "正在保存…" });
    expect(resuming.snooze).toEqual({ disabled: false, label: "暂缓到重置时" });

    const snoozing = getUsageLimitRecoveryButtonsState({
      pendingAction: "snooze",
      scheduled: false,
      snoozed: false,
      resetPassed: false,
    });
    expect(snoozing.resume).toEqual({ disabled: false, label: "重置后自动继续" });
    expect(snoozing.snooze).toEqual({ disabled: true, label: "正在保存…" });
  });
});
