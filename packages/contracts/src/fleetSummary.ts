import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Snapshot pages stay at or under this many rows. */
export const FLEET_SUMMARY_PAGE_SIZE = 200;

/** Change log kept for resume. Older cursors must resync. */
export const FLEET_SUMMARY_RETENTION = 1000;

/** Last progress is one short line, not a transcript. */
export const FLEET_SUMMARY_PROGRESS_LIMIT = 120;

export const FleetSummaryPhase = Schema.Literals(["working", "stuck", "done"]);
export type FleetSummaryPhase = typeof FleetSummaryPhase.Type;

/**
 * The executor's own session run. Phase is this mapping, never a lease timeout.
 * `waiting` is stuck; terminal runs are done; everything else is still working.
 */
export const FleetSummarySessionRun = Schema.Literals([
  "idle",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
export type FleetSummarySessionRun = typeof FleetSummarySessionRun.Type;

export const phaseFromSessionRun = (run: FleetSummarySessionRun): FleetSummaryPhase => {
  switch (run) {
    case "completed":
    case "interrupted":
    case "failed":
    case "cancelled":
    case "rolled_back":
      return "done";
    case "waiting":
      return "stuck";
    default:
      return "working";
  }
};

export const FleetSummaryRow = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  repo: Schema.optional(TrimmedNonEmptyString),
  issue: Schema.optional(PositiveInt),
  taskId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
  title: Schema.String,
  phase: FleetSummaryPhase,
  reason: Schema.String,
  needsYou: Schema.Boolean,
  lastProgress: Schema.String,
  updatedAt: Schema.String,
  stale: Schema.Boolean,
  staleReason: Schema.optional(Schema.String),
  revision: NonNegativeInt,
});
export type FleetSummaryRow = typeof FleetSummaryRow.Type;

export const FleetSummaryTombstoneKey = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  repo: Schema.optional(TrimmedNonEmptyString),
  issue: Schema.optional(PositiveInt),
  taskId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
});
export type FleetSummaryTombstoneKey = typeof FleetSummaryTombstoneKey.Type;

const reportFields = {
  title: Schema.String,
  sessionRun: FleetSummarySessionRun,
  reason: Schema.String,
  needsYou: Schema.Boolean,
  lastProgress: Schema.String,
};

export const FleetSummaryUpsertTask = Schema.Struct({
  type: Schema.Literal("upsert-task"),
  repo: TrimmedNonEmptyString,
  issue: PositiveInt,
  taskId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  ...reportFields,
});
export type FleetSummaryUpsertTask = typeof FleetSummaryUpsertTask.Type;

export const FleetSummaryUpsertAdhoc = Schema.Struct({
  type: Schema.Literal("upsert-adhoc"),
  threadId: TrimmedNonEmptyString,
  ...reportFields,
});
export type FleetSummaryUpsertAdhoc = typeof FleetSummaryUpsertAdhoc.Type;

export const FleetSummaryDeleteTask = Schema.Struct({
  type: Schema.Literal("delete-task"),
  repo: TrimmedNonEmptyString,
  issue: PositiveInt,
  taskId: TrimmedNonEmptyString,
});
export type FleetSummaryDeleteTask = typeof FleetSummaryDeleteTask.Type;

export const FleetSummaryDeleteAdhoc = Schema.Struct({
  type: Schema.Literal("delete-adhoc"),
  threadId: TrimmedNonEmptyString,
});
export type FleetSummaryDeleteAdhoc = typeof FleetSummaryDeleteAdhoc.Type;

export const FleetSummaryReportInput = Schema.Union([
  FleetSummaryUpsertTask,
  FleetSummaryUpsertAdhoc,
  FleetSummaryDeleteTask,
  FleetSummaryDeleteAdhoc,
]);
export type FleetSummaryReportInput = typeof FleetSummaryReportInput.Type;

export const FleetSummaryWriteResult = Schema.Struct({
  revision: NonNegativeInt,
  changed: Schema.Boolean,
});
export type FleetSummaryWriteResult = typeof FleetSummaryWriteResult.Type;

export const FleetSummarySubscribeInput = Schema.Struct({
  cursor: Schema.optional(NonNegativeInt),
});
export type FleetSummarySubscribeInput = typeof FleetSummarySubscribeInput.Type;

export const FleetSummarySnapshotPage = Schema.Struct({
  type: Schema.Literal("snapshot"),
  revision: NonNegativeInt,
  rows: Schema.Array(FleetSummaryRow),
  page: PositiveInt,
  pageCount: PositiveInt,
});
export type FleetSummarySnapshotPage = typeof FleetSummarySnapshotPage.Type;

export const FleetSummaryUpsertEvent = Schema.Struct({
  type: Schema.Literal("upsert"),
  revision: PositiveInt,
  row: FleetSummaryRow,
});
export type FleetSummaryUpsertEvent = typeof FleetSummaryUpsertEvent.Type;

export const FleetSummaryTombstoneEvent = Schema.Struct({
  type: Schema.Literal("tombstone"),
  revision: PositiveInt,
  key: FleetSummaryTombstoneKey,
});
export type FleetSummaryTombstoneEvent = typeof FleetSummaryTombstoneEvent.Type;

export const FleetSummaryResyncEvent = Schema.Struct({
  type: Schema.Literal("resync"),
  reason: Schema.Literals(["expired", "gap"]),
});
export type FleetSummaryResyncEvent = typeof FleetSummaryResyncEvent.Type;

export const FleetSummaryEvent = Schema.Union([
  FleetSummarySnapshotPage,
  FleetSummaryUpsertEvent,
  FleetSummaryTombstoneEvent,
  FleetSummaryResyncEvent,
]);
export type FleetSummaryEvent = typeof FleetSummaryEvent.Type;

export const FleetSummaryChangeEvent = Schema.Union([
  FleetSummaryUpsertEvent,
  FleetSummaryTombstoneEvent,
]);
export type FleetSummaryChangeEvent = typeof FleetSummaryChangeEvent.Type;

export class FleetSummaryError extends Schema.TaggedError<FleetSummaryError>()(
  "FleetSummaryError",
  {
    reason: Schema.Literals(["storage", "unknown-repo"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
