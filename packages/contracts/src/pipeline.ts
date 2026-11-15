import * as Schema from "effect/Schema";

/** Statuses a pipeline run can be in. Later steps fill these; the set does not grow. */
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
export const PipelineRunStatus = Schema.Literals(PIPELINE_RUN_STATUSES);
export type PipelineRunStatus = typeof PipelineRunStatus.Type;

/** The only stuck reasons. Wording is already Chinese; the page does not translate it. */
export const PIPELINE_STUCK_REASONS = [
  "会话失败",
  "检查红",
  "超时",
  "超预算",
  "冷验收不过",
  "交人",
  "取消",
  "没配模型",
] as const;
export const PipelineStuckReason = Schema.Literals(PIPELINE_STUCK_REASONS);
export type PipelineStuckReason = typeof PipelineStuckReason.Type;

/** `absent` has no session window yet. `unread` means magpie usage could not be read. */
const PIPELINE_USAGE_STATES = ["absent", "unread", "read"] as const;
export const PipelineUsageState = Schema.Literals(PIPELINE_USAGE_STATES);
export type PipelineUsageState = typeof PipelineUsageState.Type;

/** Shown beside every cost figure. This is a converted estimate, not a cash bill. */
export const PIPELINE_COST_LABEL = "折算" as const;

/** Written on a run when magpie usage could not be read. Never a zero. */
export const PIPELINE_USAGE_UNREAD = "读不到" as const;

/** How many recent runs the cost summary covers. */
export const PIPELINE_RECENT_RUNS = 20;

export const PipelineRun = Schema.Struct({
  id: Schema.Int,
  repository: Schema.String,
  issueNumber: Schema.Int,
  title: Schema.String,
  status: PipelineRunStatus,
  stuckReason: Schema.NullOr(PipelineStuckReason),
  threadId: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(Schema.Int),
  headSha: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  sessionStartedAt: Schema.NullOr(Schema.String),
  sessionEndedAt: Schema.NullOr(Schema.String),
  magpieAccount: Schema.NullOr(Schema.String),
  usageState: PipelineUsageState,
  /** Present only when usage was unreadable. */
  usageNote: Schema.NullOr(Schema.Literal(PIPELINE_USAGE_UNREAD)),
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  cacheTokens: Schema.NullOr(Schema.Int),
  /** Decimal string. Present only when usage was read. Labeled `costLabel`, not a bill. */
  convertedCost: Schema.NullOr(Schema.String),
  costLabel: Schema.Literal(PIPELINE_COST_LABEL),
  commitCount: Schema.NullOr(Schema.Int),
  /** Milliseconds from GitHub Actions run creation to the job start. */
  ciQueueMs: Schema.NullOr(Schema.Int),
});
export type PipelineRun = typeof PipelineRun.Type;

export const PipelineTickOutcome = Schema.Literals(["ok", "read-failed"]);
export type PipelineTickOutcome = typeof PipelineTickOutcome.Type;

export const PipelineTick = Schema.Struct({
  at: Schema.String,
  outcome: PipelineTickOutcome,
  detail: Schema.NullOr(Schema.String),
});
export type PipelineTick = typeof PipelineTick.Type;

export const PipelineRunSummary = Schema.Struct({
  /** Rework is a commit count above 2. Null when none of the recent runs have a count. */
  reworkRate: Schema.NullOr(Schema.Number),
  averageDurationMs: Schema.NullOr(Schema.Number),
  averageConvertedCost: Schema.NullOr(Schema.String),
  costLabel: Schema.Literal(PIPELINE_COST_LABEL),
});
export type PipelineRunSummary = typeof PipelineRunSummary.Type;

export const PipelineRunList = Schema.Struct({
  runs: Schema.Array(PipelineRun),
  recent: Schema.Array(PipelineRun),
  summary: PipelineRunSummary,
  lastTick: Schema.NullOr(PipelineTick),
});
export type PipelineRunList = typeof PipelineRunList.Type;

export class PipelineRunReadError extends Schema.TaggedError<PipelineRunReadError>()(
  "PipelineRunReadError",
  { message: Schema.String },
) {}

export class PipelineRunMissing extends Schema.TaggedError<PipelineRunMissing>()(
  "PipelineRunMissing",
  { issueNumber: Schema.Int },
) {}
