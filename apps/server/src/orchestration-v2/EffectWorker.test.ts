import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import { SHARED_WORKSPACE_RESTORE_MESSAGE } from "./CheckpointRestoreSafety.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

const threadId = ThreadId.make("thread:effect-worker-restart");
const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");
const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");
const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");
const attemptId = RunAttemptId.make("run-attempt:effect-worker-restart");
const runId = RunId.make("run:effect-worker-restart");

function restartEffect(
  now: DateTime.Utc,
  sessionTransition: NonNullable<
    Extract<
      EffectOutbox.OrchestrationEffectV2["request"],
      { readonly type: "provider-turn.restart" }
    >["sessionTransition"]
  >,
): EffectOutbox.OrchestrationEffectV2 {
  const timestamp = DateTime.formatIso(now);
  return {
    id: `effect:restart:${sessionTransition.type}`,
    commandId: CommandId.make(`command:restart:${sessionTransition.type}`),
    threadId,
    request: {
      type: "provider-turn.restart",
      providerSessionId: oldSessionId,
      providerThreadId,
      providerTurnId,
      interruptedAttemptId: attemptId,
      runId,
      sessionTransition,
    },
    status: "running",
    attemptCount: 1,
    availableAt: timestamp,
    leaseOwner: "test-worker",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastError: null,
  };
}
const layerEventSinkMock = Layer.mock(EventSink.EventSinkV2)({
  setAwaitingSlot: () => Effect.void,
});

function layerExecutorFor(input: {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  readonly failFirstStart?: Ref.Ref<boolean>;
  readonly threads?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
  readonly continueAfterRestart?: boolean;
  readonly interrupt?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["interrupt"];
  readonly rollback?: CheckpointRollbackService.CheckpointRollbackServiceV2Shape["execute"];
  readonly recordSlotClear?: boolean;
  readonly respond?: RuntimeRequestService.RuntimeRequestServiceV2["Service"]["respond"];
}) {
  const record = (event: string) => Ref.update(input.events, (events) => [...events, event]);
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(
      ProviderTurnControlService.ProviderTurnControlServiceV2,
      ProviderTurnControlService.ProviderTurnControlServiceV2.of({
        interrupt: input.interrupt ?? (() => Effect.void),
        steer: () => Effect.void,
        applyModelSelection: () => Effect.void,
        interruptAndAwaitTerminal: (request) =>
          record(
            request.replacementProviderSessionId === undefined
              ? "interrupt"
              : `interrupt:${request.replacementProviderSessionId}`,
          ),
      }),
    ),
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      ProviderSessionManager.ProviderSessionManagerV2.of({
        shutdown: Effect.void,
        open: () => Effect.die("unused open"),
        get: () => Effect.succeedNone,
        isLive: () => Effect.succeed(false),
        close: () => Effect.void,
        closeInstance: () => Effect.void,
        release: () => record("release"),
        detach: () => record("detach"),
        otherWorkingThreads: () => Effect.succeed([]),
        releaseUnlessBusy: () => Effect.succeed(true),
        subscribePromptSuggestion: () => Stream.empty,
      }),
    ),
    Layer.succeed(
      ProviderTurnStartService.ProviderTurnStartServiceV2,
      ProviderTurnStartService.ProviderTurnStartServiceV2.of({
        start: () =>
          Effect.gen(function* () {
            yield* record("start");
            if (
              input.failFirstStart !== undefined &&
              (yield* Ref.getAndSet(input.failFirstStart, false))
            ) {
              return yield* new ProviderTurnStartService.ProviderTurnStartError({
                runId,
                cause: "simulated first start failure",
              });
            }
          }),
      }),
    ),
    Layer.succeed(
      RunFinalizationService.RunFinalizationService,
      RunFinalizationService.RunFinalizationService.of({ finalize: () => Effect.void }),
    ),
    Layer.succeed(
      CheckpointRollbackService.CheckpointRollbackServiceV2,
      CheckpointRollbackService.CheckpointRollbackServiceV2.of({
        execute: input.rollback ?? (() => Effect.void),
        checkRestoreSafety: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      RuntimeRequestService.RuntimeRequestServiceV2,
      RuntimeRequestService.RuntimeRequestServiceV2.of({
        respond: input.respond ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      ThreadTitleRegenerationService.ThreadTitleRegenerationService,
      ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
        execute: () => Effect.void,
      }),
    ),
  );
  return EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(EventSink.EventSinkV2)({
          setAwaitingSlot: () => (input.recordSlotClear ? record("clear") : Effect.void),
        }),
        layerDependencies,
        Layer.mock(ThreadManagementService.ThreadManagementService)(input.threads ?? {}),
        ServerSettings.layerTest(
          input.continueAfterRestart === true ? { continueThreadsAfterServerUpdate: true } : {},
        ),
      ),
    ),
  );
}

it.effect("clears a restart slot marker before interrupting the provider", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({ events, recordSlotClear: true });
    yield* EffectWorker.OrchestrationEffectExecutorV2.pipe(
      Effect.flatMap((executor) =>
        executor.execute(
          restartEffect(DateTime.makeUnsafe("2026-01-01T00:00:00Z"), { type: "detach" }),
        ),
      ),
      Effect.provide(layer),
    );
    assert.deepEqual(yield* Ref.get(events), ["clear", "interrupt", "detach", "start"]);
  }),
);

it.effect.each([
  {
    name: "settles a stopped run when its adapter has already lost the native turn",
    unresponsive: false,
    dispatched: ["thread.background-work.settle"],
  },
  {
    name: "leaves the run running and flags the Stop when the provider never confirms it",
    unresponsive: true,
    dispatched: ["thread.interrupt.unresponsive"],
  },
])("$name", ({ unresponsive, dispatched }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events,
      interrupt: () =>
        new ProviderTurnControlService.ProviderTurnControlError({
          threadId,
          operation: "interrupt",
          providerTurnId,
          ...(unresponsive ? { unresponsive } : {}),
          cause: unresponsive ? "Timed out." : "Provider turn is not active.",
        }),
      threads: {
        dispatch: (command) =>
          Ref.update(events, (current) => [...current, command.type]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute({
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: oldSessionId,
          providerThreadId,
          providerTurnId,
        },
      });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(events), dispatched);
  }),
);

const lockedIndexMessage =
  "Git's index is locked. Wait for other Git operations to finish, then try again.";
const rollbackCheckpointId = CheckpointId.make("checkpoint:effect-worker-rollback");
const rollbackScopeId = CheckpointScopeId.make("checkpoint-scope:effect-worker-rollback");
const restoreFailure = (detail: string) =>
  new CheckpointRollbackService.CheckpointRollbackExecutionError({
    reason: "unexpected-failure",
    threadId,
    providerThreadId,
    checkpointId: rollbackCheckpointId,
    cause: new CheckpointService.CheckpointRestoreError({
      scopeId: rollbackScopeId,
      checkpointId: rollbackCheckpointId,
      cause: new VcsProcessExitError({
        operation: "GitVcsDriverCore.restoreCheckpoint",
        command: "git",
        cwd: "/private/repo",
        exitCode: 128,
        detail,
        failureKind: "command-failed",
      }),
    }),
  });

it.effect.each([
  {
    name: "a held Git index lock",
    failure: restoreFailure(lockedIndexMessage),
    message: lockedIndexMessage,
    code: "git-index-locked" as const,
  },
  {
    name: "raw Git output",
    failure: restoreFailure("error: could not clean /private/repo/secret.txt"),
    message: CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
    code: undefined,
  },
  {
    name: "a shared workspace",
    failure: new CheckpointRollbackService.CheckpointRollbackExecutionError({
      reason: "shared-workspace",
      threadId,
      providerThreadId,
      checkpointId: rollbackCheckpointId,
    }),
    message: SHARED_WORKSPACE_RESTORE_MESSAGE,
    code: "shared-workspace" as const,
  },
])(
  "reports a rollback blocked by $name only after the last attempt",
  ({ failure, message, code }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const failures = yield* Ref.make<
        ReadonlyArray<{ readonly message: string; readonly code?: string }>
      >([]);
      const layer = layerExecutorFor({
        events: yield* Ref.make<ReadonlyArray<string>>([]),
        rollback: () => Effect.fail(failure),
        threads: {
          dispatch: (command) =>
            Ref.update(failures, (current) =>
              command.type === "checkpoint.rollback.fail"
                ? [
                    ...current,
                    {
                      message: command.message,
                      ...(command.code === undefined ? {} : { code: command.code }),
                    },
                  ]
                : current,
            ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
        },
      });
      yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        const rollback: EffectOutbox.OrchestrationEffectV2 = {
          ...restartEffect(now, { type: "detach" }),
          request: {
            type: "provider-thread.rollback",
            providerThreadId,
            checkpointId: rollbackCheckpointId,
            scopeId: rollbackScopeId,
            restoreFiles: true,
          },
        };
        yield* Effect.flip(executor.execute(rollback, { willRetry: true }));
        assert.deepEqual(yield* Ref.get(failures), []);
        yield* Effect.flip(executor.execute(rollback, { willRetry: false }));
      }).pipe(Effect.provide(layer));
      assert.deepEqual(yield* Ref.get(failures), [
        { message, ...(code === undefined ? {} : { code }) },
      ]);
    }),
);

it.effect("does not report an answer whose last delivery attempt is interrupted", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const reported = yield* Ref.make(0);
    const layer = layerExecutorFor({
      events: yield* Ref.make<ReadonlyArray<string>>([]),
      respond: () => Effect.interrupt,
      threads: {
        dispatch: (command) =>
          Ref.update(reported, (count) =>
            command.type === "runtime-request.delivery.fail" ? count + 1 : count,
          ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      },
    });
    const exit = yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      return yield* Effect.exit(
        executor.execute(
          {
            ...restartEffect(now, { type: "detach" }),
            request: {
              type: "runtime-request.respond",
              providerSessionId: oldSessionId,
              requestId: RuntimeRequestId.make("runtime-request:effect-worker-interrupted"),
              answers: { next: "Ship it" },
            },
          },
          { willRetry: false },
        ),
      );
    }).pipe(Effect.provide(layer));
    assert.isTrue(Exit.hasInterrupts(exit));
    assert.equal(yield* Ref.get(reported), 0);
  }),
);

it.effect("forwards terminal cleanup keepHistory to the resource cleanup service", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<boolean | undefined>>([]);
    const layer = layerExecutorFor({ events: yield* Ref.make<ReadonlyArray<string>>([]) }).pipe(
      Layer.provide(
        Layer.mock(ResourceCleanupService.ResourceCleanupService)({
          cleanupTerminals: (_threadId, keepHistory) =>
            Ref.update(calls, (all) => [...all, keepHistory]),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const effect = restartEffect(yield* DateTime.now, { type: "detach" });
      yield* executor.execute(
        { ...effect, id: "effect:cleanup:default", request: { type: "terminal.cleanup" } },
        { willRetry: false },
      );
      yield* executor.execute(
        {
          ...effect,
          id: "effect:cleanup:keep",
          request: { type: "terminal.cleanup", keepHistory: true },
        },
        { willRetry: false },
      );
    }).pipe(Effect.provide(layer));

    assert.deepEqual(yield* Ref.get(calls), [undefined, true]);
  }),
);

it.effect("forwards a scheduled-tasks rebind to the resource cleanup service", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<
      ReadonlyArray<{ readonly sourceThreadId: ThreadId; readonly targetThreadId: ThreadId }>
    >([]);
    const layer = layerExecutorFor({ events: yield* Ref.make<ReadonlyArray<string>>([]) }).pipe(
      Layer.provide(
        Layer.mock(ResourceCleanupService.ResourceCleanupService)({
          rebindScheduledTasks: (input) => Ref.update(calls, (all) => [...all, input]),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const effect = restartEffect(yield* DateTime.now, { type: "detach" });
      const targetThreadId = ThreadId.make("thread:rebind-target");
      yield* executor.execute(
        {
          ...effect,
          id: "effect:rebind",
          request: { type: "scheduled-tasks.rebind", targetThreadId },
        },
        { willRetry: false },
      );
    }).pipe(Effect.provide(layer));

    assert.deepEqual(yield* Ref.get(calls), [
      { sourceThreadId: threadId, targetThreadId: ThreadId.make("thread:rebind-target") },
    ]);
  }),
);

it.effect("requeues a claim when a pre-execution worker check fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-pre-execution-failure";
    const workerId = "worker-pre-execution-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-pre-execution-failure"),
      threadId: ThreadId.make("thread:worker-pre-execution-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make<
      ReadonlyArray<{
        readonly effectId: string;
        readonly workerId: string;
        readonly error: string;
        readonly delayMs: number;
      }>
    >([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "get",
            effectId,
            cause: "simulated cancellation-state read failure",
          }),
        ),
      retry: (input) =>
        Ref.update(retries, (existing) => [...existing, input]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.mergeAll(layerOutbox, layerExecutor, layerEventSinkMock)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce()),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.include(Cause.pretty(exit.cause), "simulated cancellation-state read failure");
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    const retry = (yield* Ref.get(retries))[0];
    assert.isDefined(retry);
    assert.equal(retry.effectId, effectId);
    assert.equal(retry.workerId, workerId);
    assert.equal(retry.delayMs, 0);
    assert.include(retry.error, "simulated cancellation-state read failure");
  }),
);

// busy_timeout already waited; these are the extra settlement attempts after that.
const LOCK_SETTLEMENT_RETRY_LIMIT = 2;
const LOCK_SETTLEMENT_RETRY_DELAY = Duration.millis(100);

const lockTimeout = (operation: string, effectId: string) =>
  new EffectOutbox.EffectOutboxError({
    operation,
    effectId,
    cause: new SqlError.SqlError({
      reason: new SqlError.LockTimeoutError({ cause: null }),
    }),
  });

it.effect.each([
  {
    name: "retries a locked outbox requeue once the lock clears",
    lockFailures: 1,
    attempts: 2,
    settled: true,
  },
  {
    name: "reports a locked outbox requeue that stays locked past the retry limit",
    lockFailures: Number.POSITIVE_INFINITY,
    attempts: LOCK_SETTLEMENT_RETRY_LIMIT + 1,
    settled: false,
  },
] as const)("$name", ({ lockFailures, attempts, settled }) => {
  const logged: Array<string> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Error") logged.push(JSON.stringify(message));
  });
  return Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-requeue-lock-timeout";
    const workerId = "worker-requeue-lock-timeout";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-requeue-lock-timeout"),
      threadId: ThreadId.make("thread:worker-requeue-lock-timeout"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const seen = yield* Ref.make(0);
    const didSettle = yield* Ref.make(false);
    const firstLock = yield* Deferred.make<void>();
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "get",
            effectId,
            cause: "simulated cancellation-state read failure",
          }),
        ),
      retry: () =>
        Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(seen, (count) => count + 1);
          if (attempt === 1) yield* Deferred.succeed(firstLock, undefined);
          if (attempt <= lockFailures) return yield* lockTimeout("retry", effectId);
          yield* Ref.set(didSettle, true);
          return true;
        }),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Effect.void,
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.mergeAll(layerOutbox, layerExecutor, layerEventSinkMock)),
    );

    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((service) => service.runOnce()),
      Effect.provide(layerWorker),
      Effect.forkChild,
    );
    yield* Deferred.await(firstLock);
    yield* TestClock.adjust(Duration.millis(99));
    assert.equal(yield* Ref.get(seen), 1);
    assert.isFalse(yield* Ref.get(didSettle));
    yield* TestClock.adjust(
      Duration.times(LOCK_SETTLEMENT_RETRY_DELAY, LOCK_SETTLEMENT_RETRY_LIMIT),
    );
    const exit = yield* Effect.exit(Fiber.join(worker));

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(seen), attempts);
    assert.equal(yield* Ref.get(didSettle), settled);
    const reported = logged.join("\n");
    if (settled) {
      assert.equal(reported, "");
    } else {
      assert.include(reported, "Failed to requeue effect after unexpected worker failure");
      assert.include(reported, "LockTimeoutError");
    }
  }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.effect("arms cancellation before the durable pre-execution check", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-cancellation-registration-race";
    const workerId = "worker-cancellation-registration-race";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-cancellation-registration-race"),
      threadId: ThreadId.make("thread:worker-cancellation-registration-race"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const signal = yield* Deferred.make<void>();
    let cancellationArmed = false;
    const executionCount = yield* Ref.make(0);
    const settlementCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      awaitCancellation: () => {
        cancellationArmed = true;
        return Deferred.await(signal);
      },
      get: () =>
        Effect.gen(function* () {
          if (cancellationArmed) {
            yield* Deferred.succeed(signal, undefined);
          }
          return Option.some(claimedEffect);
        }),
      clearCancellation: () => Effect.void,
      succeed: () => Ref.update(settlementCount, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.yieldNow.pipe(Effect.andThen(Ref.update(executionCount, (count) => count + 1))),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.mergeAll(layerOutbox, layerExecutor, layerEventSinkMock)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce()),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    if (Exit.isFailure(exit)) {
      assert.fail(Cause.pretty(exit.cause));
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    assert.equal(yield* Ref.get(settlementCount), 0);
  }),
);

it.effect("terminalizes a process-bound claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-settlement-failure";
    const workerId = "worker-process-bound-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalErrors = yield* Ref.make<ReadonlyArray<string>>([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeedSome(claimedEffect),
      get: () => Effect.succeedSome(claimedEffect),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated success settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: ({ error }) =>
        Ref.update(terminalErrors, (existing) => [...existing, error]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.mergeAll(layerOutbox, layerExecutor, layerEventSinkMock)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce()),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(executionCount), 1);
    assert.equal(yield* Ref.get(retries), 0);
    const terminalError = (yield* Ref.get(terminalErrors))[0];
    assert.isDefined(terminalError);
    assert.include(terminalError, "after execution started");
    assert.include(terminalError, "simulated success settlement failure");
  }),
);

it.effect("settles a delegated child once its restart continuation fails for good", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const recovered = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = layerExecutorFor({
      events,
      continueAfterRestart: true,
      threads: {
        getThreadRecords: () => Effect.fail(new Error("provider instance removed") as never),
        recoverDelegatedTask: (childThreadId) =>
          Ref.update(recovered, (ids) => [...ids, childThreadId]),
      },
    });
    const effect: EffectOutbox.OrchestrationEffectV2 = {
      id: `effect:restart-continuation:${runId}`,
      commandId: CommandId.make("command:restart-continuation-failure"),
      threadId,
      request: { type: "provider-runtime.continue", sourceRunId: runId },
      status: "running",
      attemptCount: 1,
      availableAt: timestamp,
      leaseOwner: "test-worker",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastError: null,
    };
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: true }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), []);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: false }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), [threadId]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["confirmed", "unconfirmed", "failed"] as const)(
  "a native subagent stop only repairs %s provider evidence",
  (outcome) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = layerExecutorFor({
        events,
        interrupt: (input) => {
          assert.equal(input.subagent?.nativeTaskId, "native-task");
          return Ref.update(events, (current) => [...current, "stop-child"]).pipe(
            Effect.andThen(
              outcome === "failed"
                ? new ProviderTurnControlService.ProviderTurnControlError({
                    threadId,
                    providerTurnId,
                    operation: "interrupt",
                    cause: "SDK stop failed",
                  })
                : Effect.succeed(
                    outcome === "confirmed"
                      ? {
                          status: "cancelled" as const,
                          completedAt: now,
                          result: "Stopped by Claude",
                        }
                      : undefined,
                  ),
            ),
          );
        },
        threads: {
          dispatch: (command) => {
            assert.equal(command.type, "thread.background-work.settle");
            if (command.type === "thread.background-work.settle") {
              assert.equal(command.subagent?.id, "subagent");
              assert.deepEqual(command.subagent?.outcome, {
                status: "cancelled",
                completedAt: now,
                result: "Stopped by Claude",
              });
            }
            return Ref.update(events, (current) => [...current, "settle-child"]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            );
          },
        },
      });
      const execution = yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        yield* executor.execute({
          ...restartEffect(now, { type: "detach" }),
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
            subagent: { id: NodeId.make("subagent"), nativeTaskId: "native-task" },
          },
        });
      }).pipe(Effect.provide(layer), Effect.exit);
      assert.equal(Exit.isFailure(execution), outcome === "failed");
      assert.deepEqual(
        yield* Ref.get(events),
        outcome === "confirmed" ? ["stop-child", "settle-child"] : ["stop-child"],
      );
    }),
);

it.effect("reads the updated concurrent session limit on every claim", () =>
  Effect.gen(function* () {
    const limits = yield* Ref.make<ReadonlyArray<number | undefined>>([]);
    const outbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      blockedBySessionLimit: () => Effect.succeed([]),
      claimNext: (input) =>
        Ref.update(limits, (current) => [...current, input.maxConcurrentSessions]).pipe(
          Effect.as(Option.none()),
        ),
    });
    const executor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({ execute: () => Effect.void }),
    );
    const settings = ServerSettings.layerTest({ maxConcurrentSessions: 3 });
    const worker = EffectWorker.layerWithOptions({ maxConcurrentSessions: 2 }).pipe(
      Layer.provide(Layer.mergeAll(outbox, executor, layerEventSinkMock)),
      Layer.provideMerge(settings),
    );
    yield* Effect.gen(function* () {
      const service = yield* ServerSettings.ServerSettingsService;
      const runner = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* runner.runOnce();
      yield* service.updateSettings({ maxConcurrentSessions: 1 });
      yield* runner.runOnce();
      yield* service.updateSettings({ maxConcurrentSessions: null });
      yield* runner.runOnce();
      assert.deepEqual(yield* Ref.get(limits), [2, 1, 2]);
    }).pipe(Effect.provide(worker));
  }),
);
