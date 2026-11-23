import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

// Cold open mounts a fixed recent tail; if that still underfills a tall viewport,
// MessagesTimeline expands upward in steps after layout.
const INITIAL_TIMELINE_WINDOW_ROWS = 12;
const TIMELINE_WINDOW_EXPAND_STEP = 24;
// The first commit mounts only this tail so the cold-open frame stays cheap; the
// window then grows to the initial size on the frame after first paint.
const FIRST_PAINT_TIMELINE_WINDOW_ROWS = 6;
const MIN_HIDDEN_PREFIX_ROWS = 3;
const TARGET_INDEX_LEADING_HEADROOM_ROWS = 4;

export function computeInitialTimelineWindowStart(
  rows: ReadonlyArray<MessagesTimelineRow>,
): number {
  const start = rows.length - INITIAL_TIMELINE_WINDOW_ROWS;
  return start < MIN_HIDDEN_PREFIX_ROWS ? 0 : start;
}

export function computeFirstPaintTimelineWindowStart(
  rows: ReadonlyArray<MessagesTimelineRow>,
): number {
  const initialStart = computeInitialTimelineWindowStart(rows);
  // No hidden prefix means the small first paint buys nothing.
  if (initialStart === 0) return 0;
  return Math.max(rows.length - FIRST_PAINT_TIMELINE_WINDOW_ROWS, initialStart);
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
  readonly toFullIndex: (visibleIndex: number) => number;
  readonly toVisibleIndex: (fullIndex: number) => number;
}

export function projectTimelineWindow(
  rows: MessagesTimelineRow[],
  windowStart: number,
  pinnedLeadingIndex: number | null,
): TimelineWindowProjection {
  const clampedStart =
    windowStart < MIN_HIDDEN_PREFIX_ROWS
      ? 0
      : windowStart >= rows.length
        ? computeInitialTimelineWindowStart(rows)
        : windowStart;
  if (clampedStart < MIN_HIDDEN_PREFIX_ROWS) {
    return {
      rows,
      windowStart: 0,
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
