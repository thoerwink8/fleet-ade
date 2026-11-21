import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  collectThreadUsageSessions,
  driverToUsageProvider,
  formatHeaderContextPercent,
  formatHeaderCostUsd,
  issueNumberFromBranch,
} from "./threadHeaderMeta.logic";

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

describe("driverToUsageProvider", () => {
  it.each([
    ["claudeAgent", "claude"],
    ["codex", "codex"],
    ["grok", "grok"],
    ["antigravity", "antigravity"],
    ["acpRegistry", null],
  ])("maps %s to %s", (driver, expected) => {
    expect(driverToUsageProvider(driver)).toBe(expected);
  });
});

describe("collectThreadUsageSessions", () => {
  it("deduplicates, sorts deterministically, skips unsupported/empty refs, and picks earliest sinceTime", () => {
    const query = collectThreadUsageSessions([
      {
        driver: "codex",
        nativeThreadRef: { nativeId: "codex-2" },
        createdAt: DateTime.makeUnsafe("2026-11-12T10:00:00.000Z"),
      },
      {
        driver: "claudeAgent",
        nativeThreadRef: { nativeId: "claude-1" },
        createdAt: DateTime.makeUnsafe("2026-11-10T08:30:00.000Z"),
      },
      {
        driver: "claudeAgent",
        nativeThreadRef: { nativeId: "claude-1" },
        createdAt: DateTime.makeUnsafe("2026-11-15T00:00:00.000Z"),
      },
      {
        driver: "acpRegistry",
        nativeThreadRef: { nativeId: "acp-1" },
        createdAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
      },
      {
        driver: "grok",
        nativeThreadRef: { nativeId: null },
        createdAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
      },
    ]);

    expect(query).toEqual({
      sessions: [
        { provider: "claude", sessionId: "claude-1" },
        { provider: "codex", sessionId: "codex-2" },
      ],
      sinceTime: "2026-11-10T08:30:00.000Z",
    });
  });

  it("returns empty sessions when providerThreads is missing or empty", () => {
    expect(collectThreadUsageSessions(null)).toEqual({ sessions: [] });
    expect(collectThreadUsageSessions([])).toEqual({ sessions: [] });
  });
});

describe("formatHeaderCostUsd", () => {
  it.each([
    [0.38, "$0.38"],
    [0.384, "$0.38"],
    [12.5, "$12.50"],
    [0.004, "<$0.01"],
    [0, null],
    [-0.5, null],
    [Number.NaN, null],
    [null, null],
    [undefined, null],
  ])("formats %s as %s", (cost, expected) => {
    expect(formatHeaderCostUsd(cost)).toBe(expected);
  });
});
