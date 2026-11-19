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
  FleetClaimHeartbeatResult,
  type FleetClaimsError,
  type FleetSummaryError,
  type OrchestratorMcpFailure,
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
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetClaims from "./FleetClaims.ts";
import * as FleetSummary from "./FleetSummary.ts";

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
  readonly attempt: number | null;
  readonly fencing: string | null;
}

interface TrackedTask {
  readonly threadId: ThreadId;
  readonly kind: "task" | "adhoc";
  /** The coordinator's environment id, from the winning claim's `fleetId`. */
  readonly coordinator: EnvironmentId;
  readonly repo?: string;
  readonly issue?: number;
  readonly taskId?: string;
  /** Held-lease fencing sent back on each heartbeat renewal. */
  readonly attempt?: number;
  readonly fencing?: string;
  /** Last report fields acknowledged by this coordinator. */
  sent?: SentFields;
  readonly deleting?: boolean;
}

const keyFor = (threadId: string, coordinator: string) => `${threadId}\n${coordinator}`;

/** Reports registered local shells to their coordinators; failed sends remain pending. */
export class FleetSummaryReporter extends Context.Service<
  FleetSummaryReporter,
  {
    /** Explicitly bind a local executor thread to a winning claim and report its shell. */
    readonly trackTask: (threadId: ThreadId, claim: FleetClaim) => Effect.Effect<void>;
    /** Register unleased work for one coordinator and report its current shell. */
    readonly trackAdhoc: (threadId: ThreadId, coordinator: EnvironmentId) => Effect.Effect<void>;
    /** Send tombstones to every coordinator; forget a registration once acknowledged. */
    readonly untrack: (threadId: ThreadId) => Effect.Effect<void>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/ledger/FleetSummaryReporter") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const summary = yield* Effect.serviceOption(FleetSummary.FleetSummary);
  const fleetClaims = yield* Effect.serviceOption(FleetClaims.FleetClaims);
  const identity = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity);
  const sql = yield* SqlClient.SqlClient;
  const scheduler = yield* Scheduler.Scheduler;
  yield* NodeReads.migrate;
  const selfId = Option.isSome(identity) ? yield* identity.value.getEnvironmentId : undefined;
  const rows = yield* sql<RegistrationRecord>`
    SELECT thread_id, kind, coordinator, repo, issue, task_id, sent, deleting, attempt, fencing
    FROM fleet_summary_registrations
  `;
  const tracked = yield* Ref.make(
    new Map<string, TrackedTask>(
      rows.map((row) => [
        keyFor(row.thread_id, row.coordinator),
        {
          threadId: row.thread_id as ThreadId,
          kind: row.kind,
          coordinator: EnvironmentId.make(row.coordinator),
          ...(row.repo === null ? {} : { repo: row.repo }),
          ...(row.issue === null ? {} : { issue: row.issue }),
          ...(row.task_id === null ? {} : { taskId: row.task_id }),
          ...(row.attempt === null ? {} : { attempt: row.attempt }),
          ...(row.fencing === null ? {} : { fencing: row.fencing }),
          ...(row.sent === null ? {} : { sent: decodeSent(row.sent) }),
          deleting: row.deleting === 1,
        },
      ]),
    ),
  );
  const persist = (entry: TrackedTask) =>
    sql`
    INSERT INTO fleet_summary_registrations (thread_id, kind, coordinator, repo, issue, task_id, sent, deleting, attempt, fencing)
    VALUES (${entry.threadId}, ${entry.kind}, ${entry.coordinator}, ${entry.repo ?? null},
      ${entry.issue ?? null}, ${entry.taskId ?? null}, ${entry.sent === undefined ? null : encodeSent(entry.sent)},
      ${entry.deleting ? 1 : 0}, ${entry.attempt ?? null}, ${entry.fencing ?? null})
    ON CONFLICT(thread_id, coordinator) DO UPDATE SET kind = excluded.kind, coordinator = excluded.coordinator,
      repo = excluded.repo, issue = excluded.issue, task_id = excluded.task_id,
      sent = excluded.sent, deleting = excluded.deleting,
      attempt = excluded.attempt, fencing = excluded.fencing
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

  // Self-coordination writes this environment's own summary; remote ones go over the link.
  const sendReport = (
    entry: TrackedTask,
    input: FleetSummaryReportInput,
  ): Effect.Effect<boolean> => {
    const send: Effect.Effect<FleetSummaryWriteResult, FleetSummaryError | OrchestratorMcpFailure> =
      selfId !== undefined && entry.coordinator === selfId && Option.isSome(summary)
        ? summary.value.report(selfId, input)
        : peers.call({
            environmentId: entry.coordinator,
            tool: "fleet_summary_report",
            arguments: input,
            limits: { runtimeMode: "auto", interactionMode: "default" },
            success: FleetSummaryWriteResult,
          });
    return send.pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("fleet summary report failed", {
          threadId: entry.threadId,
          coordinator: entry.coordinator,
          code: error._tag === "FleetSummaryError" ? error.reason : error.code,
        }).pipe(Effect.as(false)),
      ),
    );
  };

  // Callers hold the lane through reading, sending, and acknowledging a row.
  const report = Effect.fn("FleetSummaryReporter.report")(function* (key: string) {
    const entry = (yield* Ref.get(tracked)).get(key);
    if (entry === undefined) return;
    if (entry.deleting) {
      const input: FleetSummaryReportInput =
        entry.kind === "task"
          ? {
              type: "delete-task",
              repo: entry.repo!,
              issue: entry.issue!,
              taskId: entry.taskId!,
              threadId: entry.threadId,
            }
          : { type: "delete-adhoc", threadId: entry.threadId };
      if (yield* sendReport(entry, input)) {
        yield* sql`DELETE FROM fleet_summary_registrations WHERE thread_id = ${entry.threadId} AND coordinator = ${entry.coordinator}`.pipe(
          Effect.orDie,
        );
        yield* Ref.update(tracked, (current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      }
      return;
    }
    const shell = yield* projections.getThreadShell(entry.threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("fleet summary shell read failed", {
          threadId: entry.threadId,
          error,
        }).pipe(Effect.as(null)),
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
            threadId: entry.threadId,
            ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
            ...(entry.fencing === undefined ? {} : { fencing: entry.fencing }),
            ...fields,
          }
        : { type: "upsert-adhoc", threadId: entry.threadId, ...fields };
    if (yield* sendReport(entry, input)) {
      yield* persist({ ...entry, sent: fields });
      yield* Ref.update(tracked, (current) => {
        const next = new Map(current);
        next.set(key, { ...entry, sent: fields });
        return next;
      });
    }
  });

  const untrack: FleetSummaryReporter["Service"]["untrack"] = (threadId) =>
    sendLane.withPermits(1)(
      Effect.gen(function* () {
        for (const [key, entry] of yield* Ref.get(tracked)) {
          if (entry.threadId !== threadId) continue;
          const pending = { ...entry, deleting: true };
          yield* persist(pending);
          yield* Ref.update(tracked, (current) => new Map(current).set(key, pending));
          yield* report(key);
        }
      }),
    );

  const handle = Effect.fnUntraced(
    function* (event: OrchestrationV2DomainEvent) {
      if (event.type === "thread.deleted" || event.type === "thread.archived") {
        yield* untrack(event.threadId);
      } else {
        yield* sendLane.withPermits(1)(
          Effect.gen(function* () {
            for (const key of (yield* Ref.get(tracked)).keys()) {
              if (key.startsWith(`${event.threadId}\n`)) yield* report(key);
            }
          }),
        );
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

  const track = (threadId: ThreadId, entry: Omit<TrackedTask, "sent" | "threadId">) =>
    sendLane.withPermits(1)(
      Effect.gen(function* () {
        const key = keyFor(threadId, entry.coordinator);
        const current = yield* Ref.get(tracked);
        const previous = current.get(key);
        if (entry.kind === "adhoc" && previous?.kind === "task") return;
        const next: TrackedTask =
          previous?.kind === entry.kind &&
          previous.repo === entry.repo &&
          previous.issue === entry.issue &&
          previous.taskId === entry.taskId &&
          previous.attempt === entry.attempt &&
          previous.fencing === entry.fencing &&
          !previous.deleting
            ? previous
            : { ...entry, threadId };
        yield* persist(next);
        yield* Ref.set(tracked, new Map(current).set(key, next));
        yield* sendLane.withPermits(1)(report(key)).pipe(Effect.forkDetach);
      }),
    );

  const trackTask: FleetSummaryReporter["Service"]["trackTask"] = (threadId, claim) =>
    track(threadId, {
      kind: "task",
      coordinator: EnvironmentId.make(claim.fleetId),
      repo: claim.repo,
      issue: claim.issue,
      taskId: claim.taskId,
      attempt: claim.attempt,
      fencing: claim.fencing,
    });

  const trackAdhoc: FleetSummaryReporter["Service"]["trackAdhoc"] = (threadId, coordinator) =>
    track(threadId, { kind: "adhoc", coordinator });

  // Local threads register with their own environment. Remote registrations
  // are explicit, so unrelated links do not receive thread metadata.
  const registerLocalSessions = Effect.gen(function* () {
    const coordinators = new Set<EnvironmentId>();
    if (selfId !== undefined) coordinators.add(selfId);
    if (coordinators.size === 0) return;
    const active = yield* projections
      .listActiveShellIndex()
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("fleet summary session sweep failed", { error }).pipe(
            Effect.as([] as ReadonlyArray<ProjectionStore.ActiveShellIndexEntry>),
          ),
        ),
      );
    const current = yield* Ref.get(tracked);
    for (const thread of active) {
      for (const coordinator of coordinators) {
        const previous = current.get(keyFor(thread.id, coordinator));
        if (previous !== undefined) continue;
        yield* trackAdhoc(thread.id, coordinator);
      }
    }
  });

  const start: FleetSummaryReporter["Service"]["start"] = Effect.fn("FleetSummaryReporter.start")(
    function* () {
      yield* scheduler.register(
        "fleet-summary-reporter",
        Effect.andThen(
          registerLocalSessions,
          sendLane.withPermits(1)(
            Effect.gen(function* () {
              for (const key of (yield* Ref.get(tracked)).keys()) yield* report(key);
            }),
          ),
        ),
      );
      let sequence = 0;
      yield* forkParked(
        sendLane
          .withPermits(1)(
            Effect.gen(function* () {
              const entries = [...(yield* Ref.get(tracked)).values()];
              const coordinators = new Map<EnvironmentId, Array<TrackedTask>>();
              for (const entry of entries) {
                if (entry.deleting === true) continue;
                const list = coordinators.get(entry.coordinator) ?? [];
                list.push(entry);
                coordinators.set(entry.coordinator, list);
              }
              sequence += 1;
              yield* Effect.forEach(
                coordinators,
                ([environmentId, tasks]) => {
                  const leases = tasks.flatMap((entry) =>
                    entry.repo !== undefined &&
                    entry.issue !== undefined &&
                    entry.taskId !== undefined &&
                    entry.attempt !== undefined &&
                    entry.fencing !== undefined
                      ? [
                          {
                            repo: entry.repo,
                            issue: entry.issue,
                            taskId: entry.taskId,
                            attempt: entry.attempt,
                            fencing: entry.fencing,
                          },
                        ]
                      : [],
                  );
                  const send: Effect.Effect<
                    FleetClaimHeartbeatResult,
                    FleetClaimsError | OrchestratorMcpFailure
                  > =
                    selfId !== undefined && environmentId === selfId && Option.isSome(fleetClaims)
                      ? fleetClaims.value.heartbeat(selfId, { sequence, leases })
                      : peers.call({
                          environmentId,
                          tool: "fleet_heartbeat",
                          arguments: { sequence, leases },
                          limits: { runtimeMode: "auto", interactionMode: "default" },
                          success: FleetClaimHeartbeatResult,
                        });
                  return send.pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("fleet heartbeat failed", {
                        environmentId,
                        code: error._tag === "FleetClaimsError" ? error.reason : error.code,
                      }),
                    ),
                  );
                },
                { discard: true },
              );
            }),
          )
          .pipe(Effect.andThen(Effect.sleep("30 seconds")), Effect.forever),
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
