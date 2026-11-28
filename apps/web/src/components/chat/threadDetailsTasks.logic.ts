import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import * as DateTime from "effect/DateTime";

/**
 * Background-work section rows from subagents, provider commands, and child sessions.
 * Only formats existing fields; never fetches or guesses silence without a real output timestamp.
 */

/** Active rows beyond this scroll inside the section instead of growing the column. */
export const BACKGROUND_WORK_SCROLL_AFTER = 6;
/** Finished rows kept for the session, newest first; older ones leave the section. */
export const BACKGROUND_WORK_COMPLETED_CAP = 20;
/** The second line names a silence only once it passes this. */
export const BACKGROUND_WORK_SILENCE_AFTER_MS = 5 * 60 * 1000;

const ACTIVE_STATUSES: Readonly<Record<string, true>> = {
  pending: true,
  running: true,
  waiting: true,
};

export type BackgroundWorkSource = "subagent" | "command" | "child";

export interface BackgroundWorkRowInput {
  readonly id: string;
  readonly source: BackgroundWorkSource;
  readonly title: string;
  /** The provider driving this row; its display name seeds the agent slot. */
  readonly driver: ProviderDriverKind | null;
  readonly status: string;
  /** ISO strings, or null when the roster keeps none. */
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** The progress sentence, when the source keeps one. */
  readonly progress: string | null;
  /**
   * When the row last produced output, epoch milliseconds. `null` means the source keeps no such
   * timestamp, so the silence line is omitted rather than guessed.
   */
  readonly lastOutputAtMs: number | null;
  /** Set on a finished row whose outcome names a reason, so that reason can be marked. */
  readonly errorReason: string | null;
  /** The subagent a Stop targets. Absent for commands and for a child with no subagent row. */
  readonly subagentId: string | null;
  /** The thread a Stop interrupts. A command stops the session thread itself. */
  readonly stopThreadId: ThreadId | null;
  /** The child session a row click opens when one exists. */
  readonly childThreadId: ThreadId | null;
}

export interface BackgroundWorkStatusWord {
  readonly label: string;
  /** The failure mark: the type icon and the word both read as the failure colour. */
  readonly failed: boolean;
}

const STATUS_WORDS: Readonly<Record<string, BackgroundWorkStatusWord>> = {
  pending: { label: "运行中", failed: false },
  running: { label: "运行中", failed: false },
  waiting: { label: "等待中", failed: false },
  completed: { label: "已完成", failed: false },
  failed: { label: "出错了", failed: true },
  cancelled: { label: "已停止", failed: false },
  interrupted: { label: "已停止", failed: false },
};

export function backgroundWorkStatusWord(status: string): BackgroundWorkStatusWord {
  return STATUS_WORDS[status] ?? { label: "未知", failed: false };
}

export function isActiveBackgroundWork(status: string): boolean {
  return ACTIVE_STATUSES[status] === true;
}

/** Whole minutes since the last output, but only past the silence threshold; otherwise nothing. */
export function backgroundWorkSilenceMinutes(
  lastOutputAtMs: number | null,
  nowMs: number,
): number | null {
  if (lastOutputAtMs === null) return null;
  const elapsed = nowMs - lastOutputAtMs;
  if (!Number.isFinite(elapsed) || elapsed <= BACKGROUND_WORK_SILENCE_AFTER_MS) return null;
  return Math.floor(elapsed / 60_000);
}

export interface BackgroundWorkSecondLineSegment {
  readonly text: string;
  /** The error reason, the only words on the line drawn in the failure colour. */
  readonly bad: boolean;
}

/**
 * The second line: the progress sentence, then the silence note when the data supports one.
 * Returns nothing when the row has neither, so the row stays a single line.
 */
export function backgroundWorkSecondLine(
  row: Pick<BackgroundWorkRowInput, "progress" | "lastOutputAtMs" | "errorReason">,
  nowMs: number,
): ReadonlyArray<BackgroundWorkSecondLineSegment> | null {
  const segments: BackgroundWorkSecondLineSegment[] = [];
  const progress = row.progress?.trim() ?? "";
  if (progress.length > 0) {
    const reason = row.errorReason?.trim() ?? "";
    const at = reason.length > 0 ? progress.indexOf(reason) : -1;
    if (at === -1) {
      segments.push({ text: progress, bad: false });
    } else {
      if (at > 0) segments.push({ text: progress.slice(0, at), bad: false });
      segments.push({ text: progress.slice(at, at + reason.length), bad: true });
      const rest = progress.slice(at + reason.length);
      if (rest.length > 0) segments.push({ text: rest, bad: false });
    }
  }
  const silentFor = backgroundWorkSilenceMinutes(row.lastOutputAtMs, nowMs);
  if (silentFor !== null) {
    if (segments.length > 0) segments.push({ text: " · ", bad: false });
    segments.push({ text: `已 ${silentFor} 分钟无输出`, bad: false });
  }
  return segments.length === 0 ? null : segments;
}

function rowTitle(source: BackgroundWorkSource, description: string | undefined): string {
  const text = description?.trim() ?? "";
  if (text.length === 0) {
    return source === "command" ? "命令" : "后台任务";
  }
  return source === "command" ? commandDisplayText(text) : formatSubagentDisplayTitle(text);
}

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value === null || value === undefined ? null : DateTime.formatIso(value);
}

/**
 * Subagent rows. `updatedAt` changes on every status write, not only on output, so it is not a
 * last-output time; the silence line stays off rather than guessed.
 */
export function backgroundWorkRowsFromSubagents(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): ReadonlyArray<BackgroundWorkRowInput> {
  return subagents.map((subagent) => {
    // A failed row reads its reason instead of the last progress, so the reason is what the
    // second line can mark.
    const failed = subagent.status === "failed";
    const resultText = subagent.result?.trim() || null;
    return {
      id: `subagent:${subagent.id}`,
      source: "subagent" as const,
      title: rowTitle("subagent", subagent.title ?? subagent.prompt),
      driver: subagent.driver,
      status: subagent.status,
      startedAt: isoOrNull(subagent.startedAt),
      completedAt: isoOrNull(subagent.completedAt),
      progress: failed && resultText !== null ? resultText : (subagent.progress ?? null),
      lastOutputAtMs: null,
      errorReason: failed ? resultText : null,
      subagentId: subagent.id,
      stopThreadId: subagent.threadId,
      childThreadId: subagent.childThreadId,
    };
  });
}
function turnItemOutputAtMs(
  task: OrchestrationV2PendingBackgroundTask,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): number | null {
  const item = turnItems.findLast((candidate) =>
    task.itemId === undefined
      ? (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId
      : candidate.id === task.itemId,
  );
  if (item === undefined) return null;
  const stamp = item.completedAt ?? item.updatedAt;
  return DateTime.toEpochMillis(stamp);
}

/** Command rows from the provider thread's background roster, pending and already finished. */
export function backgroundWorkRowsFromCommands(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionThreadId: ThreadId,
): ReadonlyArray<BackgroundWorkRowInput> {
  const seen = new Set<string>();
  const rows: BackgroundWorkRowInput[] = [];
  for (const task of tasks) {
    if (task.kind !== "command" && task.kind !== "monitor") continue;
    if (seen.has(task.taskId)) continue;
    seen.add(task.taskId);
    rows.push({
      id: `command:${task.taskId}`,
      source: "command",
      title: rowTitle("command", task.description ?? task.command),
      driver: null,
      status: task.status ?? "running",
      startedAt: isoOrNull(task.startedAt),
      completedAt: isoOrNull(task.completedAt),
      progress: null,
      lastOutputAtMs: turnItemOutputAtMs(task, turnItems),
      errorReason: null,
      subagentId: null,
      stopThreadId: sessionThreadId,
      childThreadId: null,
    });
  }
  return rows;
}

export interface BackgroundWorkChildSession {
  readonly threadId: ThreadId;
  readonly title: string | null;
  readonly phase: string;
  readonly activity: string;
}

const CHILD_PHASE_STATUS: Readonly<Record<string, string>> = {
  在做: "running",
  卡住: "waiting",
  做完: "completed",
};

/**
 * Child sessions the two rosters above do not already show. A child that is itself a subagent is
 * one row, not two. The summary's phase words are its own vocabulary, so the status falls back to
 * 未知 rather than relabelling them. The summary keeps no per-row output stamp, so the silence
 * line stays off for child rows.
 */
export function backgroundWorkRowsFromChildren(
  children: ReadonlyArray<BackgroundWorkChildSession>,
  alreadyShownThreadIds: ReadonlySet<string>,
): ReadonlyArray<BackgroundWorkRowInput> {
  return children
    .filter((child) => !alreadyShownThreadIds.has(child.threadId))
    .map((child) => ({
      id: `child:${child.threadId}`,
      source: "child" as const,
      title: rowTitle("child", child.title ?? undefined),
      driver: null,
      status: CHILD_PHASE_STATUS[child.phase] ?? "unknown",
      startedAt: null,
      completedAt: null,
      progress: child.activity.trim() || null,
      lastOutputAtMs: null,
      errorReason: null,
      subagentId: null,
      stopThreadId: null,
      childThreadId: child.threadId,
    }));
}

export interface BackgroundWorkSectionModel {
  readonly active: ReadonlyArray<BackgroundWorkRowInput>;
  /** Finished rows kept for the session, newest end first. */
  readonly completed: ReadonlyArray<BackgroundWorkRowInput>;
  /** Finished rows past the cap; counted but not rendered. */
  readonly droppedCompleted: number;
}

function byRecency(left: BackgroundWorkRowInput, right: BackgroundWorkRowInput): number {
  return Date.parse(right.completedAt ?? "") - Date.parse(left.completedAt ?? "");
}

/** Splits the gathered rows into the scrolling active list and the collapsed finished list. */
export function presentBackgroundWorkSection(
  rows: ReadonlyArray<BackgroundWorkRowInput>,
): BackgroundWorkSectionModel {
  const active = rows.filter((row) => isActiveBackgroundWork(row.status));
  const finished = rows.filter((row) => !isActiveBackgroundWork(row.status)).sort(byRecency);
  return {
    active,
    completed: finished.slice(0, BACKGROUND_WORK_COMPLETED_CAP),
    droppedCompleted: Math.max(0, finished.length - BACKGROUND_WORK_COMPLETED_CAP),
  };
}
