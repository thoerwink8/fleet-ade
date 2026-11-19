/** The ticket a branch is named for: `local/137-thread-sample` and `fix/137-x` both give 137. */
export function issueNumberFromBranch(branch: string | null | undefined): number | null {
  if (!branch) return null;
  const match = /(?:^|\/)(\d{1,6})(?:-|$)/.exec(branch);
  return match ? Number(match[1]) : null;
}

/** The header's context share, as `19.3%`. Null while the provider has not reported a window. */
export function formatHeaderContextPercent(
  usage: {
    readonly usedPercentage: number | null;
    readonly usedTokens: number;
    readonly maxTokens?: number | null;
  } | null,
): string | null {
  if (usage === null) return null;
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const percent =
    usage.usedPercentage ?? (maxTokens !== null ? (usage.usedTokens / maxTokens) * 100 : null);
  if (percent === null || !Number.isFinite(percent)) return null;
  const clamped = Math.max(0, Math.min(100, percent));
  return `${clamped.toFixed(1)}%`;
}
