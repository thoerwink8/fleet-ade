import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Three phases only. Finer causes stay in `reason`, not in this enum. */
export const ChildSummaryPhase = Schema.Literals(["在做", "卡住", "做完"]);
export type ChildSummaryPhase = typeof ChildSummaryPhase.Type;

/**
 * Set only when `phase` is 做完. A failed lookup is 合并状态未知, never 等验收 or 已合并.
 * 没有 PR is a conclusion, not a stuck phase.
 */
export const ChildSummaryConclusion = Schema.Literals([
  "已合并",
  "等验收",
  "PR 已关闭",
  "没有 PR",
  "已取消",
  "合并状态未知",
]);
export type ChildSummaryConclusion = typeof ChildSummaryConclusion.Type;

export const CHILD_SUMMARY_PAGE_SIZE = 50;
export const CHILD_SUMMARY_IDLE_MS = 3 * 60 * 1000;
export const CHILD_SUMMARY_PUSH_MS = 2_000;
export const CHILD_SUMMARY_LINE_LIMIT = 80;
export const CHILD_SUMMARY_GOAL_LIMIT = 200;

const ChildSummaryFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type ChildSummaryFile = typeof ChildSummaryFile.Type;

/** The row the bar, the phone, and `t3_command_children` share. No transcript and no diff. */
export const ChildSummaryListItem = Schema.Struct({
  threadId: ThreadId,
  parentThreadId: ThreadId,
  revision: PositiveInt,
  phase: ChildSummaryPhase,
  reason: Schema.String,
  conclusion: Schema.NullOr(ChildSummaryConclusion),
  needsYou: Schema.Boolean,
  activity: Schema.String,
  goalSummary: Schema.String,
  grandchildCount: NonNegativeInt,
  /** Set when this child itself delegated. Grandchildren are not separate rows. */
  grandchildNote: Schema.NullOr(Schema.String),
  createdAtMs: NonNegativeInt,
  updatedAt: Schema.String,
  /** Present when this child runs in a linked remote environment. */
  environmentId: Schema.optional(EnvironmentId),
  environmentLabel: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  repo: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  commit: Schema.optional(Schema.NullOr(Schema.String)),
  stale: Schema.optional(Schema.Boolean),
  staleReason: Schema.optional(Schema.String),
});
export type ChildSummaryListItem = typeof ChildSummaryListItem.Type;

/** Hover payload. CommandAssist fills `outlook`; null while the row is off, the call failed, or nothing ran yet. */
export const ChildSummaryDetail = Schema.Struct({
  ...ChildSummaryListItem.fields,
  goal: Schema.String,
  avoid: Schema.String,
  files: Schema.Array(ChildSummaryFile).check(Schema.isMaxLength(5)),
  latestCommand: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  prNumber: Schema.NullOr(PositiveInt),
  outlook: Schema.NullOr(Schema.String),
  /** Written by hand-back. Null until that check runs. */
  handback: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type ChildSummaryDetail = typeof ChildSummaryDetail.Type;

export const CommandChildrenInput = Schema.Struct({
  threadId: ThreadId,
  cursor: Schema.optional(Schema.String),
});
export type CommandChildrenInput = typeof CommandChildrenInput.Type;

export const CommandChildrenPage = Schema.Struct({
  children: Schema.Array(ChildSummaryListItem),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CommandChildrenPage = typeof CommandChildrenPage.Type;
/** Stream payload: the initial snapshot replays as `upsert`s; `deleted` removes a row. */
export const ChildSummaryStreamEvent = Schema.Union([
  Schema.TaggedStruct("upsert", { row: ChildSummaryListItem }),
  Schema.TaggedStruct("deleted", { threadId: ThreadId, parentThreadId: ThreadId }),
]);
export type ChildSummaryStreamEvent = typeof ChildSummaryStreamEvent.Type;

export const CommandChildDetailInput = Schema.Struct({
  threadId: ThreadId,
});
export type CommandChildDetailInput = typeof CommandChildDetailInput.Type;

export class ChildSummaryReadError extends Schema.TaggedError<ChildSummaryReadError>()(
  "ChildSummaryReadError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not read child session rows.";
  }
}

export class ChildSummaryCursorError extends Schema.TaggedError<ChildSummaryCursorError>()(
  "ChildSummaryCursorError",
  {},
) {
  override get message(): string {
    return "Child summary cursor is not valid.";
  }
}
