import {
  CHILD_SUMMARY_GOAL_LIMIT,
  CHILD_SUMMARY_LINE_LIMIT,
  CHILD_SUMMARY_IDLE_MS,
  CHILD_SUMMARY_PUSH_MS,
  type ChildSummaryConclusion,
  type ChildSummaryDetail,
  type ChildSummaryFile,
  type ChildSummaryListItem,
  type ChildSummaryPhase,
  ThreadId,
} from "@t3tools/contracts";

const STOPPED_DELEGATE_STATUSES: Readonly<Record<string, true>> = {
  cancelled: true,
  interrupted: true,
  rolled_back: true,
};

const LIVE_STATUSES: Readonly<Record<string, true>> = {
  preparing: true,
  starting: true,
  running: true,
  waiting: true,
  queued: true,
};

export interface SummaryItem {
  readonly type:
    | "file_change"
    | "command_execution"
    | "assistant_message"
    | "file_search"
    | "web_search"
    | "todo_list"
    | "other";
  readonly status: string;
  readonly fileName?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly command?: string;
  readonly text?: string;
  readonly pattern?: string;
  readonly title?: string;
}

/** Newest item first. `activityAtMs` is the last turn-item or runtime-status change, not "now". */
export interface SummaryFacts {
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly createdAtMs: number;
  readonly activityAtMs: number;
  readonly status: string;
  /** Set when a command approval is waiting. Other approvals are not needs-you. */
  readonly approvalCommand: string | null;
  readonly waitingForAnswer: boolean;
  readonly items: readonly SummaryItem[];
  readonly goal: string | null;
  readonly taskText: string | null;
  readonly branch: string | null;
  readonly pr: {
    readonly number: number;
    readonly state: "open" | "closed" | "merged" | "unknown";
  } | null;
  readonly grandchildCount: number;
}

export interface DerivedChildSummary {
  readonly list: Omit<ChildSummaryListItem, "revision" | "updatedAt">;
  readonly detail: Omit<ChildSummaryDetail, "revision" | "updatedAt">;
  readonly idleEligible: boolean;
}

function clip(text: string, limit: number): string {
  const line = text.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return Array.from(line).slice(0, limit).join("");
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/u);
  return parts[parts.length - 1] || path;
}

function goalText(facts: SummaryFacts): string {
  const source = facts.goal?.trim() || facts.taskText?.trim() || "";
  return Array.from(source).slice(0, 1000).join("");
}

function activityFromItems(facts: SummaryFacts): string {
  for (const item of facts.items) {
    switch (item.type) {
      case "file_change":
        return `在改 ${baseName(item.fileName ?? "")}`;
      case "command_execution":
        return `在跑 ${clip(item.command ?? "", CHILD_SUMMARY_LINE_LIMIT)}`;
      case "assistant_message": {
        const line = clip(item.text ?? "", CHILD_SUMMARY_LINE_LIMIT);
        return line.length > 0 ? line : "在写回复";
      }
      case "file_search":
        return item.pattern ? `在查 ${clip(item.pattern, CHILD_SUMMARY_LINE_LIMIT)}` : "在查代码";
      case "web_search":
        return item.pattern ? `在查 ${clip(item.pattern, CHILD_SUMMARY_LINE_LIMIT)}` : "在查网页";
      case "todo_list":
        return item.title ? `在做 ${clip(item.title, CHILD_SUMMARY_LINE_LIMIT)}` : "在做计划";
      default:
        break;
    }
  }
  return "正在启动";
}

function filesOf(items: readonly SummaryItem[]): ChildSummaryFile[] {
  const byPath = new Map<string, { additions: number; deletions: number; order: number }>();
  items.forEach((item, index) => {
    if (item.type !== "file_change" || item.fileName === undefined || item.fileName.length === 0) {
      return;
    }
    const previous = byPath.get(item.fileName);
    byPath.set(item.fileName, {
      additions: (previous?.additions ?? 0) + (item.additions ?? 0),
      deletions: (previous?.deletions ?? 0) + (item.deletions ?? 0),
      order: previous?.order ?? index,
    });
  });
  return [...byPath.entries()]
    .sort((left, right) => left[1].order - right[1].order)
    .slice(0, 5)
    .map(([path, stat]) => ({
      path,
      additions: stat.additions,
      deletions: stat.deletions,
    }));
}

function latestCommand(items: readonly SummaryItem[]): string | null {
  const command = items.find((item) => item.type === "command_execution");
  if (command?.command === undefined) return null;
  const line = clip(command.command, CHILD_SUMMARY_LINE_LIMIT);
  return line.length > 0 ? line : null;
}

function doneConclusion(facts: SummaryFacts): {
  readonly conclusion: ChildSummaryConclusion;
  readonly reason: string;
} {
  if (facts.pr === null) return { conclusion: "没有 PR", reason: "没有 PR" };
  switch (facts.pr.state) {
    case "merged":
      return { conclusion: "已合并", reason: "已合并" };
    case "open":
      return { conclusion: "等验收", reason: "等验收" };
    case "closed":
      return { conclusion: "PR 已关闭", reason: "PR 已关闭" };
    default:
      return { conclusion: "合并状态未知", reason: "合并状态未知" };
  }
}

function unfinishedCommand(facts: SummaryFacts): boolean {
  const newest = facts.items.find((item) => item.type === "command_execution");
  return (
    newest !== undefined &&
    facts.items[0]?.type === "command_execution" &&
    (newest.status === "running" || newest.status === "pending")
  );
}

export function deriveChildSummary(facts: SummaryFacts, nowMs: number): DerivedChildSummary {
  const goal = goalText(facts);
  const goalSummary = Array.from(goal).slice(0, CHILD_SUMMARY_GOAL_LIMIT).join("");
  const grandchildNote = facts.grandchildCount > 0 ? `它还派了 ${facts.grandchildCount} 个` : null;
  const files = filesOf(facts.items);
  const command = latestCommand(facts.items);
  let phase: ChildSummaryPhase = "在做";
  let reason = "在跑";
  let conclusion: ChildSummaryConclusion | null = null;
  let needsYou = false;
  let activity = activityFromItems(facts);

  if (facts.status === "failed") {
    phase = "卡住";
    reason = "失败";
    activity = "失败";
  } else if (
    facts.status === "cancelled" ||
    facts.status === "interrupted" ||
    facts.status === "rolled_back"
  ) {
    phase = "做完";
    conclusion = "已取消";
    reason = "已取消";
    activity = "已取消";
  } else if (facts.status === "completed") {
    const done = doneConclusion(facts);
    phase = "做完";
    conclusion = done.conclusion;
    reason = done.reason;
    activity = done.reason;
  } else if (facts.approvalCommand !== null) {
    phase = "卡住";
    const line = clip(facts.approvalCommand, CHILD_SUMMARY_LINE_LIMIT);
    reason = `等你批准：${line}`;
    activity = reason;
    needsYou = true;
  } else if (facts.status === "queued") {
    reason = "排队中";
    activity = facts.items.length === 0 ? "正在启动" : activity;
  } else if (facts.waitingForAnswer) {
    reason = "在等你回答";
    activity = "在等你回答";
  }

  const idleEligible =
    phase === "在做" &&
    facts.status !== "queued" &&
    facts.approvalCommand === null &&
    !facts.waitingForAnswer &&
    !unfinishedCommand(facts) &&
    LIVE_STATUSES[facts.status] === true;

  if (idleEligible && nowMs - facts.activityAtMs >= CHILD_SUMMARY_IDLE_MS) {
    phase = "卡住";
    reason = "没动静";
  }

  const list = {
    threadId: facts.threadId,
    parentThreadId: facts.parentThreadId,
    phase,
    reason,
    conclusion,
    needsYou,
    activity,
    goalSummary,
    grandchildCount: facts.grandchildCount,
    grandchildNote,
    createdAtMs: facts.createdAtMs,
  };
  return {
    list,
    detail: {
      ...list,
      goal,
      avoid: "没有写别碰",
      files,
      latestCommand: command,
      branch: facts.branch,
      prNumber: facts.pr?.number ?? null,
      outlook: null,
    },
    idleEligible: idleEligible && phase === "在做",
  };
}

function sameSummary(
  left: Pick<
    ChildSummaryListItem,
    | "phase"
    | "reason"
    | "conclusion"
    | "needsYou"
    | "activity"
    | "goalSummary"
    | "grandchildNote"
    | "grandchildCount"
    | "revision"
  >,
  right: typeof left,
): boolean {
  return (
    left.phase === right.phase &&
    left.reason === right.reason &&
    left.conclusion === right.conclusion &&
    left.needsYou === right.needsYou &&
    left.activity === right.activity &&
    left.goalSummary === right.goalSummary &&
    left.grandchildNote === right.grandchildNote &&
    left.grandchildCount === right.grandchildCount &&
    left.revision === right.revision
  );
}

export interface PushLane {
  readonly last: ChildSummaryListItem | null;
  readonly pending: ChildSummaryListItem | null;
  readonly dueAtMs: number | null;
}

export const emptyPushLane: PushLane = { last: null, pending: null, dueAtMs: null };

function isUrgent(last: ChildSummaryListItem, row: ChildSummaryListItem): boolean {
  return (
    (row.phase === "卡住" && last.phase !== "卡住") ||
    (row.phase === "做完" && last.phase !== "做完") ||
    row.needsYou !== last.needsYou
  );
}

export function offerPush(
  lane: PushLane,
  row: ChildSummaryListItem,
  nowMs: number,
): {
  readonly lane: PushLane;
  readonly emit: ChildSummaryListItem | null;
  readonly armMs: number | null;
} {
  if (lane.pending === null && lane.last !== null && sameSummary(lane.last, row)) {
    return { lane, emit: null, armMs: null };
  }
  if (lane.pending !== null && sameSummary(lane.pending, row)) {
    return { lane, emit: null, armMs: null };
  }
  if (lane.last === null || isUrgent(lane.last, row)) {
    return { lane: { last: row, pending: null, dueAtMs: null }, emit: row, armMs: null };
  }
  const dueAtMs = lane.dueAtMs ?? nowMs + CHILD_SUMMARY_PUSH_MS;
  return {
    lane: { last: lane.last, pending: row, dueAtMs },
    emit: null,
    armMs: lane.dueAtMs === null ? CHILD_SUMMARY_PUSH_MS : null,
  };
}

export function flushPush(
  lane: PushLane,
  nowMs: number,
): { readonly lane: PushLane; readonly emit: ChildSummaryListItem | null } {
  if (lane.pending === null || lane.dueAtMs === null || nowMs < lane.dueAtMs) {
    return { lane, emit: null };
  }
  return { lane: { last: lane.pending, pending: null, dueAtMs: null }, emit: lane.pending };
}

export function childSummaryCursor(row: {
  readonly createdAtMs: number;
  readonly threadId: string;
}): string {
  return `${row.createdAtMs}\n${row.threadId}`;
}

export function parseChildSummaryCursor(
  cursor: string,
): { readonly createdAtMs: number; readonly threadId: string } | null {
  const split = cursor.indexOf("\n");
  if (split <= 0) return null;
  const createdAtMs = Number(cursor.slice(0, split));
  const threadId = cursor.slice(split + 1);
  if (!Number.isInteger(createdAtMs) || createdAtMs < 0 || threadId.length === 0) return null;
  return { createdAtMs, threadId };
}

export function isDelegateTaskChild(thread: {
  readonly lineage: { readonly relationshipToParent: string | null };
  readonly creationSource: string;
  readonly delegatedFrom?: unknown;
}): boolean {
  if (thread.delegatedFrom != null) return true;
  return thread.lineage.relationshipToParent === "subagent" && thread.creationSource !== "provider";
}

/** Undefined means the existing send may proceed. A stopped delegate cannot be restarted here. */
export function delegateCorrectionRefusal(thread: {
  readonly lineage: { readonly relationshipToParent: string | null };
  readonly creationSource: string;
  readonly delegatedFrom?: unknown;
  readonly status: string;
}): string | undefined {
  if (!isDelegateTaskChild(thread)) return undefined;
  return STOPPED_DELEGATE_STATUSES[thread.status] === true ? "这条已经停了" : undefined;
}

/** Drops diff and command output. Newest-first payloads become one summary item. */
export function toSummaryItem(payload: {
  readonly type?: unknown;
  readonly status?: unknown;
  readonly fileName?: unknown;
  readonly additions?: unknown;
  readonly deletions?: unknown;
  readonly input?: unknown;
  readonly text?: unknown;
  readonly pattern?: unknown;
  readonly patterns?: unknown;
  readonly title?: unknown;
  readonly diffStr?: unknown;
  readonly output?: unknown;
}): SummaryItem {
  const status = typeof payload.status === "string" ? payload.status : "";
  switch (payload.type) {
    case "file_change":
      return {
        type: "file_change",
        status,
        ...(typeof payload.fileName === "string" ? { fileName: payload.fileName } : {}),
        ...(typeof payload.additions === "number" ? { additions: payload.additions } : {}),
        ...(typeof payload.deletions === "number" ? { deletions: payload.deletions } : {}),
      };
    case "command_execution":
      return {
        type: "command_execution",
        status,
        ...(typeof payload.input === "string" ? { command: payload.input } : {}),
      };
    case "assistant_message":
      return {
        type: "assistant_message",
        status,
        ...(typeof payload.text === "string" ? { text: payload.text } : {}),
      };
    case "file_search":
      return {
        type: "file_search",
        status,
        ...(typeof payload.pattern === "string" ? { pattern: payload.pattern } : {}),
      };
    case "web_search": {
      const pattern = Array.isArray(payload.patterns) ? payload.patterns[0] : payload.pattern;
      return {
        type: "web_search",
        status,
        ...(typeof pattern === "string" ? { pattern } : {}),
      };
    }
    case "todo_list":
      return {
        type: "todo_list",
        status,
        ...(typeof payload.title === "string" ? { title: payload.title } : {}),
      };
    default:
      return { type: "other", status };
  }
}
