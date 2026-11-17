import { describe, expect, it } from "vite-plus/test";
import {
  PIPELINE_COST_LABEL,
  PIPELINE_RUN_STATUSES,
  type PipelineRun,
  type PipelineRunStatus,
} from "@t3tools/contracts";

import {
  formatCiQueue,
  formatCommitCount,
  formatInputTokens,
  formatQueueDuration,
  groupPipelineRuns,
  PIPELINE_STATUS_BADGE,
  PIPELINE_STATUS_LABEL,
} from "./PipelinePage.logic";

function run(patch: Partial<PipelineRun> & Pick<PipelineRun, "id" | "status">): PipelineRun {
  return {
    id: patch.id,
    repository: "acme/demo",
    issueNumber: patch.issueNumber ?? patch.id,
    title: patch.title ?? `单 ${patch.id}`,
    status: patch.status,
    stuckReason: patch.stuckReason ?? null,
    threadId: patch.threadId ?? null,
    prNumber: patch.prNumber ?? null,
    headSha: patch.headSha ?? null,
    updatedAt: patch.updatedAt ?? "2026-11-16T00:00:00.000Z",
    sessionStartedAt: patch.sessionStartedAt ?? null,
    sessionEndedAt: patch.sessionEndedAt ?? null,
    modelAccount: null,
    inputTokens: null,
    outputTokens: null,
    cacheTokens: null,
    convertedCost: null,
    usageNote: null,
    commitCount: null,
    commitNote: null,
    ciQueueMs: null,
    ciQueueNote: null,
    detail: patch.detail ?? null,
    renewedOnce: patch.renewedOnce ?? false,
    costLabel: PIPELINE_COST_LABEL,
  };
}

const ids = (runs: ReadonlyArray<PipelineRun>) => runs.map((item) => item.id);

describe("groupPipelineRuns", () => {
  it("keeps a running run with a pull request in both groups, and keeps stuck out of running", () => {
    const groups = groupPipelineRuns([
      run({ id: 1, status: "session" }),
      run({ id: 2, status: "checks", prNumber: 20 }),
      run({ id: 3, status: "stuck", stuckReason: "检查红", prNumber: 30 }),
      run({ id: 4, status: "merged", prNumber: 40 }),
    ]);

    expect(ids(groups.running)).toEqual([1, 2]);
    expect(ids(groups.stuck)).toEqual([3]);
    expect(groups.stuck[0]?.stuckReason).toBe("检查红");
    expect(ids(groups.recentPullRequests)).toEqual([2, 3, 4]);
  });

  it("treats every non-terminal status as running and ignores a missing pull request number", () => {
    const active = PIPELINE_RUN_STATUSES.filter(
      (status): status is Exclude<PipelineRunStatus, "merged" | "stuck"> =>
        status !== "merged" && status !== "stuck",
    ).map((status, index) => run({ id: index + 1, status }));
    const groups = groupPipelineRuns([
      ...active,
      run({ id: 100, status: "stuck", stuckReason: "交人" }),
    ]);

    expect(ids(groups.running)).toEqual(active.map((item) => item.id));
    expect(ids(groups.stuck)).toEqual([100]);
    expect(groups.recentPullRequests).toEqual([]);
  });

  it("names every status in Chinese without translating the stuck reason", () => {
    expect(PIPELINE_RUN_STATUSES.map((status) => PIPELINE_STATUS_LABEL[status])).toEqual([
      "已接",
      "会话中",
      "已开 PR",
      "检查中",
      "验收中",
      "可合并",
      "已合并",
      "卡住",
    ]);
    expect(PIPELINE_RUN_STATUSES.map((status) => PIPELINE_STATUS_BADGE[status])).toEqual([
      "secondary",
      "info",
      "info",
      "warning",
      "info",
      "success",
      "success",
      "destructive",
    ]);
  });
});

describe("pipeline metric labels", () => {
  it("shows a real zero and 没查成 when the number was not read", () => {
    const unread = run({ id: 1, status: "checks" });
    expect(formatCommitCount(unread)).toBe("没查成");
    expect(formatCiQueue(unread)).toBe("没查成");
    expect(formatInputTokens(unread)).toBe("没查成");
    expect(formatInputTokens({ ...unread, usageNote: "读不到" })).toBe("没查成");
    expect(formatCommitCount({ ...unread, commitCount: 0 })).toBe("0");
    expect(formatCiQueue({ ...unread, ciQueueMs: 0 })).toBe("0 秒");
    expect(formatQueueDuration(90_000)).toBe("1 分 30 秒");
    expect(formatQueueDuration(1_500)).toBe("1.5 秒");
    expect(formatInputTokens({ ...unread, inputTokens: 1200 })).toBe("1200");
    expect(formatCommitCount({ ...unread, commitCount: 4, commitNote: "没查成" })).toBe("没查成");
  });
});
