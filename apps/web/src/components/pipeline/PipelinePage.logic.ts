import type { PipelineRun, PipelineRunStatus } from "@t3tools/contracts";

export interface PipelineGroups {
  readonly running: ReadonlyArray<PipelineRun>;
  readonly stuck: ReadonlyArray<PipelineRun>;
  readonly recentPullRequests: ReadonlyArray<PipelineRun>;
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

/**
 * One list, three views. Stuck runs are not running. A run with a pull request
 * number is listed there even while it is still running.
 */
export function groupPipelineRuns(runs: ReadonlyArray<PipelineRun>): PipelineGroups {
  return {
    running: runs.filter((run) => run.status !== "merged" && run.status !== "stuck"),
    stuck: runs.filter((run) => run.status === "stuck"),
    recentPullRequests: runs.filter((run) => run.prNumber !== null),
  };
}
