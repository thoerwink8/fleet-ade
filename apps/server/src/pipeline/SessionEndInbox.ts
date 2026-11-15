import {
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/** The four terminal words OrchestratorMcpService already maps runs onto. */
export const SESSION_END_STATUSES = ["completed", "failed", "cancelled", "interrupted"] as const;
export type SessionEndStatus = (typeof SESSION_END_STATUSES)[number];

export type HeadLookup = "found" | "unavailable";

export interface SessionEndEntry {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly status: SessionEndStatus;
  readonly endedAt: string;
  /** Present only when the lookup succeeded. Absent means unread, not "no commit". */
  readonly headSha?: string;
  readonly headLookup: HeadLookup;
}

export interface SessionEndConflict {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly keptStatus: SessionEndStatus;
  readonly rejectedStatus: SessionEndStatus;
  readonly endedAt: string;
}

export interface RecordSessionEndResult {
  readonly recorded: boolean;
  readonly conflict: boolean;
}

/** A run's own terminal word, matching OrchestratorMcpService.taskStatusForRun. */
export function sessionEndStatus(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork">,
): SessionEndStatus | undefined {
  const outcome = runOutcome(run);
  switch (outcome) {
    case "completed":
    case "failed":
    case "interrupted":
      return outcome;
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    default:
      return undefined;
  }
}

const SessionEndRow = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  status: Schema.Literals(SESSION_END_STATUSES),
  endedAt: Schema.String,
  headSha: Schema.NullOr(Schema.String),
  headLookup: Schema.Literals(["found", "unavailable"]),
});

const SessionEndConflictRow = Schema.Struct({
  runId: RunId,
  threadId: ThreadId,
  keptStatus: Schema.Literals(SESSION_END_STATUSES),
  rejectedStatus: Schema.Literals(SESSION_END_STATUSES),
  endedAt: Schema.String,
});

interface SessionEndInboxShape {
  /** Writes one row. A repeat of the same status writes nothing; a different status records a conflict. */
  readonly record: (
    entry: SessionEndEntry,
  ) => Effect.Effect<RecordSessionEndResult, SqlError.SqlError>;
  readonly list: Effect.Effect<ReadonlyArray<SessionEndEntry>, SqlError.SqlError>;
  readonly conflicts: Effect.Effect<ReadonlyArray<SessionEndConflict>, SqlError.SqlError>;
  readonly lastSequence: Effect.Effect<number, SqlError.SqlError>;
  readonly noteSequence: (sequence: number) => Effect.Effect<void, SqlError.SqlError>;
}

export class SessionEndInbox extends Context.Service<SessionEndInbox, SessionEndInboxShape>()(
  "t3/pipeline/SessionEndInbox",
) {}

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(SessionEndRow));
const decodeConflicts = Schema.decodeUnknownEffect(Schema.Array(SessionEndConflictRow));

export const layer = Layer.effect(
  SessionEndInbox,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const record: SessionEndInboxShape["record"] = Effect.fn("SessionEndInbox.record")(function* (
      entry: SessionEndEntry,
    ) {
      const inserted = yield* sql<{ readonly runId: string }>`
        INSERT INTO pipeline_session_end_inbox (
          run_id, thread_id, status, ended_at, head_sha, head_lookup
        )
        VALUES (
          ${entry.runId},
          ${entry.threadId},
          ${entry.status},
          ${entry.endedAt},
          ${entry.headSha ?? null},
          ${entry.headLookup}
        )
        ON CONFLICT (run_id) DO NOTHING
        RETURNING run_id AS runId
      `;
      const written = inserted[0];
      if (written !== undefined) return { recorded: true, conflict: false };

      const existing = yield* sql<{ readonly status: string }>`
        SELECT status FROM pipeline_session_end_inbox WHERE run_id = ${entry.runId}
      `;
      const kept = existing[0];
      // The row vanished between the two statements: the write did not land, so this is a failure.
      if (kept === undefined) {
        return yield* new SqlError.SqlError({
          reason: new SqlError.UnknownError({
            cause: `session end row missing for ${entry.runId}`,
          }),
        });
      }
      if (kept.status === entry.status) return { recorded: false, conflict: false };

      yield* sql`
        INSERT INTO pipeline_session_end_conflicts (
          run_id, thread_id, kept_status, rejected_status, ended_at
        )
        VALUES (
          ${entry.runId},
          ${entry.threadId},
          ${kept.status},
          ${entry.status},
          ${entry.endedAt}
        )
        ON CONFLICT (run_id, rejected_status) DO NOTHING
      `;
      return { recorded: false, conflict: true };
    });

    const list: SessionEndInboxShape["list"] = Effect.gen(function* () {
      const rows = yield* sql`
        SELECT thread_id AS threadId, run_id AS runId, status, ended_at AS endedAt,
               head_sha AS headSha, head_lookup AS headLookup
        FROM pipeline_session_end_inbox
        ORDER BY ended_at, run_id
      `;
      const decoded = yield* decodeEntries(rows).pipe(
        Effect.mapError(
          (cause) =>
            new SqlError.SqlError({
              reason: new SqlError.UnknownError({ cause, operation: "decode" }),
            }),
        ),
      );
      return decoded.map((row) =>
        row.headSha === null
          ? {
              threadId: row.threadId,
              runId: row.runId,
              status: row.status,
              endedAt: row.endedAt,
              headLookup: row.headLookup,
            }
          : {
              threadId: row.threadId,
              runId: row.runId,
              status: row.status,
              endedAt: row.endedAt,
              headSha: row.headSha,
              headLookup: row.headLookup,
            },
      );
    }).pipe(Effect.withSpan("SessionEndInbox.list"));

    const conflicts: SessionEndInboxShape["conflicts"] = Effect.gen(function* () {
      const rows = yield* sql`
        SELECT run_id AS runId, thread_id AS threadId, kept_status AS keptStatus,
               rejected_status AS rejectedStatus, ended_at AS endedAt
        FROM pipeline_session_end_conflicts
        ORDER BY id
      `;
      return yield* decodeConflicts(rows).pipe(
        Effect.mapError(
          (cause) =>
            new SqlError.SqlError({
              reason: new SqlError.UnknownError({ cause, operation: "decode" }),
            }),
        ),
      );
    }).pipe(Effect.withSpan("SessionEndInbox.conflicts"));

    const lastSequence: SessionEndInboxShape["lastSequence"] = Effect.gen(function* () {
      const rows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM pipeline_session_end_cursor WHERE id = 1
      `;
      return rows[0]?.sequence ?? 0;
    }).pipe(Effect.withSpan("SessionEndInbox.lastSequence"));

    const noteSequence: SessionEndInboxShape["noteSequence"] = Effect.fn(
      "SessionEndInbox.noteSequence",
    )(function* (sequence: number) {
      yield* sql`
        INSERT INTO pipeline_session_end_cursor (id, sequence) VALUES (1, ${sequence})
        ON CONFLICT (id) DO UPDATE SET sequence = excluded.sequence
        WHERE excluded.sequence > pipeline_session_end_cursor.sequence
      `;
    });

    return SessionEndInbox.of({ record, list, conflicts, lastSequence, noteSequence });
  }),
);

/** Where a run's commits land: its worktree when it has one, otherwise the project root. */
const workspaceForThread = Effect.fn("SessionEndInbox.workspaceForThread")(function* (
  threadId: ThreadId,
) {
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const thread = yield* projection.getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
  if (thread === undefined) return undefined;
  if (thread.worktreePath !== null) return thread.worktreePath;
  const project = yield* projects
    .getById(thread.projectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return Option.getOrUndefined(project)?.workspaceRoot;
});

/** A failed read stays "unavailable"; it is never reported as a workspace with no commit. */
const readHead = Effect.fn("SessionEndInbox.readHead")(function* (cwd: string | undefined) {
  if (cwd === undefined) return { headLookup: "unavailable" as const };
  const git = yield* GitVcsDriver.GitVcsDriver;
  const resolved = yield* git
    .resolveCommit({ cwd, revision: "HEAD" })
    .pipe(Effect.orElseSucceed(() => undefined));
  return resolved === undefined || resolved.commitSha.length === 0
    ? { headLookup: "unavailable" as const }
    : { headLookup: "found" as const, headSha: resolved.commitSha };
});

const recordTerminalRun = Effect.fn("SessionEndInbox.recordTerminalRun")(function* (
  event: Extract<OrchestrationV2StoredEvent["event"], { type: "run.updated" }>,
) {
  const status = sessionEndStatus(event.payload);
  if (status === undefined) return;
  const inbox = yield* SessionEndInbox;
  const head = yield* readHead(yield* workspaceForThread(event.threadId));
  const endedAt = DateTime.formatIso(event.payload.completedAt ?? event.occurredAt);
  yield* inbox.record({
    threadId: event.threadId,
    runId: event.payload.id,
    status,
    endedAt,
    ...head,
  });
});

/**
 * Subscribes to committed `run.updated` events and keeps one row per finished run.
 * Replays only past the last sequence already applied. One failed write is logged
 * and skipped so a bad event does not stop later finishes from being recorded.
 */
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const inbox = yield* SessionEndInbox;
    const afterSequence = yield* inbox.lastSequence;
    yield* forkParked(
      sink.stream({ afterSequence, eventType: "run.updated" }).pipe(
        Stream.runForEach((stored) =>
          Effect.gen(function* () {
            if (
              stored.event.type === "run.updated" &&
              sessionEndStatus(stored.event.payload) !== undefined
            ) {
              const runId = stored.event.payload.id;
              yield* recordTerminalRun(stored.event).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("pipeline.session-end-inbox.record-failed", {
                    threadId: stored.event.threadId,
                    runId,
                    cause,
                  }),
                ),
              );
            }
            yield* inbox.noteSequence(stored.sequence);
          }),
        ),
      ),
    );
  }),
);
