import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** Dispatched per scheduler run; a backlog drains one batch per 5s tick instead of one burst. */
export const THREAD_TRASH_PURGE_BATCH_LIMIT = 25;

const affectsThreadTrashPurge = (event: OrchestrationV2DomainEvent) =>
  event.type === "thread.deleted" ||
  event.type === "thread.restored" ||
  event.type === "thread.purged";

const makeSweep = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const random = yield* SecureRandom.SecureRandom;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsThreadTrashPurge(event) ? due.invalidate : Effect.void,
    ),
  );
  return Effect.fn("ThreadTrashPurgeWorker.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (yield* due.isIdle(nowMs)) return;
    const roots = yield* projections.listDueThreadTrashRoots({
      nowMs,
      limit: THREAD_TRASH_PURGE_BATCH_LIMIT,
    });
    for (const root of roots) {
      // A rejected receipt is permanent: retries must get a new command id each attempt.
      const uuid = yield* random.uuidV4();
      const deletedAtMs = DateTime.toEpochMillis(root.deletedAt);
      yield* orchestrator
        .dispatch({
          type: "thread.purge",
          commandId: CommandId.make(`server:trash-purge:${root.threadId}:${deletedAtMs}:${uuid}`),
          threadId: root.threadId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.thread-trash-purge.dispatch-failed", {
              threadId: root.threadId,
              cause,
            }),
          ),
        );
    }
    // A batch always records the earliest remaining due time (or Infinity when the
    // table is empty); purged events bump `version`, so read the wake time after the
    // dispatches and record with a fresh version to keep idle ticks cheap.
    const next = (yield* projections.getThreadTrashWakeAt) ?? Infinity;
    yield* due.record(yield* due.version, next, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("thread-trash-purge", sweep());
  }),
);
