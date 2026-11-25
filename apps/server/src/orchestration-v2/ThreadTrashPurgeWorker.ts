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
    const rows = yield* projections.listThreadTrashRootsByDueAt({
      limit: THREAD_TRASH_PURGE_BATCH_LIMIT,
    });
    for (const root of rows) {
      if (root.purgeDueAt > nowMs) break;
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
    // Earliest purge_due_at doubles as the wake hint: rows are ordered, so the first row is
    // due whenever anything is due; a nonempty batch re-checks next tick in case the limit
    // cut off more work. Purged events bump `version` mid-batch, so record with a fresh one.
    const wakeAtMs =
      rows.length === 0
        ? Infinity
        : rows.some((root) => root.purgeDueAt <= nowMs)
          ? nowMs
          : rows[0]!.purgeDueAt;
    yield* due.record(yield* due.version, wakeAtMs, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("thread-trash-purge", sweep());
  }),
);
