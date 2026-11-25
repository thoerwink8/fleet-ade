import { describe, expect, it } from "vite-plus/test";

import { stopButtonName, stopButtonTooltip, type StopPhase } from "./stopPhase.logic";

describe("stopButtonName", () => {
  it.each<[StopPhase, string, string]>([
    [null, "停止", "停止"],
    ["pending", "正在停止", "正在停止…"],
    ["timedOut", "还没停下，可以再点一次", "还没停下，可以再点一次"],
    ["landed", "停止", "停止"],
  ])("%s", (phase, name, tooltip) => {
    expect(stopButtonName(phase)).toBe(name);
    expect(stopButtonTooltip(phase)).toBe(tooltip);
  });
});
