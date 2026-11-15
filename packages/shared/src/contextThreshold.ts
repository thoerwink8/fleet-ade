const DEFAULT_CONTEXT_THRESHOLD_PERCENT = 50;
const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;
const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000;
const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000;

const PERCENT_PATTERN = /^(?:[1-9]\d?|100)$/;

/** Empty or invalid input is the default, about half the model window. */
export function contextThresholdPercent(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 100) return raw;
  if (typeof raw === "string" && PERCENT_PATTERN.test(raw)) return Number(raw);
  return DEFAULT_CONTEXT_THRESHOLD_PERCENT;
}

export function contextThresholdPercentFromConfig(config: unknown): number {
  if (config === null || typeof config !== "object") return contextThresholdPercent(undefined);
  return contextThresholdPercent(Reflect.get(config, "contextThresholdPercent"));
}

export function contextThresholdTokens(maxTokens: number, percent: number): number {
  return Math.max(1, Math.floor((maxTokens * percent) / 100));
}

/**
 * Claude compacts 33,000 tokens short of `autoCompactWindow`, and ignores a window at or above
 * the model context. The returned window aims the compact point at the threshold.
 */
export function claudeAutoCompactWindowForThreshold(
  maxTokens: number,
  percent: number,
): string | undefined {
  const windowTokens =
    contextThresholdTokens(maxTokens, percent) + CLAUDE_AUTO_COMPACT_RESERVE_TOKENS;
  if (
    windowTokens < CLAUDE_AUTO_COMPACT_WINDOW_MIN ||
    windowTokens > CLAUDE_AUTO_COMPACT_WINDOW_MAX ||
    windowTokens >= maxTokens
  ) {
    return undefined;
  }
  return String(windowTokens);
}

export function sessionContextThreshold(input: {
  readonly usedTokens: number | null;
  readonly maxTokens: number | null;
  readonly autoCompactThreshold: number | null;
  readonly percentRaw: unknown;
}): {
  readonly percent: number;
  readonly thresholdTokens: number | null;
  readonly over: boolean;
} {
  const percent = contextThresholdPercent(input.percentRaw);
  const thresholdTokens =
    input.autoCompactThreshold != null && input.autoCompactThreshold > 0
      ? input.autoCompactThreshold
      : input.maxTokens != null && input.maxTokens > 0
        ? contextThresholdTokens(input.maxTokens, percent)
        : null;
  return {
    percent,
    thresholdTokens,
    over:
      thresholdTokens != null && input.usedTokens != null && input.usedTokens >= thresholdTokens,
  };
}

/** These runtimes have no compact setting we can pass, so the session itself asks. */
export function contextThresholdPrompts(driver: string | null | undefined): boolean {
  return driver === "antigravity" || driver === "pi";
}
