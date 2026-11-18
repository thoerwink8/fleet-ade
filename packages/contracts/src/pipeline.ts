import * as Schema from "effect/Schema";

/** One active run per issue until it is merged or a person cancels and closes it out. */
export const PIPELINE_RUN_STATUSES = [
  "claimed",
  "session",
  "pr-open",
  "checks",
  "verify",
  "mergeable",
  "merged",
  "stuck",
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

export const PIPELINE_STUCK_REASONS = [
  "会话失败",
  "检查红",
  "超时",
  "超预算",
  "冷验收不过",
  "冷验收没验成",
  "交人",
  "取消",
  "没配模型",
  "候选用尽",
] as const;
export type PipelineStuckReason = (typeof PIPELINE_STUCK_REASONS)[number];

/** Shown next to a run's cost so it is not read as a cash bill. */
export const PIPELINE_COST_LABEL = "折算";

/** Stored when a usage export cannot be read. Never a stand-in for zero. */
export const PIPELINE_USAGE_UNREADABLE = "读不到";

/** Stored when a commit count or a CI queue could not be read. Never a stand-in for zero. */
export const PIPELINE_METRIC_UNREAD = "没查成";

const NullableText = Schema.NullOr(Schema.String);
const NullableInt = Schema.NullOr(Schema.Int);

export const PipelineRun = Schema.Struct({
  id: Schema.Int,
  repository: Schema.String,
  issueNumber: Schema.Int,
  title: Schema.String,
  status: Schema.Literals(PIPELINE_RUN_STATUSES),
  stuckReason: Schema.NullOr(Schema.Literals(PIPELINE_STUCK_REASONS)),
  notifyNote: Schema.NullOr(Schema.String),
  threadId: NullableText,
  controllerThreadId: NullableText,
  acceptedHeadSha: NullableText,
  controllerVerdict: Schema.NullOr(Schema.Literals(["accepted", "rejected"])),
  prNumber: NullableInt,
  headSha: NullableText,
  updatedAt: Schema.String,
  sessionStartedAt: NullableText,
  sessionEndedAt: NullableText,
  modelAccount: NullableText,
  inputTokens: NullableInt,
  outputTokens: NullableInt,
  cacheTokens: NullableInt,
  convertedCost: Schema.NullOr(Schema.Number),
  usageNote: Schema.NullOr(Schema.Literal(PIPELINE_USAGE_UNREADABLE)),
  commitCount: NullableInt,
  commitNote: Schema.NullOr(Schema.Literal(PIPELINE_METRIC_UNREAD)),
  ciQueueMs: NullableInt,
  ciQueueNote: Schema.NullOr(Schema.Literal(PIPELINE_METRIC_UNREAD)),
  detail: NullableText,
  /** True after this run has used its one automatic retry. */
  renewedOnce: Schema.Boolean,
  costLabel: Schema.Literal(PIPELINE_COST_LABEL),
});
export type PipelineRun = typeof PipelineRun.Type;

export const PipelineRunSummary = Schema.Struct({
  recent: Schema.Int,
  reworkRate: Schema.NullOr(Schema.Number),
  averageDurationMs: Schema.NullOr(Schema.Number),
  averageConvertedCost: Schema.NullOr(Schema.Number),
  costLabel: Schema.Literal(PIPELINE_COST_LABEL),
});
export type PipelineRunSummary = typeof PipelineRunSummary.Type;

export const PipelineTick = Schema.Struct({
  at: Schema.String,
  outcome: Schema.Literals(["ok", "failed"]),
  detail: NullableText,
});
export type PipelineTick = typeof PipelineTick.Type;

export const PipelineRunList = Schema.Struct({
  runs: Schema.Array(PipelineRun),
  summary: PipelineRunSummary,
  lastTick: Schema.NullOr(PipelineTick),
  costLabel: Schema.Literal(PIPELINE_COST_LABEL),
});
export type PipelineRunList = typeof PipelineRunList.Type;

export class PipelineRunsError extends Schema.TaggedError<PipelineRunsError>()(
  "PipelineRunsError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Pipeline runs could not be read.";
  }
}
