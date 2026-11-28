import type {
  NodeId,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import {
  canStopSubagent,
  canStopSubagentWorkflow,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import * as DateTime from "effect/DateTime";

/**
 * Background-work section rows from subagents, provider commands, and child sessions.
 * Only formats existing fields; never fetches or guesses silence without a real output timestamp.
 */

/** Active (and visible failed) rows beyond this scroll inside the section instead of growing the column. */
export const BACKGROUND_WORK_SCROLL_AFTER = 6;
/** Finished rows kept for the session, newest first; older ones leave the section. */
export const BACKGROUND_WORK_COMPLETED_CAP = 20;
/** The second line names a silence only once it passes this. */
export const BACKGROUND_WORK_SILENCE_AFTER_MS = 5 * 60 * 1000;

const ACTIVE_STATUSES: Readonly<Record<string, true>> = {
  pending: true,
  running: true,
  waiting: true,
  needs_approval: true,
  needs_answer: true,
};

export type BackgroundWorkSource = "subagent" | "command" | "child";

export type BackgroundWorkStopTarget =
  | { readonly kind: "subagent"; readonly threadId: ThreadId; readonly subagentId: NodeId }
  | { readonly kind: "workflow"; readonly threadId: ThreadId; readonly subagentId: NodeId };

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
  /** Target for the Stop button, or null when the contract cannot stop this row individually. */
  readonly stop: BackgroundWorkStopTarget | null;
  /** The child session a row click opens when one exists. */
  readonly childThreadId: ThreadId | null;
}

export interface BackgroundWorkStatusWord {
  readonly label: string;
  /** The failure mark: the type icon and the word both read as the failure colour. */
  readonly failed: boolean;
}

const STATUS_WORDS: Readonly<Record<string, BackgroundWorkStatusWord>> = {
  pending: { label: "等空位", failed: false },
  running: { label: "运行中", failed: false },
  waiting: { label: "等空位", failed: false },
  needs_approval: { label: "等你批准", failed: false },
  needs_answer: { label: "等你回答", failed: false },
  completed: { label: "已完成", failed: false },
  failed: { label: "出错了", failed: true },
  cancelled: { label: "已停止", failed: false },
  interrupted: { label: "已停止", failed: false },
};

export function backgroundWorkStatusWord(status: string): BackgroundWorkStatusWord {
  return STATUS_WORDS[status] ?? { label: "空闲", failed: false };
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
 * last-output time; the silence line stays off rather than guessed. Stop eligibility matches
 * `ThreadRelationshipsControl` (Codex native subagents cannot be stopped; workflows use `stopWorkflow`).
 */
export function backgroundWorkRowsFromSubagents(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  options?: { readonly canOperateWorkflow?: boolean },
): ReadonlyArray<BackgroundWorkRowInput> {
  const canOperateWorkflow = options?.canOperateWorkflow ?? false;
  return subagents.map((subagent) => {
    // A failed row reads its reason instead of the last progress, so the reason is what the
    // second line can mark.
    const failed = subagent.status === "failed";
    const resultText = subagent.result?.trim() || null;
    let stop: BackgroundWorkStopTarget | null = null;
    if (subagent.workflow !== undefined) {
      if (
        canStopSubagentWorkflow({
          canOperateWorkflow,
          workflowStatus: subagent.status,
          origin: subagent.origin,
          driver: subagent.driver,
        })
      ) {
        stop = { kind: "workflow", threadId: subagent.threadId, subagentId: subagent.id };
      }
    } else if (
      canStopSubagent({
        origin: subagent.origin,
        driver: subagent.driver,
        runId: subagent.runId,
        nativeTaskRef: subagent.nativeTaskRef,
        nativeStatus: subagent.status,
        status: subagent.status,
        startedAt: subagent.startedAt,
      })
    ) {
      stop = { kind: "subagent", threadId: subagent.threadId, subagentId: subagent.id };
    }
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
      stop,
      childThreadId: subagent.childThreadId,
    };
  });
}

/**
 * Command rows from the provider thread's background roster, pending and already finished.
 * Contracts carry no per-command stop RPC and no last-output timestamp (output streams on expand
 * without chunk timestamps), so both stay `null` rather than targeting the main turn or guessing.
 */
export function backgroundWorkRowsFromCommands(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  sessionDriver: ProviderDriverKind | null,
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
      driver: sessionDriver,
      status: task.status ?? "running",
      startedAt: isoOrNull(task.startedAt),
      completedAt: isoOrNull(task.completedAt),
      progress: null,
      lastOutputAtMs: null,
      errorReason: null,
      stop: null,
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
  readonly needsYou?: boolean;
  readonly reason?: string;
}

function childPhaseStatus(child: BackgroundWorkChildSession): string {
  if (child.phase === "在做") return "running";
  if (child.phase === "做完") return "completed";
  if (child.phase === "卡住") {
    if (child.needsYou) {
      return child.reason?.startsWith("等你批准") ? "needs_approval" : "needs_answer";
    }
    return "waiting";
  }
  return "unknown";
}

/**
 * Child sessions the two rosters above do not already show. A child that is itself a subagent is
 * one row, not two. The summary keeps no per-row output stamp, so the silence line stays off.
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
      status: childPhaseStatus(child),
      startedAt: null,
      completedAt: null,
      progress: child.activity.trim() || null,
      lastOutputAtMs: null,
      errorReason: null,
      stop: null,
      childThreadId: child.threadId,
    }));
}

export interface BackgroundWorkSectionModel {
  readonly active: ReadonlyArray<BackgroundWorkRowInput>;
  /** Errored rows stay uncollapsed in the main list so failures remain visible immediately. */
  readonly failed: ReadonlyArray<BackgroundWorkRowInput>;
  /** Non-failed finished rows kept for the session, newest end first. */
  readonly completed: ReadonlyArray<BackgroundWorkRowInput>;
  /** Finished rows past the cap; counted but not rendered. */
  readonly droppedCompleted: number;
}

function byRecency(left: BackgroundWorkRowInput, right: BackgroundWorkRowInput): number {
  return Date.parse(right.completedAt ?? "") - Date.parse(left.completedAt ?? "");
}

/** Splits the gathered rows into active, uncollapsed failed, and collapsed finished lists. */
export function presentBackgroundWorkSection(
  rows: ReadonlyArray<BackgroundWorkRowInput>,
): BackgroundWorkSectionModel {
  const active = rows.filter((row) => isActiveBackgroundWork(row.status));
  const failed = rows.filter((row) => row.status === "failed").sort(byRecency);
  const finished = rows
    .filter((row) => !isActiveBackgroundWork(row.status) && row.status !== "failed")
    .sort(byRecency);
  return {
    active,
    failed,
    completed: finished.slice(0, BACKGROUND_WORK_COMPLETED_CAP),
    droppedCompleted: Math.max(0, finished.length - BACKGROUND_WORK_COMPLETED_CAP),
  };
}
