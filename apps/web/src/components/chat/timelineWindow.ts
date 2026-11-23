import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

// Enough recent content to cover a tall viewport plus upward scroll headroom,
// without mounting an entire long thread on cold open.
const INITIAL_TIMELINE_WINDOW_HEIGHT_PX = 3_600;
const MIN_INITIAL_TIMELINE_WINDOW_ROWS = 4;
const MAX_INITIAL_TIMELINE_WINDOW_ROWS = 32;
const TIMELINE_WINDOW_EXPAND_STEP = 24;

const FOLDED_USER_MESSAGE_MAX_ESTIMATE_PX = 260;
const SINGLE_LINE_HEIGHT_PX = 24;
const MESSAGE_BASE_HEIGHT_PX = 44;
const ESTIMATED_COLUMNS_PER_LINE = 90;
const MIN_HIDDEN_PREFIX_ROWS = 3;
const TARGET_INDEX_LEADING_HEADROOM_ROWS = 4;

function visualLineColumns(line: string): number {
  let columns = 0;
  for (let index = 0; index < line.length; index += 1) {
    columns += line.charCodeAt(index) > 0x7f ? 2 : 1;
  }
  return columns;
}

function estimateTimelineRowHeight(row: MessagesTimelineRow): number {
  switch (row.kind) {
    case "message": {
      const text = row.message.text;
      if (text.length === 0) return 60;
      let visualLines = 0;
      for (const line of text.split("\n")) {
        visualLines += Math.max(1, Math.ceil(visualLineColumns(line) / ESTIMATED_COLUMNS_PER_LINE));
      }
      const estimated = MESSAGE_BASE_HEIGHT_PX + visualLines * SINGLE_LINE_HEIGHT_PX;
      return row.message.role === "user"
        ? Math.min(FOLDED_USER_MESSAGE_MAX_ESTIMATE_PX, estimated)
        : Math.min(2_400, estimated);
    }
    case "html-render":
      return Math.max(120, row.htmlRender.height ?? 300);
    case "turn-fold":
    case "attempt-fold":
    case "work-toggle":
    case "context-compaction":
    case "assistant-meta":
    case "working":
    case "thinking":
      return 48;
    default:
      return 120;
  }
}

export function computeInitialTimelineWindowStart(
  rows: ReadonlyArray<MessagesTimelineRow>,
): number {
  if (rows.length <= MIN_INITIAL_TIMELINE_WINDOW_ROWS) return 0;
  let height = 0;
  let count = 0;
  let start = rows.length;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    start = index;
    count += 1;
    height += estimateTimelineRowHeight(rows[index]!);
    if (count >= MAX_INITIAL_TIMELINE_WINDOW_ROWS) break;
    if (count >= MIN_INITIAL_TIMELINE_WINDOW_ROWS && height >= INITIAL_TIMELINE_WINDOW_HEIGHT_PX) {
      break;
    }
  }
  return start < MIN_HIDDEN_PREFIX_ROWS ? 0 : start;
}

export function nextExpandedTimelineWindowStart(currentStart: number): number {
  const next = currentStart - TIMELINE_WINDOW_EXPAND_STEP;
  return next < MIN_HIDDEN_PREFIX_ROWS ? 0 : next;
}

export function expandTimelineWindowStartForIndex(
  currentStart: number,
  targetFullIndex: number,
): number {
  if (currentStart === 0) return 0;
  const desiredStart = Math.max(0, targetFullIndex - TARGET_INDEX_LEADING_HEADROOM_ROWS);
  if (desiredStart < currentStart) {
    return desiredStart < MIN_HIDDEN_PREFIX_ROWS ? 0 : desiredStart;
  }
  return currentStart;
}

export interface TimelineWindowProjection {
  readonly rows: MessagesTimelineRow[];
  readonly windowStart: number;
  readonly pinnedLeadingIndex: number | null;
  readonly toFullIndex: (visibleIndex: number) => number;
  readonly toVisibleIndex: (fullIndex: number) => number;
}

export function projectTimelineWindow(
  rows: MessagesTimelineRow[],
  windowStart: number,
  pinnedLeadingIndex: number | null,
): TimelineWindowProjection {
  const maxStart = Math.max(0, rows.length - MIN_INITIAL_TIMELINE_WINDOW_ROWS);
  const clampedStart = windowStart < MIN_HIDDEN_PREFIX_ROWS ? 0 : Math.min(windowStart, maxStart);
  if (clampedStart < MIN_HIDDEN_PREFIX_ROWS) {
    return {
      rows,
      windowStart: 0,
      pinnedLeadingIndex: null,
      toFullIndex: (visibleIndex) => visibleIndex,
      toVisibleIndex: (fullIndex) => (fullIndex >= 0 && fullIndex < rows.length ? fullIndex : -1),
    };
  }
  const pinned =
    pinnedLeadingIndex !== null && pinnedLeadingIndex >= 0 && pinnedLeadingIndex < clampedStart
      ? pinnedLeadingIndex
      : null;
  const visibleRows =
    pinned === null ? rows.slice(clampedStart) : [rows[pinned]!, ...rows.slice(clampedStart)];
  const tailOffset = pinned === null ? 0 : 1;
  return {
    rows: visibleRows,
    windowStart: clampedStart,
    pinnedLeadingIndex: pinned,
    toFullIndex: (visibleIndex) => {
      if (pinned !== null && visibleIndex === 0) return pinned;
      return clampedStart + (visibleIndex - tailOffset);
    },
    toVisibleIndex: (fullIndex) => {
      if (fullIndex < 0 || fullIndex >= rows.length) return -1;
      if (pinned !== null && fullIndex === pinned) return 0;
      if (fullIndex < clampedStart) return -1;
      return fullIndex - clampedStart + tailOffset;
    },
  };
}
