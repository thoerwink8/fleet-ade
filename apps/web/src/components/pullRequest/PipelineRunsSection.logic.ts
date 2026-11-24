import {
  PIPELINE_METRIC_UNREAD,
  PIPELINE_USAGE_UNREADABLE,
  type PipelineRun,
  type PipelineRunStatus,
} from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";

export type PipelineSection = "needsAction" | "running" | "stuck";

export interface PipelineGroups {
  readonly running: ReadonlyArray<PipelineRun>;
  readonly stuck: ReadonlyArray<PipelineRun>;
}

/** Labels for the status field. Stuck reasons stay the server's own text. */
export const PIPELINE_STATUS_LABEL: Record<PipelineRunStatus, string> = {
  claimed: "已接",
  session: "会话中",
  "pr-open": "已开 PR",
  checks: "检查中",
  verify: "验收中",
  mergeable: "可合并",
  merged: "已合并",
  stuck: "卡住",
};

/** Badge tone for each status. Stuck is the only danger mark. */
export const PIPELINE_STATUS_BADGE = {
  claimed: "secondary",
  session: "info",
  "pr-open": "info",
  checks: "warning",
  verify: "info",
  mergeable: "success",
  merged: "success",
  stuck: "destructive",
} as const satisfies Record<
  PipelineRunStatus,
  "secondary" | "info" | "warning" | "success" | "destructive"
>;

/** Stuck runs need a person; every other non-terminal run is still in flight. */
export function groupPipelineRuns(runs: ReadonlyArray<PipelineRun>): PipelineGroups {
  return {
    running: runs.filter((run) => run.status !== "merged" && run.status !== "stuck"),
    stuck: runs.filter((run) => run.status === "stuck"),
  };
}

/** Whole seconds under a minute, otherwise minutes. Zero stays zero. */
export function formatQueueDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return PIPELINE_METRIC_UNREAD;
  if (ms < 60_000) {
    const tenths = Math.round(ms / 100) / 10;
    const text = Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
    return `${text} 秒`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`;
}

export function formatCommitCount(run: Pick<PipelineRun, "commitCount" | "commitNote">): string {
  if (run.commitNote !== null || run.commitCount === null) return PIPELINE_METRIC_UNREAD;
  return String(run.commitCount);
}

export function formatCiQueue(run: Pick<PipelineRun, "ciQueueMs" | "ciQueueNote">): string {
  if (run.ciQueueNote !== null || run.ciQueueMs === null) return PIPELINE_METRIC_UNREAD;
  return formatQueueDuration(run.ciQueueMs);
}

export function formatInputTokens(run: Pick<PipelineRun, "inputTokens" | "usageNote">): string {
  if (run.usageNote === PIPELINE_USAGE_UNREADABLE || run.inputTokens === null) {
    return PIPELINE_METRIC_UNREAD;
  }
  return formatCount(run.inputTokens);
}

export function pipelineRunElementId(id: number): string {
  return `pipeline-run-${id}`;
}

export function isPipelineRunLink(section: PipelineSection): boolean {
  return section === "stuck";
}
