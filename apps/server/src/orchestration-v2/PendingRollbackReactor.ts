import { CommandId, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/**
 * Resumes a rewind once a run update shows the thread may have settled.
 * `waiting` is not settled: its capture is still queued ahead of any rollback.
 * Per-event: the subscription is the span, and most events return immediately.
 */
export class PendingRollbackReactor extends Context.Service<
  PendingRollbackReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (stored: OrchestrationV2StoredEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PendingRollbackReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const handle: PendingRollbackReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (stored) {
      const { event, sequence } = stored;
      const checkpointLanded = event.type === "checkpoint.captured";
      const runSettled =
        event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status);
      if (!checkpointLanded && !runSettled) return;
      const thread = yield* projections.getThread(event.threadId);
      const pending = thread.pendingRollback;
      if (pending == null || thread.deletedAt !== null) return;
      // The sequence keeps an earlier no-op receipt from swallowing the resume after settle.
      yield* engine.dispatch({
        type: "checkpoint.rollback.resume",
        commandId: CommandId.make(
          `server:checkpoint.rollback.resume:${event.threadId}:${pending.requestId}:${sequence}`,
        ),
        threadId: event.threadId,
        requestId: pending.requestId,
      });
    },
    (effect, stored) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("resuming a pending rewind failed", {
            threadId: stored.event.threadId,
            sequence: stored.sequence,
            cause,
          }),
        ),
      ),
  );

  const start: PendingRollbackReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamLiveStoredEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pending rewind event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies PendingRollbackReactor["Service"];
});

export const layer = Layer.effect(PendingRollbackReactor, make);
