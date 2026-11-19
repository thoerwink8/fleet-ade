import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as NodeReads from "./nodeReads.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  FLEET_SUMMARY_PROGRESS_LIMIT,
  type FleetClaim,
  type FleetSummaryReportInput,
  FleetSummaryWriteResult,
  FleetSummarySessionRun,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";

const SentFields = Schema.Struct({
  title: Schema.String,
  sessionRun: FleetSummarySessionRun,
  reason: Schema.String,
  needsYou: Schema.Boolean,
  lastProgress: Schema.String,
});
type SentFields = typeof SentFields.Type;
const decodeSent = Schema.decodeUnknownSync(Schema.fromJsonString(SentFields));
const encodeSent = Schema.encodeSync(Schema.fromJsonString(SentFields));

interface RegistrationRecord {
  readonly thread_id: string;
  readonly kind: "task" | "adhoc";
  readonly coordinator: string;
  readonly repo: string | null;
  readonly issue: number | null;
  readonly task_id: string | null;
  readonly sent: string | null;
  readonly deleting: number;
}

interface TrackedTask {
  readonly kind: "task" | "adhoc";
  /** The coordinator's environment id, from the winning claim's `fleetId`. */
  readonly coordinator: EnvironmentId;
  readonly repo?: string;
  readonly issue?: number;
  readonly taskId?: string;
  /** Last report fields acknowledged by the coordinator. */
  sent?: SentFields;
  readonly deleting?: boolean;
}

/** Reports registered local shells to their linked coordinator; failed sends remain pending. */
export class FleetSummaryReporter extends Context.Service<
  FleetSummaryReporter,
  {
    /** Explicitly bind a local executor thread to a winning claim and report its shell. */
    readonly trackTask: (threadId: ThreadId, claim: FleetClaim) => Effect.Effect<void>;
    /** Register unleased work and immediately report its current shell. */
    readonly trackAdhoc: (threadId: ThreadId, coordinator: EnvironmentId) => Effect.Effect<void>;
    /** Send a tombstone; forget the registration only once it is acknowledged. */
    readonly untrack: (threadId: ThreadId) => Effect.Effect<void>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/ledger/FleetSummaryReporter") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const sql = yield* SqlClient.SqlClient;
  const scheduler = yield* Scheduler.Scheduler;
  yield* NodeReads.migrate;
  const rows = yield* sql<RegistrationRecord>`
    SELECT thread_id, kind, coordinator, repo, issue, task_id, sent, deleting
    FROM fleet_summary_registrations
  `;
  const tracked = yield* Ref.make(
    new Map<ThreadId, TrackedTask>(
      rows.map((row) => [
        row.thread_id as ThreadId,
        {
          kind: row.kind,
          coordinator: EnvironmentId.make(row.coordinator),
          ...(row.repo === null ? {} : { repo: row.repo }),
          ...(row.issue === null ? {} : { issue: row.issue }),
          ...(row.task_id === null ? {} : { taskId: row.task_id }),
          ...(row.sent === null ? {} : { sent: decodeSent(row.sent) }),
          deleting: row.deleting === 1,
        },
      ]),
    ),
  );
  const persist = (threadId: ThreadId, entry: TrackedTask) =>
    sql`
    INSERT INTO fleet_summary_registrations (thread_id, kind, coordinator, repo, issue, task_id, sent, deleting)
    VALUES (${threadId}, ${entry.kind}, ${entry.coordinator}, ${entry.repo ?? null},
      ${entry.issue ?? null}, ${entry.taskId ?? null}, ${entry.sent === undefined ? null : encodeSent(entry.sent)}, ${entry.deleting ? 1 : 0})
    ON CONFLICT(thread_id) DO UPDATE SET kind = excluded.kind, coordinator = excluded.coordinator,
      repo = excluded.repo, issue = excluded.issue, task_id = excluded.task_id,
      sent = excluded.sent, deleting = excluded.deleting
  `.pipe(Effect.orDie);
  const sendLane = yield* Semaphore.make(1);

  const reportFields = (shell: OrchestrationV2ThreadShell): SentFields => ({
    title: shell.title.slice(0, 200),
    sessionRun: shell.status,
    reason: (shell.pendingRuntimeRequest !== null
      ? `waiting:${shell.pendingRuntimeRequest.kind}`
      : (shell.lastError ?? "")
    ).slice(0, 200),
    needsYou: shell.pendingRuntimeRequest !== null,
    lastProgress: (shell.latestVisibleMessage?.text ?? "").slice(0, FLEET_SUMMARY_PROGRESS_LIMIT),
  });

  const sameFields = (a: SentFields | undefined, b: SentFields) =>
    a !== undefined &&
    a.title === b.title &&
    a.sessionRun === b.sessionRun &&
    a.reason === b.reason &&
    a.needsYou === b.needsYou &&
    a.lastProgress === b.lastProgress;

  const sendReport = (entry: TrackedTask, threadId: ThreadId, input: FleetSummaryReportInput) =>
    peers
      .call({
        environmentId: entry.coordinator,
        tool: "fleet_summary_report",
        arguments: input,
        limits: { runtimeMode: "auto", interactionMode: "default" },
        success: FleetSummaryWriteResult,
      })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("fleet summary report failed", {
            threadId,
            coordinator: entry.coordinator,
            code: error.code,
          }).pipe(Effect.as(false)),
        ),
      );

  // Callers hold the lane through reading, sending, and acknowledging a row.
  const report = Effect.fn("FleetSummaryReporter.report")(function* (threadId: ThreadId) {
    const entry = (yield* Ref.get(tracked)).get(threadId);
    if (entry === undefined) return;
    if (entry.deleting) {
      const input: FleetSummaryReportInput =
        entry.kind === "task"
          ? { type: "delete-task", repo: entry.repo!, issue: entry.issue!, taskId: entry.taskId! }
          : { type: "delete-adhoc", threadId };
      if (yield* sendReport(entry, threadId, input)) {
        yield* sql`DELETE FROM fleet_summary_registrations WHERE thread_id = ${threadId}`.pipe(
          Effect.orDie,
        );
        yield* Ref.update(tracked, (current) => {
          const next = new Map(current);
          next.delete(threadId);
          return next;
        });
      }
      return;
    }
    const shell = yield* projections
      .getThreadShell(threadId)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("fleet summary shell read failed", { threadId, error }).pipe(
            Effect.as(null),
          ),
        ),
      );
    if (shell === null) return;
    const fields = reportFields(shell);
    if (sameFields(entry.sent, fields)) return;
    const input: FleetSummaryReportInput =
      entry.kind === "task"
        ? {
            type: "upsert-task",
            repo: entry.repo!,
            issue: entry.issue!,
            taskId: entry.taskId!,
            threadId,
            ...fields,
          }
        : { type: "upsert-adhoc", threadId, ...fields };
    if (yield* sendReport(entry, threadId, input)) {
      yield* persist(threadId, { ...entry, sent: fields });
      yield* Ref.update(tracked, (current) => {
        const next = new Map(current);
        next.set(threadId, { ...entry, sent: fields });
        return next;
      });
    }
  });

  const untrack: FleetSummaryReporter["Service"]["untrack"] = (threadId) =>
    sendLane.withPermits(1)(
      Effect.gen(function* () {
        const entry = (yield* Ref.get(tracked)).get(threadId);
        if (entry === undefined) return;
        const pending = { ...entry, deleting: true };
        yield* persist(threadId, pending);
        yield* Ref.update(tracked, (current) => new Map(current).set(threadId, pending));
        yield* report(threadId);
      }),
    );

  const handle = Effect.fnUntraced(
    function* (event: OrchestrationV2DomainEvent) {
      if (event.type === "thread.deleted") {
        yield* untrack(event.threadId);
      } else {
        yield* sendLane.withPermits(1)(report(event.threadId));
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("fleet summary report event failed", {
            eventType: event.type,
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const track = (threadId: ThreadId, entry: Omit<TrackedTask, "sent">) =>
    sendLane.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(tracked);
        const previous = current.get(threadId);
        const next =
          previous?.kind === entry.kind &&
          previous.coordinator === entry.coordinator &&
          previous.repo === entry.repo &&
          previous.issue === entry.issue &&
          previous.taskId === entry.taskId &&
          !previous.deleting
            ? previous
            : { ...entry };
        yield* persist(threadId, next);
        yield* Ref.set(tracked, new Map(current).set(threadId, next));
        // Launch events can precede registration; publish the current shell now.
        yield* report(threadId);
      }),
    );

  const trackTask: FleetSummaryReporter["Service"]["trackTask"] = (threadId, claim) =>
    track(threadId, {
      kind: "task",
      coordinator: EnvironmentId.make(claim.fleetId),
      repo: claim.repo,
      issue: claim.issue,
      taskId: claim.taskId,
    });

  const trackAdhoc: FleetSummaryReporter["Service"]["trackAdhoc"] = (threadId, coordinator) =>
    track(threadId, { kind: "adhoc", coordinator });

  const start: FleetSummaryReporter["Service"]["start"] = Effect.fn("FleetSummaryReporter.start")(
    function* () {
      yield* scheduler.register(
        "fleet-summary-reporter",
        sendLane.withPermits(1)(
          Effect.gen(function* () {
            for (const threadId of (yield* Ref.get(tracked)).keys()) yield* report(threadId);
          }),
        ),
      );
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("fleet summary reporter event stream failed; resubscribing", {
                  cause,
                }),
          ),
          Effect.andThen(Effect.sleep("5 seconds")),
          Effect.forever,
        ),
      );
    },
  );

  return FleetSummaryReporter.of({ trackTask, trackAdhoc, untrack, handle, start });
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return Layer.effect(FleetSummaryReporter, make).pipe(
      Layer.provide(NodeSqliteClient.layer({ filename: path.join(stateDir, "ledger.sqlite") })),
    );
  }).pipe(Effect.provide(NodePath.layer)),
);

export const layerForTest = (filename = ":memory:") =>
  Layer.effect(FleetSummaryReporter, make).pipe(
    Layer.provide(NodeSqliteClient.layer({ filename })),
  );
