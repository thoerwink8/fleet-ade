import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeReads from "./nodeReads.ts";
import * as LedgerDb from "./LedgerDb.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  FLEET_SUMMARY_PROGRESS_LIMIT,
  FleetClaimHeartbeatResult,
  FleetClaimLeaseResult,
  type FleetClaimsError,
  type FleetSummaryError,
  type OrchestratorMcpFailure,
  type FleetClaim,
  type FleetSummaryReportInput,
  FleetSummaryWriteResult,
  FleetSummarySessionRun,
  phaseFromSessionRun,
  isBlockingApproval,
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
  readonly lost?: boolean;
  readonly deleteAdhocFirst?: boolean;
  readonly finishing?: boolean;
  readonly released?: boolean;
}

const keyFor = (threadId: string, coordinator: string) => `${threadId}\n${coordinator}`;

/** Reports registered local shells to their coordinators; failed sends remain pending. */
export class FleetSummaryReporter extends Context.Service<
  FleetSummaryReporter,
  {
    /** Explicitly bind a local executor thread to a winning claim and report its shell. */
    readonly trackTask: (
      threadId: ThreadId,
      claim: Pick<FleetClaim, "fleetId" | "repo" | "issue" | "taskId" | "attempt" | "fencing">,
    ) => Effect.Effect<void>;
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
  const summary = yield* FleetSummary.FleetSummary;
  const fleetClaims = yield* FleetClaims.FleetClaims;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const sql = yield* SqlClient.SqlClient;
  const scheduler = yield* Scheduler.Scheduler;
  yield* NodeReads.migrate;
  const selfId = yield* identity.getEnvironmentId;
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
          lost: row.deleting === 2,
          deleteAdhocFirst: row.deleting === 3,
          // 4/5 persist the nonrenewable completion transition and its release acknowledgement.
          finishing: row.deleting === 4 || row.deleting === 5,
          released: row.deleting === 5,
        },
      ]),
    ),
  );
  const persist = (entry: TrackedTask) =>
    sql`
    INSERT INTO fleet_summary_registrations (thread_id, kind, coordinator, repo, issue, task_id, sent, deleting, attempt, fencing)
    VALUES (${entry.threadId}, ${entry.kind}, ${entry.coordinator}, ${entry.repo ?? null},
      ${entry.issue ?? null}, ${entry.taskId ?? null}, ${entry.sent === undefined ? null : encodeSent(entry.sent)},
      ${entry.lost ? 2 : entry.deleting ? 1 : entry.deleteAdhocFirst ? 3 : entry.released ? 5 : entry.finishing ? 4 : 0}, ${entry.attempt ?? null}, ${entry.fencing ?? null})
    ON CONFLICT(thread_id, coordinator) DO UPDATE SET kind = excluded.kind, coordinator = excluded.coordinator,
      repo = excluded.repo, issue = excluded.issue, task_id = excluded.task_id,
      sent = excluded.sent, deleting = excluded.deleting,
      attempt = excluded.attempt, fencing = excluded.fencing
  `.pipe(Effect.orDie);
  const pendingTracks = new Map<string, { version: symbol; kind: "task" | "adhoc" }>();
  const sendLane = yield* Semaphore.make(1);

  const reportFields = (shell: OrchestrationV2ThreadShell): SentFields => ({
    title: shell.title.slice(0, 200),
    sessionRun: shell.status,
    reason: (shell.pendingRuntimeRequest !== null
      ? `waiting:${shell.pendingRuntimeRequest.kind}`
      : (shell.lastError ?? "")
    ).slice(0, 200),
    needsYou:
      shell.pendingRuntimeRequest !== null &&
      isBlockingApproval(shell.pendingRuntimeRequest.kind, shell.pendingRuntimeRequest.blocking),
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
  const sendReport = (entry: TrackedTask, input: FleetSummaryReportInput) => {
    const send: Effect.Effect<FleetSummaryWriteResult, FleetSummaryError | OrchestratorMcpFailure> =
      entry.coordinator === selfId
        ? summary.report(selfId, input)
        : peers.call({
            environmentId: entry.coordinator,
            tool: "fleet_summary_report",
            arguments: input,
            limits: { runtimeMode: "auto", interactionMode: "default" },
            success: FleetSummaryWriteResult,
          });
    return send.pipe(
      Effect.as("sent" as const),
      Effect.catch((error) => {
        if (
          input.type === "upsert-task" &&
          (error._tag === "FleetSummaryError"
            ? error.reason === "lease-required"
            : error.code === "invalid_request" && error.message === "fleet-summary:lease-required")
        ) {
          return Effect.succeed("lost" as const);
        }
        return Effect.logWarning("fleet summary report failed", {
          threadId: entry.threadId,
          coordinator: entry.coordinator,
          code: error._tag === "FleetSummaryError" ? error.reason : error.code,
        }).pipe(Effect.as("failed" as const));
      }),
    );
  };

  // Callers hold the lane through reading, sending, and acknowledging a row.
  const report = Effect.fn("FleetSummaryReporter.report")(function* (
    key: string,
  ): Effect.fn.Return<void> {
    const entry = (yield* Ref.get(tracked)).get(key);
    if (entry === undefined) return;
    if (entry.deleteAdhocFirst) {
      if ((yield* sendReport(entry, { type: "delete-adhoc", threadId: entry.threadId })) !== "sent")
        return;
      const next = { ...entry, deleteAdhocFirst: false };
      yield* persist(next);
      yield* Ref.update(tracked, (current) => new Map(current).set(key, next));
      yield* sendLane
        .withPermits(1)(Effect.suspend(() => report(key)))
        .pipe(Effect.forkDetach);
      return;
    }
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
      if ((yield* sendReport(entry, input)) === "sent") {
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
    if ((entry.lost || entry.finishing) && phaseFromSessionRun(shell.status) !== "done") return;
    if (entry.kind === "adhoc" && phaseFromSessionRun(shell.status) === "done") {
      const pending = { ...entry, deleting: true };
      yield* persist(pending);
      yield* Ref.update(tracked, (current) => new Map(current).set(key, pending));
      if (
        (yield* sendReport(pending, { type: "delete-adhoc", threadId: entry.threadId })) === "sent"
      ) {
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
    if (entry.kind === "task" && phaseFromSessionRun(shell.status) === "done" && !entry.released) {
      const finishing = entry.finishing ? entry : { ...entry, finishing: true, lost: false };
      if (finishing !== entry) {
        yield* persist(finishing);
        yield* Ref.update(tracked, (current) => new Map(current).set(key, finishing));
      }
      if (
        finishing.repo === undefined ||
        finishing.issue === undefined ||
        finishing.taskId === undefined ||
        finishing.attempt === undefined ||
        finishing.fencing === undefined
      )
        return;
      const input = {
        repo: finishing.repo,
        issue: finishing.issue,
        taskId: finishing.taskId,
        attempt: finishing.attempt,
        fencing: finishing.fencing,
        idempotencyKey: `summary-release:${finishing.threadId}:${finishing.attempt}:${finishing.fencing}`,
      };
      const release: Effect.Effect<
        FleetClaimLeaseResult,
        FleetClaimsError | OrchestratorMcpFailure
      > =
        finishing.coordinator === selfId
          ? fleetClaims.release({ sessionId: selfId, environmentId: selfId }, input)
          : peers.call({
              environmentId: finishing.coordinator,
              tool: "fleet_release",
              arguments: input,
              limits: { runtimeMode: "auto", interactionMode: "default" },
              success: FleetClaimLeaseResult,
            });
      const result = yield* release.pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("fleet task release failed", {
            threadId: finishing.threadId,
            error,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!result) return;
      const released = { ...finishing, released: true };
      yield* persist(released);
      yield* Ref.update(tracked, (current) => new Map(current).set(key, released));
      yield* report(key);
      return;
    }
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
    const result = yield* sendReport(entry, input);
    if (result === "lost") {
      const lost = { ...entry, lost: true };
      if (entry.lost) return;
      yield* persist(lost);
      yield* Ref.update(tracked, (current) => new Map(current).set(key, lost));
    } else if (result === "sent") {
      yield* sql`UPDATE fleet_summary_registrations SET sent = ${encodeSent(fields)}
        WHERE thread_id = ${entry.threadId} AND coordinator = ${entry.coordinator}
          AND kind = ${entry.kind} AND repo IS ${entry.repo ?? null}
          AND issue IS ${entry.issue ?? null} AND task_id IS ${entry.taskId ?? null}
          AND attempt IS ${entry.attempt ?? null} AND fencing IS ${entry.fencing ?? null}
          AND deleting IN (0, 2, 5)`.pipe(Effect.orDie);
      const sentEntry = entry;
      yield* Ref.update(tracked, (current) => {
        const latest = current.get(key);
        if (latest === undefined || latest !== sentEntry) return current;
        return new Map(current).set(key, { ...latest, sent: fields });
      });
    }
  });

  const untrack: FleetSummaryReporter["Service"]["untrack"] = (threadId) =>
    Effect.suspend(() => {
      for (const key of pendingTracks.keys())
        if (key.startsWith(`${threadId}\n`)) pendingTracks.delete(key);
      return sendLane.withPermits(1)(
        Effect.gen(function* () {
          for (const [key, entry] of yield* Ref.get(tracked)) {
            if (entry.threadId !== threadId) continue;
            const pending = { ...entry, deleting: true, lost: false };
            yield* persist(pending);
            yield* Ref.update(tracked, (current) => new Map(current).set(key, pending));
            yield* report(key);
          }
        }),
      );
    });

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
    Effect.suspend(() => {
      const trackKey = keyFor(threadId, entry.coordinator);
      const version = Symbol();
      if (
        entry.kind === "adhoc" &&
        (pendingTracks.get(trackKey)?.kind === "task" ||
          (entry.coordinator === selfId &&
            [...pendingTracks.entries()].some(
              ([key, pending]) => key.startsWith(`${threadId}\n`) && pending.kind === "task",
            )))
      )
        return Effect.void;
      pendingTracks.set(trackKey, { version, kind: entry.kind });
      return sendLane
        .withPermits(1)(
          Effect.gen(function* () {
            if (pendingTracks.get(trackKey)?.version !== version) return;
            pendingTracks.delete(trackKey);
            if (
              entry.kind === "adhoc" &&
              entry.coordinator === selfId &&
              [...pendingTracks.entries()].some(
                ([pendingKey, pending]) =>
                  pendingKey.startsWith(`${threadId}\n`) && pending.kind === "task",
              )
            )
              return;
            const key = keyFor(threadId, entry.coordinator);
            const current = yield* Ref.get(tracked);
            const previous = current.get(key);
            if (
              entry.kind === "adhoc" &&
              (previous?.kind === "task" ||
                (entry.coordinator === selfId &&
                  [...current.values()].some(
                    (item) => item.threadId === threadId && item.kind === "task" && !item.deleting,
                  )))
            )
              return;
            const next: TrackedTask =
              previous?.kind === entry.kind &&
              previous.repo === entry.repo &&
              previous.issue === entry.issue &&
              previous.taskId === entry.taskId &&
              previous.attempt === entry.attempt &&
              previous.fencing === entry.fencing &&
              !previous.deleting
                ? previous
                : { ...entry, threadId, deleteAdhocFirst: previous?.kind === "adhoc" };
            if (next !== previous) {
              yield* persist(next);
              yield* Ref.update(tracked, (items) => new Map(items).set(key, next));
            }
            if (entry.kind === "task" && entry.coordinator !== selfId) {
              const localKey = keyFor(threadId, selfId);
              const local = (yield* Ref.get(tracked)).get(localKey);
              if (local?.kind === "adhoc") {
                const deleting = { ...local, deleting: true };
                if (!local.deleting) {
                  yield* persist(deleting);
                  yield* Ref.update(tracked, (items) => new Map(items).set(localKey, deleting));
                }
                yield* report(localKey);
              }
            }
            yield* sendLane.withPermits(1)(report(key)).pipe(Effect.forkDetach);
          }),
        )
        .pipe(Effect.forkDetach, Effect.asVoid);
    });

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
    const active = yield* projections
      .listActiveShellIndex()
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("fleet summary session sweep failed", { error }).pipe(Effect.as(null)),
        ),
      );
    if (active === null) return;

    const live = new Set(active.filter((thread) => thread.mayBeLive).map((thread) => thread.id));
    yield* sendLane.withPermits(1)(
      Effect.gen(function* () {
        for (const [key, entry] of yield* Ref.get(tracked)) {
          if (entry.kind !== "adhoc" || entry.coordinator !== selfId) continue;
          const taskExists = [...(yield* Ref.get(tracked)).values()].some(
            (item) => item.threadId === entry.threadId && item.kind === "task" && !item.deleting,
          );
          if (!taskExists && live.has(entry.threadId)) continue;
          if (!entry.deleting) {
            const pending = { ...entry, deleting: true };
            yield* persist(pending);
            yield* Ref.update(tracked, (items) => new Map(items).set(key, pending));
          }
          yield* report(key);
        }
      }),
    );
    for (const thread of active) {
      if (!thread.mayBeLive) continue;
      if (
        [...(yield* Ref.get(tracked)).values()].some(
          (entry) =>
            entry.threadId === thread.id && (entry.kind === "task" || entry.coordinator === selfId),
        )
      )
        continue;
      if (
        [...pendingTracks.entries()].some(
          ([key, pending]) => key.startsWith(`${thread.id}\n`) && pending.kind === "task",
        )
      )
        continue;
      const shell = yield* projections.getThreadShell(thread.id).pipe(
        Effect.catch((error) =>
          Effect.logWarning("fleet summary shell read failed", {
            threadId: thread.id,
            error,
          }).pipe(Effect.as(null)),
        ),
      );
      if (shell === null || phaseFromSessionRun(shell.status) === "done") continue;
      yield* trackAdhoc(thread.id, selfId);
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
                if (entry.deleting === true || entry.lost === true || entry.finishing === true)
                  continue;
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
                    environmentId === selfId
                      ? fleetClaims.heartbeat(selfId, { sequence, leases })
                      : peers.call({
                          environmentId,
                          tool: "fleet_heartbeat",
                          arguments: { sequence, leases },
                          limits: { runtimeMode: "auto", interactionMode: "default" },
                          success: FleetClaimHeartbeatResult,
                        });
                  return send.pipe(
                    Effect.timeout("20 seconds"),
                    Effect.tap((result) =>
                      Effect.forEach(
                        result.results,
                        (item) => {
                          if (item.outcome === "renewed") return Effect.void;
                          const entry = tasks.find(
                            (task) =>
                              task.repo === item.repo &&
                              task.issue === item.issue &&
                              task.taskId === item.taskId &&
                              task.attempt === item.attempt,
                          );
                          if (entry === undefined) return Effect.void;
                          return Effect.gen(function* () {
                            const key = keyFor(entry.threadId, entry.coordinator);
                            if (pendingTracks.has(key)) return;
                            const current = (yield* Ref.get(tracked)).get(key);
                            if (
                              current === undefined ||
                              current.deleting ||
                              current.lost ||
                              current.finishing ||
                              current.kind !== entry.kind ||
                              current.repo !== entry.repo ||
                              current.issue !== entry.issue ||
                              current.taskId !== entry.taskId ||
                              current.attempt !== entry.attempt ||
                              current.fencing !== entry.fencing
                            )
                              return;
                            const lost = { ...current, lost: true };
                            yield* persist(lost);
                            yield* Ref.update(tracked, (items) => new Map(items).set(key, lost));
                          });
                        },
                        { discard: true },
                      ),
                    ),
                    Effect.catch((error) =>
                      Effect.logWarning("fleet heartbeat failed", {
                        environmentId,
                        code:
                          error._tag === "FleetClaimsError"
                            ? error.reason
                            : error._tag === "OrchestratorMcpFailure"
                              ? error.code
                              : "timeout",
                      }),
                    ),
                  );
                },
                { discard: true, concurrency: "unbounded" },
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

export const layer = Layer.effect(FleetSummaryReporter, make).pipe(Layer.provide(LedgerDb.layer));

export const layerForTest = (filename = ":memory:") =>
  Layer.effect(FleetSummaryReporter, make).pipe(
    Layer.provide(NodeSqliteClient.layer({ filename })),
  );
