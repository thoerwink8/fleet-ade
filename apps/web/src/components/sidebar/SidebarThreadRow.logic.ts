import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatDayAwareTimestamp } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";

function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export interface SidebarEmptyThreadCandidate {
  readonly latestRun: unknown | null;
  readonly runtime: unknown | null;
  readonly latestUserMessageAt: string | null;
  readonly visibleItemCount?: number | undefined;
  readonly turnCount?: number | undefined;
  readonly latestMessagePreview?: SidebarThreadSummary["latestMessagePreview"];
}

export interface SidebarDuplicateEmptyThreadInput extends SidebarEmptyThreadCandidate {
  readonly key: string;
  readonly title: string;
  readonly createdAt: string;
}

/**
 * True when a thread has never sent a message or started a run.
 */
export function isEmptySidebarThread(thread: SidebarEmptyThreadCandidate): boolean {
  return (
    thread.latestRun === null &&
    thread.runtime === null &&
    thread.latestUserMessageAt === null &&
    (thread.visibleItemCount ?? 0) === 0 &&
    (thread.turnCount ?? 0) === 0 &&
    thread.latestMessagePreview == null
  );
}

/**
 * Resolve creation-time suffixes for empty threads whose title collides with another visible
 * thread. Uses day-aware HH:mm first and falls back to seconds if two empty siblings land in
 * the same formatted minute.
 */
export function resolveDuplicateEmptyThreadTitleSuffixes(input: {
  readonly threads: ReadonlyArray<SidebarDuplicateEmptyThreadInput>;
  readonly timestampFormat: TimestampFormat;
  readonly nowMs: number;
  readonly timeZone?: string;
}): ReadonlyMap<string, string> {
  const titleCounts = new Map<string, number>();
  for (const thread of input.threads) {
    const normalized = normalizeSingleLine(thread.title);
    if (normalized.length === 0) continue;
    titleCounts.set(normalized, (titleCounts.get(normalized) ?? 0) + 1);
  }

  const candidatesByTitle = new Map<
    string,
    Array<{ readonly key: string; readonly createdAt: string; readonly minuteLabel: string }>
  >();
  for (const thread of input.threads) {
    if (!isEmptySidebarThread(thread)) continue;
    const normalized = normalizeSingleLine(thread.title);
    if ((titleCounts.get(normalized) ?? 0) < 2) continue;
    const minuteLabel = formatDayAwareTimestamp(
      thread.createdAt,
      input.timestampFormat,
      input.nowMs,
      input.timeZone,
      false,
    );
    if (minuteLabel.length === 0) continue;
    const group = candidatesByTitle.get(normalized);
    const entry = { key: thread.key, createdAt: thread.createdAt, minuteLabel };
    if (group) group.push(entry);
    else candidatesByTitle.set(normalized, [entry]);
  }

  const suffixes = new Map<string, string>();
  for (const group of candidatesByTitle.values()) {
    const labelCounts = new Map<string, number>();
    for (const entry of group) {
      labelCounts.set(entry.minuteLabel, (labelCounts.get(entry.minuteLabel) ?? 0) + 1);
    }
    for (const entry of group) {
      if ((labelCounts.get(entry.minuteLabel) ?? 0) > 1) {
        const secondLabel = formatDayAwareTimestamp(
          entry.createdAt,
          input.timestampFormat,
          input.nowMs,
          input.timeZone,
          true,
        );
        suffixes.set(entry.key, secondLabel.length > 0 ? secondLabel : entry.minuteLabel);
      } else {
        suffixes.set(entry.key, entry.minuteLabel);
      }
    }
  }
  return suffixes;
}

export function formatSidebarRowDisplayTitle(title: string, titleSuffix: string | null): string {
  return titleSuffix ? `${title} · ${titleSuffix}` : title;
}

/**
 * Resolve the single-line summary preview for a sidebar card row.
 * Returns null when absent, empty, or identical to the thread title so a new
 * thread whose title was seeded from the first prompt does not repeat itself.
 */
export function resolveSidebarRowPreviewText(
  thread: Pick<SidebarThreadSummary, "title" | "latestMessagePreview">,
): string | null {
  const preview = thread.latestMessagePreview;
  if (preview == null) return null;
  const text = normalizeSingleLine(preview.text);
  if (text.length === 0) return null;
  if (text === normalizeSingleLine(thread.title)) return null;
  return preview.role === "user" ? `你：${text}` : text;
}

/**
 * Format compact turn and active background task counts for the sidebar card
 * metadata row. Zero counts are omitted to keep idle/new rows quiet.
 */
export function formatSidebarRowCounts(input: {
  readonly turnCount?: number | undefined;
  readonly pendingTaskCount: number;
}): string | null {
  const parts: string[] = [];
  if (input.turnCount !== undefined && input.turnCount > 0) {
    parts.push(`${input.turnCount} 轮`);
  }
  if (input.pendingTaskCount > 0) {
    parts.push(`${input.pendingTaskCount} 任务`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
