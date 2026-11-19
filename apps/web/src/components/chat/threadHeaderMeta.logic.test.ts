import { describe, expect, it } from "vite-plus/test";

import { formatHeaderContextPercent, issueNumberFromBranch } from "./threadHeaderMeta.logic";

describe("issueNumberFromBranch", () => {
  it.each([
    ["local/137-thread-sample", 137],
    ["fix/42-x", 42],
    ["137-thread", 137],
    ["feat/verify-speed", null],
    ["main", null],
  ])("reads %s as %s", (branch, expected) => {
    expect(issueNumberFromBranch(branch)).toBe(expected === null ? null : expected);
  });

  it("is null without a branch", () => {
    expect(issueNumberFromBranch(null)).toBeNull();
  });
});

describe("formatHeaderContextPercent", () => {
  it("prefers the reported percentage and keeps one decimal", () => {
    expect(
      formatHeaderContextPercent({ usedPercentage: 19.34, usedTokens: 1, maxTokens: 10 }),
    ).toBe("19.3%");
  });

  it("falls back to tokens over the window", () => {
    expect(
      formatHeaderContextPercent({ usedPercentage: null, usedTokens: 50_000, maxTokens: 200_000 }),
    ).toBe("25.0%");
  });

  it("is null when there is no window to divide by", () => {
    expect(formatHeaderContextPercent({ usedPercentage: null, usedTokens: 5 })).toBeNull();
    expect(formatHeaderContextPercent(null)).toBeNull();
  });
});
