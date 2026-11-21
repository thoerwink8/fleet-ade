import type { SidebarThreadSummary } from "../../types";

function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
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
