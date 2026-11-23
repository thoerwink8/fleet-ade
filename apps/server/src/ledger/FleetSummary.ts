import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  FLEET_SUMMARY_PAGE_SIZE,
  FLEET_SUMMARY_PROGRESS_LIMIT,
  FLEET_SUMMARY_RETENTION,
  FleetSummaryChangeEvent,
  FleetSummaryError,
  FleetSummaryEvent,
  FleetSummaryReportInput,
  FleetSummaryResyncEvent,
  FleetSummaryRow,
  FleetSummarySubscribeInput,
  FleetSummaryTombstoneKey,
  FleetSummaryWriteResult,
  phaseFromSessionRun,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as NodeClaims from "./nodeClaims.ts";
import * as NodeReads from "./nodeReads.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LedgerDb from "./LedgerDb.ts";

const isFleetSummaryError = Schema.is(FleetSummaryError);
/** A stalled consumer retains at most the latest change per row. */
const FLEET_SUMMARY_SUBSCRIBER_QUEUE_LIMIT = 200;
const FLEET_SUMMARY_DONE_RETENTION_MS = 24 * 60 * 60 * 1000;
const FLEET_ENVIRONMENT_HEARTBEAT_TTL_MS = 90_000;

interface RowRecord {
  readonly environment_id: string;
  readonly kind: "task" | "adhoc";
  readonly repo: string | null;
  readonly issue: number | null;
  readonly task_id: string | null;
  readonly thread_id: string;
  readonly title: string;
  readonly phase: "working" | "stuck" | "done";
  readonly reason: string;
  readonly needs_you: number;
  readonly last_progress: string;
  readonly branch: string | null;
  readonly commit_sha: string | null;
  readonly updated_at: string;
  readonly stale: number;
  readonly stale_reason: string | null;
  readonly revision: number;
}

interface MetaRecord {
  readonly id: number;
  readonly revision: number;
}

interface ChangeRecord {
  readonly revision: number;
  readonly event_type: "upsert" | "tombstone";
  readonly row_id: string | null;
  readonly payload: string;
}

const decodeChange = Schema.decodeUnknownSync(Schema.fromJsonString(FleetSummaryChangeEvent));

export class FleetSummary extends Context.Service<
  FleetSummary,
  {
    /** The caller is the signed peer session; input never names an environment. */
    readonly report: (
      callerEnvironmentId: string,
      input: FleetSummaryReportInput,
    ) => Effect.Effect<FleetSummaryWriteResult, FleetSummaryError>;
    /** First call returns snapshot pages at revision R, then changes from R+1. */
    readonly subscribe: (
      input: FleetSummarySubscribeInput,
    ) => Effect.Effect<
      Stream.Stream<FleetSummaryEvent, FleetSummaryError, Scope.Scope>,
      FleetSummaryError,
      Scope.Scope
    >;
    /** Task rows without their exact live lease become stale; recovery clears it. */
    readonly sweepStale: Effect.Effect<void, FleetSummaryError>;
    readonly cleanupDone: Effect.Effect<void, FleetSummaryError>;
  }
>()("t3/ledger/FleetSummary") {}

const rowIdOf = (
  environmentId: string,
  input: Pick<FleetSummaryReportInput, "type"> & {
    readonly repo?: string | undefined;
    readonly issue?: number | undefined;
    readonly taskId?: string | undefined;
    readonly threadId?: string | undefined;
  },
) => {
  switch (input.type) {
    case "upsert-task":
    case "delete-task":
      return `task\n${environmentId}\n${input.repo}\n${input.issue}\n${input.taskId}`;
    case "upsert-adhoc":
    case "delete-adhoc":
      return `adhoc\n${environmentId}\n${input.threadId}`;
  }
};

const oneLine = (value: string) => value.replace(/\s+/gu, " ").trim();
const progress = (value: string) => {
  const line = oneLine(value);
  return [...line].slice(0, FLEET_SUMMARY_PROGRESS_LIMIT).join("");
};

const toRow = (record: RowRecord): FleetSummaryRow => ({
  environmentId: record.environment_id,
  ...(record.repo === null ? {} : { repo: record.repo }),
  ...(record.issue === null ? {} : { issue: record.issue }),
  ...(record.task_id === null ? {} : { taskId: record.task_id }),
  threadId: record.thread_id,
  title: record.title,
  phase: record.phase,
  reason: record.reason,
  needsYou: record.needs_you === 1,
  lastProgress: record.last_progress,
  ...(record.branch === null ? {} : { branch: record.branch }),
  ...(record.commit_sha === null ? {} : { commit: record.commit_sha }),
  updatedAt: record.updated_at,
  stale: record.stale === 1,
  ...(record.stale_reason === null ? {} : { staleReason: record.stale_reason }),
  revision: record.revision,
});

const keyOfRow = (row: FleetSummaryRow): FleetSummaryTombstoneKey => ({
  environmentId: row.environmentId,
  ...(row.repo === undefined ? {} : { repo: row.repo }),
  ...(row.issue === undefined ? {} : { issue: row.issue }),
  ...(row.taskId === undefined ? {} : { taskId: row.taskId }),
  ...(row.threadId === undefined ? {} : { threadId: row.threadId }),
});

const sameReported = (current: FleetSummaryRow, next: FleetSummaryRow) =>
  current.repo === next.repo &&
  current.issue === next.issue &&
  current.taskId === next.taskId &&
  current.threadId === next.threadId &&
  current.title === next.title &&
  current.phase === next.phase &&
  current.reason === next.reason &&
  current.needsYou === next.needsYou &&
  current.lastProgress === next.lastProgress &&
  current.branch === next.branch &&
  current.commit === next.commit &&
  current.stale === next.stale &&
  current.staleReason === next.staleReason;

type KeepEnvironments = Effect.Effect<ReadonlySet<string>, FleetSummaryError>;

const storageError = (cause: unknown) =>
  new FleetSummaryError({
    reason: "storage",
    message: "Fleet summary storage is unavailable.",
    cause,
  });

const make = Effect.fn("FleetSummary.make")(function* (keepEnvironments: KeepEnvironments) {
  const sql = yield* SqlClient.SqlClient;
  yield* NodeReads.migrate;
  yield* sql`PRAGMA journal_mode = WAL`;

  const meta = sql<MetaRecord>`SELECT id, revision FROM fleet_summary_meta WHERE id = 1`.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(
            new FleetSummaryError({
              reason: "storage",
              message: "Fleet summary metadata is missing.",
            }),
          )
        : Effect.succeed(rows[0]),
    ),
  );

  const readMeta = meta.pipe(Effect.mapError(storageError));

  const rowById = (rowId: string) =>
    sql<RowRecord>`
      SELECT row_id, environment_id, kind, repo, issue, task_id, thread_id, title, phase,
        reason, needs_you, last_progress, branch, commit_sha, updated_at, stale, stale_reason, revision
      FROM fleet_summary_rows WHERE row_id = ${rowId}
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : toRow(rows[0]))));

  const canonicalRepo = Effect.fn("FleetSummary.canonicalRepo")(function* (repo: string) {
    if (!NodeClaims.REPO.test(repo)) {
      return yield* new FleetSummaryError({
        reason: "unknown-repo",
        message: "The repository is not registered for this environment.",
      });
    }
    const [owner, name] = repo.split("/");
    const rows = yield* sql<{ readonly owner: string; readonly name: string }>`
      SELECT owner, name FROM repos
      WHERE lower(owner) = lower(${owner}) AND lower(name) = lower(${name})
      LIMIT 1
    `.pipe(Effect.mapError(storageError));
    const registered = rows[0];
    if (registered === undefined) {
      return yield* new FleetSummaryError({
        reason: "unknown-repo",
        message: "The repository is not registered for this environment.",
      });
    }
    return `${registered.owner}/${registered.name}`;
  });

  const hub = yield* PubSub.unbounded<FleetSummaryChangeEvent>();
  const publishLock = yield* Semaphore.make(1);
  const publish = (events: ReadonlyArray<FleetSummaryChangeEvent>) =>
    Effect.forEach(events, (event) => PubSub.publish(hub, event), { discard: true });

  /** Snapshot rows and R commit before this stream starts consuming live events. */
  const snapshotPages = Effect.gen(function* () {
    const read = sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* meta;
          const rows = yield* sql<RowRecord>`
            SELECT row_id, environment_id, kind, repo, issue, task_id, thread_id, title, phase,
              reason, needs_you, last_progress, branch, commit_sha, updated_at, stale, stale_reason, revision
            FROM fleet_summary_rows ORDER BY row_id
          `;
          return { revision: current.revision, rows: rows.map(toRow) };
        }),
      )
      .pipe(Effect.mapError(storageError));
    const { revision, rows } = yield* read;
    const pages: Array<FleetSummaryEvent> = [];
    const pageCount = Math.max(1, Math.ceil(rows.length / FLEET_SUMMARY_PAGE_SIZE));
    for (let page = 1; page <= pageCount; page++) {
      pages.push({
        type: "snapshot",
        revision,
        rows: rows.slice((page - 1) * FLEET_SUMMARY_PAGE_SIZE, page * FLEET_SUMMARY_PAGE_SIZE),
        page,
        pageCount,
      });
    }
    return { revision, pages };
  });

  const retainedOldest = sql<{ readonly revision: number }>`
    SELECT revision FROM fleet_summary_changes ORDER BY revision ASC LIMIT 1
  `.pipe(
    Effect.map((rows) => rows[0]?.revision),
    Effect.mapError(storageError),
  );

  const replay = (after: number, through: number) =>
    sql<ChangeRecord>`
      SELECT revision, event_type, row_id, payload FROM fleet_summary_changes
      WHERE revision > ${after} AND revision <= ${through} ORDER BY revision
    `.pipe(
      Effect.map((rows) => rows.map((row) => decodeChange(row.payload))),
      Effect.mapError(storageError),
    );

  /** Slow consumers keep at most the latest 200 changes, then require a full resync. */
  const boundedLive = Effect.fn("FleetSummary.boundedLive")(function* (
    subscription: Stream.Stream<FleetSummaryChangeEvent>,
  ) {
    const signals = yield* Queue.unbounded<void>();
    type LiveEvent = FleetSummaryChangeEvent | FleetSummaryResyncEvent;
    const state = yield* Ref.make<{
      events: Array<LiveEvent>;
      notified: boolean;
      closed: boolean;
    }>({ events: [], notified: false, closed: false });
    yield* Effect.forkScoped(
      Stream.runForEach(subscription, (event) =>
        Ref.modify(state, (current) => {
          if (current.closed) return [false, current] as const;
          const id = event.type === "upsert" ? rowIdOfRow(event.row) : rowIdOfKey(event.key);
          const index = current.events.findIndex(
            (queued) => queued.type !== "resync" && sameRow(queued, id),
          );
          if (index >= 0) {
            const events: Array<LiveEvent> = [
              ...current.events.filter((_, at) => at !== index),
              event,
            ];
            const notify = !current.notified;
            return [notify, { ...current, events, notified: current.notified || notify }] as const;
          }
          if (current.events.length >= FLEET_SUMMARY_SUBSCRIBER_QUEUE_LIMIT) {
            const resync: FleetSummaryResyncEvent = { type: "resync", reason: "gap" };
            const next: { events: Array<LiveEvent>; notified: boolean; closed: boolean } = {
              events: [resync],
              notified: true,
              closed: true,
            };
            return [!current.notified, next] as const;
          }
          const events: Array<LiveEvent> = [...current.events, event];
          const notify = !current.notified;
          return [notify, { ...current, events, notified: current.notified || notify }] as const;
        }).pipe(
          Effect.flatMap((notify) => (notify ? Queue.offer(signals, undefined) : Effect.void)),
        ),
      ),
      { startImmediately: true },
    );
    return Stream.fromQueue(signals).pipe(
      Stream.mapEffect(() =>
        Ref.modify(state, (current) => {
          const [event, ...events] = current.events;
          return [
            { event, more: events.length > 0 },
            { ...current, events, notified: events.length > 0 },
          ] as const;
        }).pipe(
          Effect.flatMap(({ event, more }) =>
            event === undefined
              ? Effect.die("summary queue signal without event")
              : (more ? Queue.offer(signals, undefined) : Effect.void).pipe(Effect.as(event)),
          ),
        ),
      ),
      Stream.takeUntil((event) => event.type === "resync"),
    );
  });

  const subscribe = Effect.fn("FleetSummary.subscribe")(function* (
    input: FleetSummarySubscribeInput,
  ) {
    const subscription = yield* PubSub.subscribe(hub);
    const live = yield* boundedLive(Stream.fromSubscription(subscription));
    const current = (yield* readMeta).revision;
    const after = (revision: number) =>
      live.pipe(Stream.filter((event) => event.type === "resync" || event.revision > revision));
    const cursor = input.cursor;
    if (cursor !== undefined && cursor > current) {
      return Stream.make({ type: "resync", reason: "gap" });
    }
    if (cursor !== undefined && cursor === current) return after(current);

    if (cursor !== undefined && cursor < current) {
      const oldest = yield* retainedOldest;
      if (oldest === undefined || cursor + 1 < oldest) {
        return Stream.make({ type: "resync", reason: "expired" });
      }
      const changes = yield* replay(cursor, current);
      const missing = changes.some((change, index) => change.revision !== cursor + index + 1);
      if (missing || changes.at(-1)?.revision !== current) {
        return Stream.make({ type: "resync", reason: "gap" });
      }
      return Stream.concat(Stream.fromIterable(changes), after(current));
    }

    const snapshot = yield* snapshotPages;
    return Stream.concat(Stream.fromIterable(snapshot.pages), after(snapshot.revision));
  });

  const nextRevision = sql<{ readonly revision: number }>`
    UPDATE fleet_summary_meta SET revision = revision + 1 WHERE id = 1 RETURNING revision
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(
            new FleetSummaryError({
              reason: "storage",
              message: "Fleet summary metadata is missing.",
            }),
          )
        : Effect.succeed(rows[0].revision),
    ),
  );

  const recordChange = (revision: number, event: FleetSummaryChangeEvent) => {
    const payload = JSON.stringify(event);
    return sql`
      INSERT INTO fleet_summary_changes (revision, event_type, row_id, payload)
      VALUES (${revision}, ${event.type}, ${
        event.type === "upsert" ? rowIdOfRow(event.row) : rowIdOfKey(event.key)
      }, ${payload})
    `.pipe(
      Effect.andThen(
        sql`
          DELETE FROM fleet_summary_changes WHERE revision <= (
            SELECT MAX(revision) - ${FLEET_SUMMARY_RETENTION} FROM fleet_summary_changes
          )
        `,
      ),
    );
  };

  // The previous session-lookup migration missed deleted sessions. Run this
  // independently even if it completed; rows for deleted connections are derived
  // data and may be discarded, including completed rows. Keep linked environments.
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS fleet_summary_migrations (name TEXT PRIMARY KEY)`;
        const marker = "remove-unlinked-summary-rows-v2";
        const applied =
          yield* sql`SELECT name FROM fleet_summary_migrations WHERE name = ${marker}`;
        if (applied.length > 0) return;
        const keep = yield* keepEnvironments;
        const candidates = yield* sql<{ readonly environment_id: string }>`
        SELECT DISTINCT environment_id FROM fleet_summary_rows ORDER BY environment_id
      `;
        for (const { environment_id } of candidates) {
          if (keep.has(environment_id)) continue;
          const rows = yield* sql<
            RowRecord & { readonly row_id: string }
          >`SELECT * FROM fleet_summary_rows
          WHERE environment_id = ${environment_id} ORDER BY row_id`;
          for (const record of rows) {
            const row = toRow(record);
            const revision = yield* nextRevision;
            yield* sql`DELETE FROM fleet_summary_rows WHERE row_id = ${record.row_id}`;
            yield* recordChange(revision, { type: "tombstone", revision, key: keyOfRow(row) });
          }
        }
        yield* sql`INSERT INTO fleet_summary_migrations (name) VALUES (${marker})`;
      }),
    )
    .pipe(Effect.mapError((error) => (isFleetSummaryError(error) ? error : storageError(error))));

  const report = Effect.fn("FleetSummary.report")(function* (
    callerEnvironmentId: string,
    input: FleetSummaryReportInput,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const canonical =
      input.type === "upsert-task" || input.type === "delete-task"
        ? { ...input, repo: yield* canonicalRepo(input.repo) }
        : input;
    const rowId = rowIdOf(callerEnvironmentId, canonical);
    return yield* publishLock.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (canonical.type === "upsert-task") {
                const lease = yield* sql`
        SELECT 1 AS held FROM node_claims AS claim
        WHERE claim.repo = ${canonical.repo} AND claim.issue = ${canonical.issue} AND claim.task_id = ${canonical.taskId}
          AND claim.holder_environment = ${callerEnvironmentId}
          AND (${canonical.attempt ?? null} IS NULL OR claim.attempt = ${canonical.attempt ?? null})
          AND (${canonical.fencing ?? null} IS NULL OR claim.fencing = ${canonical.fencing ?? null})
          AND ((claim.state = 'running' AND claim.lease_until > ${now}) OR (
            ${phaseFromSessionRun(canonical.sessionRun) === "done" ? 1 : 0} = 1 AND (
              (claim.state = 'released' AND ${canonical.attempt ?? null} IS NOT NULL
                AND ${canonical.fencing ?? null} IS NOT NULL)
              OR EXISTS (
                SELECT 1 FROM fleet_summary_rows AS row WHERE row.environment_id = ${callerEnvironmentId}
                  AND row.repo = claim.repo AND row.issue = claim.issue AND row.task_id = claim.task_id
                  AND row.thread_id = ${canonical.threadId}
              )
            )
          )) LIMIT 1
      `.pipe(Effect.mapError(storageError));
                if (lease[0] === undefined) {
                  return yield* new FleetSummaryError({
                    reason: "lease-required",
                    message: "The caller does not hold this task lease.",
                  });
                }
              }
              const existing = yield* rowById(rowId);
              if (canonical.type === "delete-task" || canonical.type === "delete-adhoc") {
                if (existing === undefined) {
                  const current = yield* meta;
                  return { revision: current.revision, changed: false, events: [] };
                }
                if (
                  canonical.type === "delete-task" &&
                  canonical.threadId !== undefined &&
                  existing.threadId !== canonical.threadId
                ) {
                  const current = yield* meta;
                  return { revision: current.revision, changed: false, events: [] };
                }
                const revision = yield* nextRevision;
                yield* sql`DELETE FROM fleet_summary_rows WHERE row_id = ${rowId}`;
                const event: FleetSummaryChangeEvent = {
                  type: "tombstone",
                  revision,
                  key: keyOfRow(existing),
                };
                yield* recordChange(revision, event);
                return { revision, changed: true, events: [event] };
              }

              const preserveStale =
                existing?.staleReason !== undefined &&
                existing.staleReason !== "lease lost" &&
                existing.staleReason !== "environment offline";
              const nextRow: FleetSummaryRow = {
                environmentId: callerEnvironmentId,
                ...(canonical.type === "upsert-task"
                  ? { repo: canonical.repo, issue: canonical.issue, taskId: canonical.taskId }
                  : {}),
                threadId: canonical.threadId,
                title: canonical.title,
                phase: phaseFromSessionRun(canonical.sessionRun),
                reason: canonical.reason,
                needsYou: canonical.needsYou,
                lastProgress: progress(canonical.lastProgress),
                ...(canonical.branch === undefined ? {} : { branch: canonical.branch }),
                ...(canonical.commit === undefined ? {} : { commit: canonical.commit }),
                updatedAt: now,
                stale: preserveStale
                  ? existing.stale
                  : phaseFromSessionRun(canonical.sessionRun) === "done" ||
                      canonical.type === "upsert-task"
                    ? false
                    : (existing?.stale ?? false),
                ...(existing?.staleReason !== undefined &&
                (preserveStale ||
                  (phaseFromSessionRun(canonical.sessionRun) !== "done" &&
                    canonical.type !== "upsert-task"))
                  ? { staleReason: existing.staleReason }
                  : {}),
                revision: 0,
              };
              if (existing !== undefined && sameReported(existing, nextRow)) {
                const current = yield* meta;
                return { revision: current.revision, changed: false, events: [] };
              }
              const revision = yield* nextRevision;
              const row = { ...nextRow, revision };
              yield* sql`INSERT INTO fleet_summary_rows (
              row_id, environment_id, kind, repo, issue, task_id, thread_id, title, phase,
              reason, needs_you, last_progress, branch, commit_sha, updated_at, stale, stale_reason, revision)
              VALUES (${rowId}, ${row.environmentId}, ${row.repo !== undefined ? "task" : "adhoc"},
                ${row.repo ?? null}, ${row.issue ?? null}, ${row.taskId ?? null}, ${row.threadId},
                ${row.title}, ${row.phase}, ${row.reason}, ${row.needsYou ? 1 : 0}, ${row.lastProgress},
                ${row.branch ?? null}, ${row.commit ?? null},
                ${row.updatedAt}, ${row.stale ? 1 : 0}, ${row.staleReason ?? null}, ${revision})
              ON CONFLICT(row_id) DO UPDATE SET environment_id = excluded.environment_id,
                kind = excluded.kind, repo = excluded.repo, issue = excluded.issue,
                task_id = excluded.task_id, thread_id = excluded.thread_id, title = excluded.title,
                phase = excluded.phase, reason = excluded.reason, needs_you = excluded.needs_you,
                last_progress = excluded.last_progress, branch = excluded.branch,
                commit_sha = excluded.commit_sha, updated_at = excluded.updated_at,
                stale = excluded.stale, stale_reason = excluded.stale_reason, revision = excluded.revision`;
              const event: FleetSummaryChangeEvent = { type: "upsert", revision, row };
              yield* recordChange(revision, event);
              return { revision, changed: true, events: [event] };
            }),
          )
          .pipe(
            Effect.mapError((error) => (isFleetSummaryError(error) ? error : storageError(error))),
          );
        yield* publish(result.events);
        return { revision: result.revision, changed: result.changed };
      }),
    );
  });

  /** Lease freshness is task-specific and never changes session phase or adhoc rows. */
  const sweepStale = publishLock.withPermits(1)(
    Effect.gen(function* () {
      const nowDate = yield* DateTime.now;
      const now = DateTime.formatIso(nowDate);
      const heartbeatCutoff = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(nowDate) - FLEET_ENVIRONMENT_HEARTBEAT_TTL_MS),
      );
      const events = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<
              RowRecord & { readonly has_lease: number; readonly offline: number }
            >`
              SELECT summary.*, EXISTS (
                SELECT 1 FROM node_claims AS claim
                WHERE claim.repo = summary.repo AND claim.issue = summary.issue
                  AND claim.task_id = summary.task_id
                  AND claim.holder_environment = summary.environment_id
                  AND claim.state = 'running' AND claim.lease_until > ${now}
              ) AS has_lease, COALESCE((
                SELECT heartbeat.last_seen <= ${heartbeatCutoff}
                FROM fleet_environment_heartbeats AS heartbeat
                WHERE heartbeat.environment_id = summary.environment_id
              ), summary.updated_at <= ${heartbeatCutoff}) AS offline
              FROM fleet_summary_rows AS summary ORDER BY summary.row_id
            `;
            const changes: Array<FleetSummaryChangeEvent> = [];
            for (const record of rows) {
              const row = toRow(record);
              if (row.phase === "done") continue;
              if (
                row.staleReason !== undefined &&
                row.staleReason !== "lease lost" &&
                row.staleReason !== "environment offline"
              )
                continue;
              const staleReason =
                record.offline === 1
                  ? "environment offline"
                  : record.kind === "task" && record.has_lease === 0
                    ? "lease lost"
                    : undefined;
              const stale = staleReason !== undefined;
              if (row.stale === stale && row.staleReason === staleReason) continue;
              const revision = yield* nextRevision;
              const next = { ...row, stale, staleReason, revision };
              yield* sql`UPDATE fleet_summary_rows SET stale = ${stale ? 1 : 0},
              stale_reason = ${staleReason ?? null}, revision = ${revision}
              WHERE row_id = ${rowIdOfRow(row)}`;
              const event: FleetSummaryChangeEvent = { type: "upsert", revision, row: next };
              yield* recordChange(revision, event);
              changes.push(event);
            }
            return changes;
          }),
        )
        .pipe(Effect.mapError(storageError));
      yield* publish(events);
    }),
  );

  const cleanupDone = publishLock.withPermits(1)(
    Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const cutoff = DateTime.formatIso(DateTime.makeUnsafe(now - FLEET_SUMMARY_DONE_RETENTION_MS));
      const events = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<RowRecord>`
            SELECT * FROM fleet_summary_rows
            WHERE phase = 'done' AND updated_at <= ${cutoff} ORDER BY row_id
          `;
            const changes: Array<FleetSummaryChangeEvent> = [];
            for (const record of rows) {
              const row = toRow(record);
              const revision = yield* nextRevision;
              yield* sql`DELETE FROM fleet_summary_rows WHERE row_id = ${rowIdOfRow(row)}`;
              const event: FleetSummaryChangeEvent = {
                type: "tombstone",
                revision,
                key: keyOfRow(row),
              };
              yield* recordChange(revision, event);
              changes.push(event);
            }
            return changes;
          }),
        )
        .pipe(Effect.mapError(storageError));
      yield* publish(events);
    }),
  );

  return FleetSummary.of({ report, subscribe, sweepStale, cleanupDone });
});

const rowIdOfRow = (row: FleetSummaryRow) =>
  row.repo !== undefined && row.issue !== undefined && row.taskId !== undefined
    ? `task\n${row.environmentId}\n${row.repo}\n${row.issue}\n${row.taskId}`
    : `adhoc\n${row.environmentId}\n${row.threadId}`;

const rowIdOfKey = (key: FleetSummaryTombstoneKey) =>
  key.repo !== undefined && key.issue !== undefined && key.taskId !== undefined
    ? `task\n${key.environmentId}\n${key.repo}\n${key.issue}\n${key.taskId}`
    : `adhoc\n${key.environmentId}\n${key.threadId}`;

const sameRow = (event: FleetSummaryChangeEvent, rowId: string) =>
  (event.type === "upsert" ? rowIdOfRow(event.row) : rowIdOfKey(event.key)) === rowId;

/** Read identities from the main database, not the separate ledger connection. */
export const keepEnvironments = Effect.gen(function* () {
  const mainSql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const localId = yield* identity.getEnvironmentId;
  const links = yield* mainSql<{ readonly environment_id: string }>`
    SELECT environment_id FROM peer_environment_links
  `;
  return new Set<string>([localId, ...links.map((link) => link.environment_id)]);
}).pipe(Effect.mapError(storageError));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const mainContext = yield* Effect.context<
      SqlClient.SqlClient | ServerEnvironment.ServerEnvironmentIdentity
    >();
    return Layer.effect(
      FleetSummary,
      make(keepEnvironments.pipe(Effect.provide(mainContext))),
    ).pipe(Layer.provide(LedgerDb.layer));
  }),
);

export const layerForTest = (
  filename = ":memory:",
  keepEnvironments: KeepEnvironments = Effect.succeed(new Set()),
) =>
  Layer.effect(FleetSummary, make(keepEnvironments)).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename })),
  );
