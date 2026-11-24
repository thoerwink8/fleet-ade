import { assert, it, vi } from "@effect/vitest";
import type { OrchestrationV2CheckpointScope } from "@t3tools/contracts";
import {
  CheckpointId,
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as PendingRollbackReactor from "./PendingRollbackReactor.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const driver = ProviderDriverKind.make("codex");
let providerCanInterrupt = true;
const adapter = {
  instanceId,
  driver,
  getCapabilities: () =>
    Effect.succeed(
      providerCanInterrupt
        ? CodexProviderCapabilitiesV2
        : {
            ...CodexProviderCapabilitiesV2,
            turns: { ...CodexProviderCapabilitiesV2.turns, supportsInterrupt: false },
          },
    ),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(ThreadManagementService.layer, PendingRollbackReactor.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop-and-rollback" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:stop-and-rollback"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

const effectTypes = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly effect_type: string; readonly status: string }>`
      SELECT effect_type, status FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId}
      ORDER BY rowid
    `;
    return rows.map((row) => `${row.effect_type}:${row.status}`);
  });

it.effect(
  "stop-and-rollback while a turn is running records the interrupt and the pending rewind",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:stop-rewind-running");
      yield* createThread(threadId);
      yield* send(threadId, "first");
      const commandId = CommandId.make("stop-rewind-running");
      yield* orchestrator.dispatch({
        type: "thread.stop-and-rollback",
        commandId,
        threadId,
        turnCount: 0,
        restoreFiles: false,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isTrue(projection.turnItems.some((item) => item.type === "run_interrupt_request"));
      assert.deepEqual(projection.thread.pendingRollback?.requestId, commandId);
      assert.equal(projection.thread.pendingRollback?.turnCount, 0);
      assert.equal(projection.thread.pendingRollback?.restoreFiles, false);
      assert.equal(projection.thread.rollbackRequestId, commandId);
      assert.isNull(projection.thread.rollbackFailure);
      assert.notInclude(yield* effectTypes(threadId), "provider-thread.rollback:pending");
      assert.notInclude(yield* effectTypes(threadId), "provider-thread.rollback:succeeded");
      // Same as thread.stop: a run stopped before its provider turn started never starts it.
      assert.include(yield* effectTypes(threadId), "provider-turn.start:cancelled");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to wait for a stop the provider cannot perform", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:stop-rewind-no-interrupt");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    providerCanInterrupt = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        providerCanInterrupt = true;
      }),
    );
    const refused = yield* orchestrator
      .dispatch({
        type: "thread.stop-and-rollback",
        commandId: CommandId.make("stop-rewind-no-interrupt"),
        threadId,
        turnCount: 0,
        restoreFiles: false,
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorRollbackRejectedError");
    if (refused._tag === "OrchestratorRollbackRejectedError") {
      assert.equal(refused.code, "provider-cannot-interrupt");
    }
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.pendingRollback ?? null);
    assert.isFalse(projection.turnItems.some((item) => item.type === "run_interrupt_request"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "after the turn settles, capture runs before the rewind and the pending rewind completes",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const reactor = yield* PendingRollbackReactor.PendingRollbackReactor;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const rollbackThread = vi.fn(
        ({ providerThread }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
          Effect.succeed({ providerThread }),
      );
      const open = vi.spyOn(sessions, "open").mockReturnValue(
        Effect.succeed({
          rollbackThread,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => open.mockRestore()));
      const threadId = ThreadId.make("thread:stop-rewind-settled");
      yield* createThread(threadId);
      yield* send(threadId, "first");
      yield* send(threadId, "queued");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:thread:stop-rewind-settled:held"),
        threadId,
        messageId: MessageId.make("message:thread:stop-rewind-settled:held"),
        text: "held",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs.find((candidate) => candidate.status !== "queued")!;
      const attempt = before.attempts.find((candidate) => candidate.id === run.activeAttemptId)!;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("promote-running"),
        events: [
          {
            id: EventId.make("promote-running-run"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "running", startedAt: now },
          },
          {
            id: EventId.make("promote-running-attempt"),
            type: "run-attempt.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...attempt, status: "running", startedAt: now },
          },
          {
            id: EventId.make("promote-running-turn"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: ProviderTurnId.make("turn:stop-rewind-settled"),
              providerThreadId: run.providerThreadId!,
              nodeId: run.rootNodeId!,
              runAttemptId: run.activeAttemptId,
              nativeTurnRef: null,
              ordinal: run.ordinal,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        ],
      });
      const commandId = CommandId.make("stop-rewind-settled");
      yield* orchestrator.dispatch({
        type: "thread.stop-and-rollback",
        commandId,
        threadId,
        turnCount: 0,
        restoreFiles: false,
      });
      assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.pendingRollback);
      assert.notInclude(
        (yield* effectTypes(threadId)).filter((row) => row.startsWith("provider-thread.rollback")),
        "provider-thread.rollback:pending",
      );

      yield* worker.drain();
      const captured = yield* eventSink
        .readByCommandId({
          commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
        })
        .pipe(Stream.runCollect);
      const checkpointEvent = captured.find(
        (stored) => stored.event.type === "checkpoint.captured",
      );
      assert.isTrue(checkpointEvent !== undefined);
      yield* reactor.handle(checkpointEvent!);
      yield* worker.drain();

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(projection.thread.pendingRollback);
      // The client waits on the id it sent, not on an internal resume id.
      assert.equal(
        projection.thread.rollbackCompletedRequestId,
        projection.thread.rollbackRequestId,
      );
      assert.ok(projection.runs.some((candidate) => candidate.status === "rolled_back"));
      const queued = projection.runs.find((candidate) => candidate.status === "queued");
      assert.equal(queued?.queueHeld, true);
      const order = (yield* effectTypes(threadId)).map((row) => row.split(":")[0]);
      const captureAt = order.indexOf("checkpoint.capture");
      const rollbackAt = order.indexOf("provider-thread.rollback");
      assert.isAbove(captureAt, -1);
      assert.isAbove(rollbackAt, captureAt);
      const [rollbackEffect] = yield* outbox.listByCommandId(
        CommandId.make(projection.thread.rollbackCompletedRequestId!),
      );
      assert.equal(rollbackEffect?.status, "succeeded");
      assert.equal(
        projection.checkpoints.some(
          (checkpoint) => checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null,
        ),
        true,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rewinds to checkpoint 0 produced by the stopped first turn's capture", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const open = vi.spyOn(sessions, "open").mockReturnValue(
      Effect.succeed({
        rollbackThread: ({
          providerThread,
        }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
          Effect.succeed({ providerThread }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => open.mockRestore()));
    const threadId = ThreadId.make("thread:stop-rewind-baseline");
    yield* createThread(threadId);
    yield* send(threadId, "only");
    const before = yield* orchestrator.getThreadProjection(threadId);
    const run = before.runs[0]!;
    const attempt = before.attempts[0]!;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make("baseline-running"),
      events: [
        {
          id: EventId.make("baseline-running-run"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "running", startedAt: now },
        },
        {
          id: EventId.make("baseline-running-attempt"),
          type: "run-attempt.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...attempt, status: "running", startedAt: now },
        },
        {
          id: EventId.make("baseline-running-turn"),
          type: "provider-turn.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make("turn:baseline"),
            providerThreadId: run.providerThreadId!,
            nodeId: run.rootNodeId!,
            runAttemptId: run.activeAttemptId,
            nativeTurnRef: null,
            ordinal: run.ordinal,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-baseline"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    yield* worker.drain();
    const captured = yield* eventSink
      .readByCommandId({
        commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
      })
      .pipe(Stream.runCollect);
    const checkpointEvent = captured.find((stored) => stored.event.type === "checkpoint.captured");
    assert.isTrue(checkpointEvent !== undefined);
    yield* (yield* PendingRollbackReactor.PendingRollbackReactor).handle(checkpointEvent!);
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const baseline = projection.checkpoints.find(
      (checkpoint) => checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null,
    );
    assert.isTrue(baseline !== undefined);
    assert.equal(projection.runs[0]?.status, "rolled_back");
    assert.isNull(projection.thread.pendingRollback);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("completes the rewind after an unresponsive interrupt is force-stopped", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const open = vi.spyOn(sessions, "open").mockReturnValue(
      Effect.succeed({
        rollbackThread: ({
          providerThread,
        }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
          Effect.succeed({ providerThread }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => open.mockRestore()));
    const getSession = vi.spyOn(sessions, "get").mockReturnValue(
      Effect.succeedSome({
        interruptTurn: () =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterInterruptTimeoutError({
              driver,
              providerThreadId: ProviderThreadId.make("provider-thread:force"),
              providerTurnId: ProviderTurnId.make("turn:force"),
              timeoutMs: 15_000,
            }),
          ),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => getSession.mockRestore()));
    const threadId = ThreadId.make("thread:stop-rewind-force");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    const before = yield* orchestrator.getThreadProjection(threadId);
    const run = before.runs[0]!;
    const attempt = before.attempts[0]!;
    const now = yield* DateTime.now;
    const providerTurnId = ProviderTurnId.make("turn:force");
    yield* eventSink.write({
      commandId: CommandId.make("force-running"),
      events: [
        {
          id: EventId.make("force-running-run"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "running", startedAt: now },
        },
        {
          id: EventId.make("force-running-attempt"),
          type: "run-attempt.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...attempt, status: "running", startedAt: now },
        },
        {
          id: EventId.make("force-running-session"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...before.providerThreads.find((thread) => thread.id === run.providerThreadId)!,
            providerSessionId: ProviderSessionId.make("session:force"),
            updatedAt: now,
          },
        },
        {
          id: EventId.make("force-running-turn"),
          type: "provider-turn.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: providerTurnId,
            providerThreadId: run.providerThreadId!,
            nodeId: run.rootNodeId!,
            runAttemptId: run.activeAttemptId,
            nativeTurnRef: null,
            ordinal: run.ordinal,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-force"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    yield* orchestrator.dispatch({
      type: "thread.interrupt.unresponsive",
      commandId: CommandId.make("stop-rewind-force-unresponsive"),
      threadId,
      providerThreadId: run.providerThreadId!,
      providerTurnId,
    });
    assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status, "running");
    yield* threads.forceStopThread({ threadId });
    yield* worker.drain();
    const captured = yield* eventSink
      .readByCommandId({
        commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
      })
      .pipe(Stream.runCollect);
    const checkpointEvent = captured.find((stored) => stored.event.type === "checkpoint.captured");
    if (checkpointEvent !== undefined) {
      yield* (yield* PendingRollbackReactor.PendingRollbackReactor).handle(checkpointEvent);
      yield* worker.drain();
    } else {
      yield* orchestrator.resumePendingRollbacks;
      yield* worker.drain();
    }
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.runs[0]?.status, "rolled_back");
    assert.isNull(projection.thread.pendingRollback);
    assert.isTrue(projection.thread.rollbackCompletedRequestId !== undefined);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("records a typed failure when the target is gone after the turn settles", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:stop-rewind-invalid");
    yield* createThread(threadId);
    yield* send(threadId, "kept");
    const before = yield* orchestrator.getThreadProjection(threadId);
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-invalid"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    yield* orchestrator.resumePendingRollbacks;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.thread.rollbackFailure?.code, "target-invalid");
    assert.isNull(projection.thread.pendingRollback);
    assert.equal(projection.runs[0]?.status, "interrupted");
    assert.equal(projection.messages.length, before.messages.length);
    assert.notInclude(yield* effectTypes(threadId), "provider-thread.rollback:pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "refuses to restore files from a missing checkpoint and still rewinds the conversation",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:stop-rewind-missing");
      yield* createThread(threadId);
      yield* send(threadId, "done");
      const started = yield* orchestrator.getThreadProjection(threadId);
      const run = started.runs[0]!;
      const scope = started.checkpointScopes[0]!;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("missing-seed"),
        events: [
          {
            id: EventId.make("missing-settle"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "interrupted", completedAt: now },
          },
          {
            id: EventId.make("missing-checkpoint"),
            type: "checkpoint.captured",
            threadId,
            occurredAt: now,
            payload: {
              id: CheckpointId.make("checkpoint:missing"),
              threadId,
              scopeId: scope.id,
              runId: null,
              nodeId: scope.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: null,
              ref: CheckpointRef.make("refs/t3/missing"),
              status: "missing",
              files: [],
              capturedAt: now,
            },
          },
        ],
      });
      const files = yield* orchestrator
        .dispatch({
          type: "thread.stop-and-rollback",
          commandId: CommandId.make("stop-rewind-missing-files"),
          threadId,
          turnCount: 0,
          restoreFiles: true,
        })
        .pipe(Effect.flip);
      assert.equal(files._tag, "OrchestratorRollbackRejectedError");
      if (files._tag === "OrchestratorRollbackRejectedError") {
        assert.equal(files.code, "checkpoint-missing");
      }
      assert.deepEqual(
        yield* outbox.listByCommandId(CommandId.make("stop-rewind-missing-files")),
        [],
      );
      const conversation = yield* orchestrator.dispatch({
        type: "thread.stop-and-rollback",
        commandId: CommandId.make("stop-rewind-missing-conversation"),
        threadId,
        turnCount: 0,
        restoreFiles: false,
      });
      assert.deepEqual(
        conversation.storedEvents.map((stored) => stored.event.type),
        ["thread.metadata-updated", "checkpoint.rollback-requested"],
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(CommandId.make("stop-rewind-missing-conversation"))).map(
          (effect) => effect.request.type,
        ),
        ["provider-thread.rollback"],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rejects a send and a second rewind while one is pending, and a plain stop leaves it pending",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:stop-rewind-pending");
      yield* createThread(threadId);
      yield* send(threadId, "work");
      yield* orchestrator.dispatch({
        type: "thread.stop-and-rollback",
        commandId: CommandId.make("stop-rewind-pending"),
        threadId,
        turnCount: 0,
        restoreFiles: false,
      });
      const sendAgain = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("send-while-pending"),
          threadId,
          messageId: MessageId.make("message:while-pending"),
          text: "nope",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.flip);
      assert.equal(sendAgain._tag, "OrchestratorRollbackRejectedError");
      if (sendAgain._tag === "OrchestratorRollbackRejectedError") {
        assert.equal(sendAgain.code, "pending-rollback");
      }
      const second = yield* orchestrator
        .dispatch({
          type: "thread.stop-and-rollback",
          commandId: CommandId.make("stop-rewind-pending-again"),
          threadId,
          turnCount: 0,
          restoreFiles: false,
        })
        .pipe(Effect.flip);
      assert.equal(second._tag, "OrchestratorRollbackRejectedError");
      if (second._tag === "OrchestratorRollbackRejectedError") {
        assert.equal(second.code, "rollback-already-pending");
      }
      const stopped = yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("plain-stop-while-pending"),
        threadId,
      });
      assert.equal(stopped.replayed, undefined);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.thread.pendingRollback?.requestId,
        CommandId.make("stop-rewind-pending"),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("cancel clears the pending rewind and a later settled run does not rewind", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const reactor = yield* PendingRollbackReactor.PendingRollbackReactor;
    const threadId = ThreadId.make("thread:stop-rewind-cancel");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    yield* threads.stopAndRollbackThread({
      commandId: CommandId.make("stop-rewind-cancel"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    yield* threads.cancelPendingRollback({
      commandId: CommandId.make("cancel-pending"),
      threadId,
    });
    assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.pendingRollback);
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs[0]!;
    yield* reactor.handle({
      sequence: 10_000,
      commandId: null,
      event: {
        id: EventId.make("cancel-later-run"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: yield* DateTime.now,
        payload: run,
      },
    });
    assert.notInclude(yield* effectTypes(threadId), "provider-thread.rollback:pending");
    assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.pendingRollback);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("startup resumes a pending rewind once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const open = vi.spyOn(sessions, "open").mockReturnValue(
      Effect.succeed({
        rollbackThread: ({
          providerThread,
        }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
          Effect.succeed({ providerThread }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => open.mockRestore()));
    const threadId = ThreadId.make("thread:stop-rewind-restart");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    const before = yield* orchestrator.getThreadProjection(threadId);
    const run = before.runs[0]!;
    const scope = before.checkpointScopes[0]!;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make("restart-seed"),
      events: [
        {
          id: EventId.make("restart-settle"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        },
        {
          id: EventId.make("restart-checkpoint"),
          type: "checkpoint.captured",
          threadId,
          occurredAt: now,
          payload: {
            id: CheckpointId.make("checkpoint:restart"),
            threadId,
            scopeId: scope.id,
            runId: null,
            nodeId: scope.nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            ref: CheckpointRef.make("refs/t3/restart"),
            status: "missing",
            files: [],
            capturedAt: now,
          },
        },
        {
          id: EventId.make("restart-pending"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: {
            ...before.thread,
            pendingRollback: {
              requestId: CommandId.make("stop-rewind-restart"),
              turnCount: 0,
              restoreFiles: false,
              requestedAt: now,
            },
            rollbackRequestId: CommandId.make("stop-rewind-restart"),
            rollbackFailure: null,
            updatedAt: now,
          },
        },
      ],
    });
    assert.equal(yield* orchestrator.resumePendingRollbacks, 1);
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.runs[0]?.status, "rolled_back");
    assert.isNull(projection.thread.pendingRollback);
    assert.equal(yield* orchestrator.resumePendingRollbacks, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an idle rewind emits the same events as checkpoint.rollback", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const prepare = (name: string) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`thread:idle-${name}`);
        yield* createThread(threadId);
        yield* send(threadId, name);
        const started = yield* orchestrator.getThreadProjection(threadId);
        const run = started.runs[0]!;
        const scope = started.checkpointScopes[0]!;
        const now = yield* DateTime.now;
        const checkpointId = CheckpointId.make(`checkpoint:${name}`);
        yield* (yield* EventSink.EventSinkV2).write({
          commandId: CommandId.make(`idle-seed:${name}`),
          events: [
            {
              id: EventId.make(`idle-settle:${name}`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "interrupted", completedAt: now },
            },
            {
              id: EventId.make(`idle-checkpoint:${name}`),
              type: "checkpoint.captured",
              threadId,
              occurredAt: now,
              payload: {
                id: checkpointId,
                threadId,
                scopeId: scope.id,
                runId: null,
                nodeId: scope.nodeId,
                parentCheckpointId: null,
                ordinalWithinScope: 0,
                appRunOrdinal: null,
                ref: CheckpointRef.make(`refs/t3/${name}`),
                status: "ready",
                files: [],
                capturedAt: now,
              },
            },
          ],
        });
        return { threadId, checkpointId, scopeId: scope.id };
      });
    const direct = yield* prepare("direct");
    const combined = yield* prepare("combined");
    const directResult = yield* orchestrator.dispatch({
      type: "checkpoint.rollback",
      commandId: CommandId.make("idle-direct"),
      threadId: direct.threadId,
      checkpointId: direct.checkpointId,
      scopeId: direct.scopeId,
      restoreFiles: false,
    });
    const combinedResult = yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("idle-combined"),
      threadId: combined.threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    assert.deepEqual(
      combinedResult.storedEvents.map((stored) => stored.event.type),
      directResult.storedEvents.map((stored) => stored.event.type),
    );
    assert.deepEqual(
      (yield* outbox.listByCommandId(CommandId.make("idle-combined"))).map(
        (effect) => effect.request.type,
      ),
      (yield* outbox.listByCommandId(CommandId.make("idle-direct"))).map(
        (effect) => effect.request.type,
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a provider that still has the turn fails the rewind as retryable, or asks for force stop",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      let rollbackCalls = 0;
      const open = vi.spyOn(sessions, "open").mockReturnValue(
        Effect.succeed({
          rollbackThread: ({
            providerThread,
          }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) => {
            rollbackCalls += 1;
            try {
              return Effect.fail(
                new ProviderAdapter.ProviderAdapterRollbackThreadError({
                  driver,
                  providerThreadId: providerThread.id,
                  cause: new ProviderAdapter.ProviderAdapterProtocolError({
                    driver,
                    detail: "Cannot roll back while the turn is active",
                    reason: "previous_turn_active",
                  }),
                }),
              );
            } catch (error) {
              return Effect.fail(
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver,
                  detail: error instanceof Error ? error.message : String(error),
                  reason: "previous_turn_active",
                }),
              );
            }
          },
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => open.mockRestore()));
      const threadId = ThreadId.make("thread:stop-rewind-active-turn");
      yield* createThread(threadId);
      yield* send(threadId, "work");
      const started = yield* orchestrator.getThreadProjection(threadId);
      const run = started.runs[0]!;
      const scope = started.checkpointScopes[0]!;
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("active-turn-seed"),
        events: [
          {
            id: EventId.make("active-turn-settle"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "interrupted", completedAt: now },
          },
          {
            id: EventId.make("active-turn-checkpoint"),
            type: "checkpoint.captured",
            threadId,
            occurredAt: now,
            payload: {
              id: CheckpointId.make("checkpoint:active-turn"),
              threadId,
              scopeId: scope.id,
              runId: null,
              nodeId: scope.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: null,
              ref: CheckpointRef.make("refs/t3/active-turn"),
              status: "missing",
              files: [],
              capturedAt: now,
            },
          },
          {
            id: EventId.make("active-turn-request"),
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("item:unresponsive"),
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId!,
              providerThreadId: run.providerThreadId!,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 50,
              status: "completed",
              title: "已请求中断",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "run_interrupt_request",
              message: "Stopped by user",
              unresponsiveAt: now,
            },
          },
          {
            id: EventId.make("active-turn-pending"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: {
              ...started.thread,
              pendingRollback: {
                requestId: CommandId.make("stop-rewind-active-turn"),
                turnCount: 0,
                restoreFiles: false,
                requestedAt: now,
              },
              rollbackRequestId: CommandId.make("resume-active-turn"),
              rollbackFailure: null,
              updatedAt: now,
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "checkpoint.rollback.resume",
        commandId: CommandId.make("resume-active-turn"),
        threadId,
        requestId: CommandId.make("stop-rewind-active-turn"),
      });
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* worker.drain();
        yield* TestClock.adjust("30 seconds");
      }
      const failed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(failed.thread.rollbackFailure?.code, "interrupt-unresponsive");
      assert.equal(
        failed.thread.rollbackFailure?.message,
        "The agent did not stop. Force stop it, then rewind.",
      );
      assert.isNull(failed.thread.pendingRollback);
      assert.isAbove(rollbackCalls, 0);
      assert.equal(
        failed.thread.rollbackFailure?.message,
        "The agent did not stop. Force stop it, then rewind.",
      );
      assert.isNull(failed.thread.pendingRollback);
    }).pipe(Effect.provide(layerTest)),
);

const promoteRunToRunning = Effect.fn("promoteRunToRunning")(function* (
  threadId: ThreadId,
  prefix: string,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const before = yield* orchestrator.getThreadProjection(threadId);
  const run = before.runs.find((candidate) => candidate.status !== "queued")!;
  const attempt = before.attempts.find((candidate) => candidate.id === run.activeAttemptId)!;
  const now = yield* DateTime.now;
  yield* eventSink.write({
    commandId: CommandId.make(`${prefix}:running`),
    events: [
      {
        id: EventId.make(`${prefix}:running-run`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "running", startedAt: now },
      },
      {
        id: EventId.make(`${prefix}:running-attempt`),
        type: "run-attempt.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...attempt, status: "running", startedAt: now },
      },
      {
        id: EventId.make(`${prefix}:running-turn`),
        type: "provider-turn.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`${prefix}:turn`),
          providerThreadId: run.providerThreadId!,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId,
          nativeTurnRef: null,
          ordinal: run.ordinal,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
    ],
  });
  return { run, attempt };
});

const seedCheckpoint = (
  threadId: ThreadId,
  scope: OrchestrationV2CheckpointScope,
  name: string,
  status: "ready" | "missing",
) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make(`${name}:checkpoint-seed`),
      events: [
        {
          id: EventId.make(`${name}:checkpoint`),
          type: "checkpoint.captured",
          threadId,
          occurredAt: now,
          payload: {
            id: CheckpointId.make(`checkpoint:${name}`),
            threadId,
            scopeId: scope.id,
            runId: null,
            nodeId: scope.nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            ref: CheckpointRef.make(`refs/t3/${name}`),
            status,
            files: [],
            capturedAt: now,
          },
        },
      ],
    });
    return CheckpointId.make(`checkpoint:${name}`);
  });

const mockRollbackSuccess = Effect.gen(function* () {
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const open = vi.spyOn(sessions, "open").mockReturnValue(
    Effect.succeed({
      rollbackThread: ({ providerThread }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
        Effect.succeed({ providerThread }),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => open.mockRestore()));
  return open;
});

const rollbackEffectCount = (threadId: ThreadId) =>
  Effect.map(
    effectTypes(threadId),
    (rows) =>
      rows.filter(
        (row) =>
          row === "provider-thread.rollback:pending" ||
          row === "provider-thread.rollback:succeeded",
      ).length,
  );

it.effect("a thread deleted while a rewind is pending is left alone, even after restart", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make("thread:stop-rewind-delete");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    yield* promoteRunToRunning(threadId, "stop-rewind-delete");
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-delete"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.pendingRollback);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-while-pending"),
      threadId,
    });
    const deleted = yield* orchestrator.getThreadProjection(threadId);
    assert.isNotNull(deleted.thread.deletedAt);
    assert.isNull(deleted.thread.pendingRollback);
    yield* worker.drain();
    // A deleted thread must not be rolled back or touched again by startup recovery.
    assert.equal(yield* orchestrator.resumePendingRollbacks, 0);
    yield* worker.drain();
    assert.equal(yield* rollbackEffectCount(threadId), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a pending rewind survives archive and unarchive and still completes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const reactor = yield* PendingRollbackReactor.PendingRollbackReactor;
    yield* mockRollbackSuccess;
    const threadId = ThreadId.make("thread:stop-rewind-archive");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    yield* promoteRunToRunning(threadId, "stop-rewind-archive");
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-archive"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-while-pending"),
      threadId,
    });
    let projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNotNull(projection.thread.archivedAt);
    assert.isNotNull(projection.thread.pendingRollback);
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive-while-pending"),
      threadId,
    });
    projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.archivedAt);
    assert.isNotNull(projection.thread.pendingRollback);
    yield* worker.drain();
    const captured = yield* eventSink
      .readByCommandId({
        commandId: CommandId.make(`command:effect:checkpoint.capture:${projection.runs[0]!.id}`),
      })
      .pipe(Stream.runCollect);
    const checkpointEvent = captured.find((stored) => stored.event.type === "checkpoint.captured");
    if (checkpointEvent !== undefined) yield* reactor.handle(checkpointEvent);
    yield* worker.drain();
    projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.pendingRollback);
    assert.isNotNull(projection.thread.rollbackCompletedRequestId ?? null);
    assert.ok(projection.runs.some((candidate) => candidate.status === "rolled_back"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a plain checkpoint.rollback while a rewind is pending is refused once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const reactor = yield* PendingRollbackReactor.PendingRollbackReactor;
    yield* mockRollbackSuccess;
    const threadId = ThreadId.make("thread:stop-rewind-double");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    const { run } = yield* promoteRunToRunning(threadId, "stop-rewind-double");
    const started = yield* orchestrator.getThreadProjection(threadId);
    const scope = started.checkpointScopes[0]!;
    const checkpointId = yield* seedCheckpoint(threadId, scope, "double", "ready");
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-double"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    const direct = yield* orchestrator
      .dispatch({
        type: "checkpoint.rollback",
        commandId: CommandId.make("direct-rollback-while-pending"),
        threadId,
        scopeId: scope.id,
        checkpointId,
        restoreFiles: false,
      })
      .pipe(Effect.flip);
    assert.equal(direct._tag, "OrchestratorRollbackRejectedError");
    if (direct._tag === "OrchestratorRollbackRejectedError") {
      assert.equal(direct.code, "rollback-already-pending");
    }
    const pending = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(pending.thread.pendingRollback?.requestId, CommandId.make("stop-rewind-double"));
    yield* worker.drain();
    const captured = yield* eventSink
      .readByCommandId({
        commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
      })
      .pipe(Stream.runCollect);
    const checkpointEvent = captured.find((stored) => stored.event.type === "checkpoint.captured");
    if (checkpointEvent !== undefined) yield* reactor.handle(checkpointEvent);
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.pendingRollback);
    // Exactly one rewind ran: the pending one, not the refused direct command.
    assert.equal(yield* rollbackEffectCount(threadId), 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a queued run stays held while the rewind is pending and after it completes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const reactor = yield* PendingRollbackReactor.PendingRollbackReactor;
    yield* mockRollbackSuccess;
    const threadId = ThreadId.make("thread:stop-rewind-queue");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send:stop-rewind-queue:held"),
      threadId,
      messageId: MessageId.make("message:stop-rewind-queue:held"),
      text: "held",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* promoteRunToRunning(threadId, "stop-rewind-queue");
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-queue"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    let projection = yield* orchestrator.getThreadProjection(threadId);
    const queued = projection.runs.find((candidate) => candidate.status === "queued");
    assert.equal(queued?.queueHeld, true);
    const run = projection.runs.find((candidate) => candidate.status !== "queued")!;
    yield* worker.drain();
    projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(
      projection.runs.find((candidate) => candidate.status === "queued")?.queueHeld,
      true,
    );
    const captured = yield* eventSink
      .readByCommandId({
        commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
      })
      .pipe(Stream.runCollect);
    const checkpointEvent = captured.find((stored) => stored.event.type === "checkpoint.captured");
    if (checkpointEvent !== undefined) yield* reactor.handle(checkpointEvent);
    yield* worker.drain();
    projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.pendingRollback);
    // Same as an idle rewind: the held queue entry stays queued for later.
    assert.equal(
      projection.runs.find((candidate) => candidate.status === "queued")?.queueHeld,
      true,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the reactor's live subscription resumes and completes the rewind", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const reactor = yield* PendingRollbackReactor.PendingRollbackReactor;
    yield* mockRollbackSuccess;
    const threadId = ThreadId.make("thread:stop-rewind-live");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-live"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    const rollbackRequested = yield* Deferred.make<void>();
    yield* Stream.runForEach(orchestrator.streamLiveStoredEvents, (stored) =>
      stored.event.type === "checkpoint.rollback-requested" && stored.event.threadId === threadId
        ? Deferred.succeed(rollbackRequested, void 0)
        : Effect.void,
    ).pipe(Effect.ignoreCause, Effect.forkScoped({ startImmediately: true }));
    yield* reactor.start();
    const projection0 = yield* orchestrator.getThreadProjection(threadId);
    const run = projection0.runs[0]!;
    const scope = projection0.checkpointScopes[0]!;
    yield* seedCheckpoint(threadId, scope, "live", "ready");
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make("live-settle"),
      events: [
        {
          id: EventId.make("live-settle-run"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        },
      ],
    });
    yield* worker.drain();
    // The reactor dispatches the resume from the captured checkpoint's real subscription event.
    yield* Deferred.await(rollbackRequested);
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.pendingRollback);
    assert.equal(projection.thread.rollbackCompletedRequestId, CommandId.make("stop-rewind-live"));
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("two restarts during a pending rewind still roll back exactly once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* mockRollbackSuccess;
    const threadId = ThreadId.make("thread:stop-rewind-twice");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    const { run } = yield* promoteRunToRunning(threadId, "stop-rewind-twice");
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-twice"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    // Restart 1: run still active, so the resume no-ops and pending stays.
    yield* orchestrator.resumePendingRollbacks;
    assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.pendingRollback);
    // Restart 2: still not settled, pending survives another sweep.
    yield* orchestrator.resumePendingRollbacks;
    assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.pendingRollback);
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make("twice-settle"),
      events: [
        {
          id: EventId.make("twice-settle-run"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        },
      ],
    });
    yield* worker.drain();
    const resumed = yield* orchestrator.resumePendingRollbacks;
    assert.equal(resumed, 1);
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.pendingRollback);
    assert.equal(yield* rollbackEffectCount(threadId), 1);
    assert.equal(yield* orchestrator.resumePendingRollbacks, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("two sweeps racing after the thread settles roll back exactly once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* mockRollbackSuccess;
    const threadId = ThreadId.make("thread:stop-rewind-racing-sweeps");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    const { run } = yield* promoteRunToRunning(threadId, "stop-rewind-racing-sweeps");
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-racing-sweeps"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make("racing-sweeps-settle"),
      events: [
        {
          id: EventId.make("racing-sweeps-settle-run"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        },
      ],
    });
    yield* worker.drain();
    // Each sweep gets its own internal command id, so only the thread lock and the
    // pending requestId keep the second sweep from queueing a second rewind.
    yield* Effect.all([orchestrator.resumePendingRollbacks, orchestrator.resumePendingRollbacks], {
      concurrency: "unbounded",
    });
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.pendingRollback);
    assert.equal(yield* rollbackEffectCount(threadId), 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("cancel before settle prevents the rewind entirely", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:stop-rewind-cancel-first");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    const { run } = yield* promoteRunToRunning(threadId, "stop-rewind-cancel-first");
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-cancel-first"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    yield* orchestrator.dispatch({
      type: "thread.pending-rollback.cancel",
      commandId: CommandId.make("cancel-before-settle"),
      threadId,
    });
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make("cancel-settle"),
      events: [
        {
          id: EventId.make("cancel-settle-run"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "checkpoint.rollback.resume",
      commandId: CommandId.make("resume-after-cancel"),
      threadId,
      requestId: CommandId.make("stop-rewind-cancel-first"),
    });
    yield* worker.drain();
    assert.equal(yield* rollbackEffectCount(threadId), 0);
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.rollbackCompletedRequestId ?? null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("resume before cancel finishes the rewind and the cancel is a harmless no-op", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* mockRollbackSuccess;
    const threadId = ThreadId.make("thread:stop-rewind-resume-first");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    const { run } = yield* promoteRunToRunning(threadId, "stop-rewind-resume-first");
    const started = yield* orchestrator.getThreadProjection(threadId);
    const scope = started.checkpointScopes[0]!;
    yield* seedCheckpoint(threadId, scope, "resume-first", "ready");
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: CommandId.make("stop-rewind-resume-first"),
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make("resume-settle"),
      events: [
        {
          id: EventId.make("resume-settle-run"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "checkpoint.rollback.resume",
      commandId: CommandId.make("resume-before-cancel"),
      threadId,
      requestId: CommandId.make("stop-rewind-resume-first"),
    });
    yield* worker.drain();
    yield* orchestrator.dispatch({
      type: "thread.pending-rollback.cancel",
      commandId: CommandId.make("cancel-after-resume"),
      threadId,
    });
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(projection.thread.pendingRollback);
    assert.equal(
      projection.thread.rollbackCompletedRequestId,
      CommandId.make("stop-rewind-resume-first"),
    );
    assert.equal(yield* rollbackEffectCount(threadId), 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a provider turn still active fails retryable and clears the pending rewind", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const open = vi.spyOn(sessions, "open").mockReturnValue(
      Effect.succeed({
        rollbackThread: ({
          providerThread,
        }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver,
              providerThreadId: providerThread.id,
              cause: new ProviderAdapter.ProviderAdapterProtocolError({
                driver,
                detail: "Cannot roll back while the turn is active",
                reason: "previous_turn_active",
              }),
            }),
          ),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => open.mockRestore()));
    const threadId = ThreadId.make("thread:stop-rewind-provider-active");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    const { run } = yield* promoteRunToRunning(threadId, "stop-rewind-provider-active");
    const started = yield* orchestrator.getThreadProjection(threadId);
    const scope = started.checkpointScopes[0]!;
    yield* seedCheckpoint(threadId, scope, "provider-active", "ready");
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make("provider-active-seed"),
      events: [
        {
          id: EventId.make("provider-active-settle"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        },
        {
          id: EventId.make("provider-active-pending"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: {
            ...started.thread,
            pendingRollback: {
              requestId: CommandId.make("stop-rewind-provider-active"),
              turnCount: 0,
              restoreFiles: false,
              requestedAt: now,
            },
            rollbackRequestId: CommandId.make("stop-rewind-provider-active"),
            rollbackFailure: null,
            updatedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "checkpoint.rollback.resume",
      commandId: CommandId.make("resume-provider-active"),
      threadId,
      requestId: CommandId.make("stop-rewind-provider-active"),
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      yield* worker.drain();
      yield* TestClock.adjust("30 seconds");
    }
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(projection.thread.rollbackFailure?.code, "provider-turn-active");
    assert.isNull(projection.thread.pendingRollback);
    // Clearing pending means a retry command is accepted instead of staying blocked.
    const retryId = CommandId.make("stop-rewind-provider-retry");
    yield* orchestrator.dispatch({
      type: "thread.stop-and-rollback",
      commandId: retryId,
      threadId,
      turnCount: 0,
      restoreFiles: false,
    });
    assert.equal(
      (yield* orchestrator.getThreadProjection(threadId)).thread.rollbackRequestId,
      retryId,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an idle rewind records the client's command id and one metadata event", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const eventSink = yield* EventSink.EventSinkV2;
    yield* mockRollbackSuccess;
    const threadId = ThreadId.make("thread:idle-rewind-receipt");
    yield* createThread(threadId);
    yield* send(threadId, "work");
    const started = yield* orchestrator.getThreadProjection(threadId);
    const run = started.runs[0]!;
    const scope = started.checkpointScopes[0]!;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make("idle-receipt-seed"),
      events: [
        {
          id: EventId.make("idle-receipt-settle"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        },
      ],
    });
    const checkpointId = yield* seedCheckpoint(threadId, scope, "idle-receipt", "ready");
    const beforeRollback = yield* eventSink.latestSequence({ threadId });
    const commandId = CommandId.make("idle-rewind-receipt");
    yield* orchestrator.dispatch({
      type: "checkpoint.rollback",
      commandId,
      threadId,
      scopeId: scope.id,
      checkpointId,
      restoreFiles: false,
    });
    yield* worker.drain();
    const projection = yield* orchestrator.getThreadProjection(threadId);
    // The client waits on the id it sent, so completion is recorded under it.
    assert.equal(projection.thread.rollbackCompletedRequestId, commandId);
    const events = yield* eventSink.stream({ threadId, afterSequence: beforeRollback }).pipe(
      Stream.take(6),
      Stream.map((stored) => stored.event.type),
      Stream.runCollect,
    );
    assert.deepEqual(Array.from(events), [
      "thread.metadata-updated",
      "checkpoint.rollback-requested",
      "thread.metadata-updated",
      "provider-thread.updated",
      "run.updated",
      "node.updated",
    ]);
  }).pipe(Effect.provide(layerTest)),
);
