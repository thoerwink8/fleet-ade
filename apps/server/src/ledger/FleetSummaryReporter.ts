import {
  EnvironmentId,
  FLEET_SUMMARY_PROGRESS_LIMIT,
  type FleetClaim,
  type FleetSummaryReportInput,
  FleetSummaryWriteResult,
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

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";

interface SentFields {
  readonly title: string;
  readonly sessionRun: OrchestrationV2ThreadShell["status"];
  readonly reason: string;
  readonly needsYou: boolean;
  readonly lastProgress: string;
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
  const tracked = yield* Ref.make(new Map<ThreadId, TrackedTask>());
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
        const input: FleetSummaryReportInput =
          entry.kind === "task"
            ? { type: "delete-task", repo: entry.repo!, issue: entry.issue!, taskId: entry.taskId! }
            : { type: "delete-adhoc", threadId };
        if (yield* sendReport(entry, threadId, input)) {
          yield* Ref.update(tracked, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          });
        }
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
        yield* Ref.update(tracked, (current) => {
          const next = new Map(current);
          const previous = current.get(threadId);
          next.set(
            threadId,
            previous?.kind === entry.kind &&
              previous.coordinator === entry.coordinator &&
              previous.repo === entry.repo &&
              previous.issue === entry.issue &&
              previous.taskId === entry.taskId
              ? previous
              : { ...entry },
          );
          return next;
        });
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

  const start: FleetSummaryReporter["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("fleet summary reporter event stream failed", { cause }),
        ),
      ),
    );

  return FleetSummaryReporter.of({ trackTask, trackAdhoc, untrack, handle, start });
});

export const layer = Layer.effect(FleetSummaryReporter, make);
