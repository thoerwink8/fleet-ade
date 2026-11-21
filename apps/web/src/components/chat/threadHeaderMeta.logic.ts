import type { SessionUsageTarget, UsageProviderKind } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

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

/** Maps a provider driver kind to the Usage service provider literal, or null when unmeasured. */
export function driverToUsageProvider(driver: string): UsageProviderKind | null {
  switch (driver) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    case "grok":
      return "grok";
    case "antigravity":
      return "antigravity";
    default:
      return null;
  }
}

export interface ThreadUsageSessionSource {
  readonly driver: string;
  readonly nativeThreadRef: { readonly nativeId: string | null } | null;
  readonly createdAt?: DateTime.Utc | string | null | undefined;
}

/**
 * Collects distinct `(provider, sessionId)` targets for a thread's provider threads in deterministic
 * order, plus the earliest valid creation timestamp as `sinceTime`.
 */
export function collectThreadUsageSessions(
  providerThreads: readonly ThreadUsageSessionSource[] | null | undefined,
): {
  readonly sessions: readonly SessionUsageTarget[];
  readonly sinceTime?: string;
} {
  if (!providerThreads || providerThreads.length === 0) {
    return { sessions: [] };
  }
  const byKey = new Map<string, SessionUsageTarget>();
  let earliestMs: number | null = null;
  let earliestIso: string | undefined;

  for (const thread of providerThreads) {
    const provider = driverToUsageProvider(thread.driver);
    const sessionId = thread.nativeThreadRef?.nativeId?.trim();
    if (provider === null || !sessionId) continue;

    const key = `${provider}\0${sessionId}`;
    if (!byKey.has(key)) {
      byKey.set(key, { provider, sessionId });
    }
    if (thread.createdAt != null) {
      const parsed = Option.getOrUndefined(DateTime.make(thread.createdAt));
      if (parsed !== undefined) {
        const ms = DateTime.toEpochMillis(parsed);
        if (earliestMs === null || ms < earliestMs) {
          earliestMs = ms;
          earliestIso = DateTime.formatIso(parsed);
        }
      }
    }
  }

  const sessions = [...byKey.values()].toSorted(
    (left, right) =>
      left.provider.localeCompare(right.provider) || left.sessionId.localeCompare(right.sessionId),
  );

  return earliestIso === undefined ? { sessions } : { sessions, sinceTime: earliestIso };
}

/** Formats positive session USD cost for the header and details card; hides zero or unknown cost. */
export function formatHeaderCostUsd(costUsd: number | null | undefined): string | null {
  if (costUsd == null || !Number.isFinite(costUsd) || costUsd <= 0) return null;
  if (costUsd < 0.01) return "<$0.01";
  return formatUsd(costUsd);
}
