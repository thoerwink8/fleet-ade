import { describe, expect, it } from "@effect/vitest";

import {
  claudeAutoCompactWindowForThreshold,
  contextThresholdPercent,
  contextThresholdTokens,
  sessionContextThreshold,
} from "./contextThreshold.ts";

describe("contextThreshold", () => {
  it("treats an empty setting as half the window", () => {
    expect(contextThresholdPercent("")).toBe(50);
    expect(contextThresholdPercent(undefined)).toBe(50);
    expect(contextThresholdPercent("40")).toBe(40);
    expect(contextThresholdPercent("0")).toBe(50);
    expect(contextThresholdTokens(200_000, 50)).toBe(100_000);
  });

  it("asks Claude to compact at the threshold, not 33,000 tokens earlier", () => {
    expect(claudeAutoCompactWindowForThreshold(200_000, 50)).toBe("133000");
    expect(claudeAutoCompactWindowForThreshold(1_000_000, 50)).toBe("533000");
    expect(claudeAutoCompactWindowForThreshold(120_000, 50)).toBeUndefined();
  });

  it("marks a session over the threshold only when both sides are known", () => {
    expect(
      sessionContextThreshold({
        usedTokens: 120_000,
        maxTokens: 200_000,
        autoCompactThreshold: null,
        percentRaw: "",
      }),
    ).toMatchObject({ thresholdTokens: 100_000, over: true });
    expect(
      sessionContextThreshold({
        usedTokens: 10,
        maxTokens: null,
        autoCompactThreshold: null,
        percentRaw: "50",
      }).thresholdTokens,
    ).toBeNull();
  });
});
