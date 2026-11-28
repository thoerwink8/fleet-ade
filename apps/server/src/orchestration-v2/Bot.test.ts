import { assert, it } from "@effect/vitest";
import {
  BotId,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for bot commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "bot" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const projectId = ProjectId.make("project:bot");

const createThread = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  title: string,
) =>
  orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${threadId}`),
    threadId,
    projectId,
    title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });

const markCommander = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  commandId: string,
) =>
  orchestrator.dispatch({
    type: "thread.commander.mark",
    commandId: CommandId.make(commandId),
    threadId,
  });

it.effect("pause and resume transition the bot status with no-op repeats", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:bot-pause");
    yield* createThread(orchestrator, threadId, "Pause home");
    yield* markCommander(orchestrator, threadId, "mark-bot-pause");
    const botId = BotId.make("bot:mark-bot-pause");
    const before = yield* projections.getThreadProjection(threadId);
    assert.equal(before.bot?.status, "active");

    yield* TestClock.adjust("1 second");
    const paused = yield* orchestrator.dispatch({
      type: "bot.pause",
      commandId: CommandId.make("pause-bot-1"),
      botId,
      threadId,
    });
    assert.deepEqual(
      paused.storedEvents.map((stored) => stored.event.type),
      ["bot.paused"],
    );
    const pausedEvent = paused.storedEvents[0]?.event;
    assert.equal(pausedEvent?.threadId, threadId);
    assert.equal(
      pausedEvent?.type === "bot.paused" ? pausedEvent.payload.status : undefined,
      "paused",
    );
    const afterPause = yield* projections.getThreadProjection(threadId);
    assert.equal(afterPause.bot?.status, "paused");
    // A paused bot still counts as the thread's commander.
    const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
      (thread) => thread.id === threadId,
    );
    assert.equal(shell?.commander, true);

    // Bot status changes do not bump the thread's updatedAt.
    assert.equal(
      DateTime.toEpochMillis(afterPause.thread.updatedAt),
      DateTime.toEpochMillis(before.thread.updatedAt),
    );

    yield* TestClock.adjust("1 second");

    // Pausing again is a no-op: no events, still an accepted receipt.
    const pausedAgain = yield* orchestrator.dispatch({
      type: "bot.pause",
      commandId: CommandId.make("pause-bot-2"),
      botId,
      threadId,
    });
    assert.lengthOf(pausedAgain.storedEvents, 0);

    const resumed = yield* orchestrator.dispatch({
      type: "bot.resume",
      commandId: CommandId.make("resume-bot-1"),
      botId,
      threadId,
    });
    assert.deepEqual(
      resumed.storedEvents.map((stored) => stored.event.type),
      ["bot.resumed"],
    );
    const afterResume = yield* projections.getThreadProjection(threadId);
    assert.equal(afterResume.bot?.status, "active");
    assert.equal(
      DateTime.toEpochMillis(afterResume.thread.updatedAt),
      DateTime.toEpochMillis(before.thread.updatedAt),
    );

    const resumedAgain = yield* orchestrator.dispatch({
      type: "bot.resume",
      commandId: CommandId.make("resume-bot-2"),
      botId,
      threadId,
    });
    assert.lengthOf(resumedAgain.storedEvents, 0);

    // Retired bots refuse both transitions.
    yield* orchestrator.dispatch({
      type: "thread.commander.unmark",
      commandId: CommandId.make("unmark-bot-pause"),
      threadId,
    });
    const pauseRetired = yield* orchestrator
      .dispatch({
        type: "bot.pause",
        commandId: CommandId.make("pause-bot-retired"),
        botId,
        threadId,
      })
      .pipe(Effect.flip);
    assert.equal(pauseRetired._tag, "OrchestratorDispatchError");
    const resumeRetired = yield* orchestrator
      .dispatch({
        type: "bot.resume",
        commandId: CommandId.make("resume-bot-retired"),
        botId,
        threadId,
      })
      .pipe(Effect.flip);
    assert.equal(resumeRetired._tag, "OrchestratorDispatchError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pause of a missing or mismatched bot fails without events", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:bot-missing");
    const otherThreadId = ThreadId.make("thread:bot-missing-other");
    yield* createThread(orchestrator, threadId, "Missing home");
    yield* createThread(orchestrator, otherThreadId, "Other home");
    yield* markCommander(orchestrator, threadId, "mark-bot-missing");
    const botId = BotId.make("bot:mark-bot-missing");

    const missing = yield* orchestrator
      .dispatch({
        type: "bot.pause",
        commandId: CommandId.make("pause-no-such-bot"),
        botId: BotId.make("bot:no-such-bot"),
        threadId,
      })
      .pipe(Effect.flip);
    assert.equal(missing._tag, "OrchestratorDispatchError");

    // The command's threadId is optimistic concurrency for the bot's current thread.
    const stale = yield* orchestrator
      .dispatch({
        type: "bot.pause",
        commandId: CommandId.make("pause-stale-thread"),
        botId,
        threadId: otherThreadId,
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "OrchestratorDispatchError");

    const after = yield* projections.getThreadProjection(threadId);
    assert.equal(after.bot?.status, "active");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "switch-thread moves the bot, both projections and shells, without touching updatedAt",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const oldThreadId = ThreadId.make("thread:bot-old");
      const newThreadId = ThreadId.make("thread:bot-new");
      yield* createThread(orchestrator, oldThreadId, "Old home");
      yield* createThread(orchestrator, newThreadId, "New home");
      yield* markCommander(orchestrator, oldThreadId, "mark-bot-switch");
      const botId = BotId.make("bot:mark-bot-switch");
      const oldBefore = yield* projections.getThreadProjection(oldThreadId);
      const newBefore = yield* projections.getThreadProjection(newThreadId);
      yield* TestClock.adjust("1 second");

      const switched = yield* orchestrator.dispatch({
        type: "bot.switch-thread",
        commandId: CommandId.make("switch-bot-1"),
        botId,
        threadId: oldThreadId,
        targetThreadId: newThreadId,
      });
      // One copy of the move event on each thread's stream.
      assert.deepEqual(
        switched.storedEvents.map((stored) => [stored.event.threadId, stored.event.type]),
        [
          [oldThreadId, "bot.current-thread-changed"],
          [newThreadId, "bot.current-thread-changed"],
        ],
      );
      const payload = switched.storedEvents[0]?.event;
      assert.equal(
        payload?.type === "bot.current-thread-changed"
          ? payload.payload.previousThreadId
          : undefined,
        oldThreadId,
      );
      assert.equal(
        payload?.type === "bot.current-thread-changed"
          ? payload.payload.currentThreadId
          : undefined,
        newThreadId,
      );

      const oldAfter = yield* projections.getThreadProjection(oldThreadId);
      const newAfter = yield* projections.getThreadProjection(newThreadId);
      assert.isNull(oldAfter.bot);
      assert.equal(newAfter.bot?.currentThreadId, newThreadId);
      assert.equal(newAfter.bot?.id, botId);
      assert.isFalse("previousThreadId" in (newAfter.bot ?? {}));

      // The shell's commander follows the bot.
      const shells = (yield* orchestrator.getShellSnapshot()).threads;
      assert.equal(shells.find((thread) => thread.id === oldThreadId)?.commander, false);
      assert.equal(shells.find((thread) => thread.id === newThreadId)?.commander, true);

      // Neither thread's updatedAt moves.
      assert.equal(
        DateTime.toEpochMillis(oldAfter.thread.updatedAt),
        DateTime.toEpochMillis(oldBefore.thread.updatedAt),
      );
      assert.equal(
        DateTime.toEpochMillis(newAfter.thread.updatedAt),
        DateTime.toEpochMillis(newBefore.thread.updatedAt),
      );

      // Switching to the current thread is a no-op.
      const switchedAgain = yield* orchestrator.dispatch({
        type: "bot.switch-thread",
        commandId: CommandId.make("switch-bot-2"),
        botId,
        threadId: newThreadId,
        targetThreadId: newThreadId,
      });
      assert.lengthOf(switchedAgain.storedEvents, 0);

      // The bot now answers on its new thread; the old one is stale.
      const stale = yield* orchestrator
        .dispatch({
          type: "bot.pause",
          commandId: CommandId.make("pause-bot-stale-thread"),
          botId,
          threadId: oldThreadId,
        })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "OrchestratorDispatchError");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("switch-thread refuses occupied, missing, deleted, and side chat targets", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const homeId = ThreadId.make("thread:bot-home");
    const occupiedId = ThreadId.make("thread:bot-occupied");
    const deletedId = ThreadId.make("thread:bot-deleted");
    const freeId = ThreadId.make("thread:bot-free");
    yield* createThread(orchestrator, homeId, "Home");
    yield* createThread(orchestrator, occupiedId, "Occupied");
    yield* createThread(orchestrator, deletedId, "Deleted");
    yield* createThread(orchestrator, freeId, "Free");
    yield* markCommander(orchestrator, homeId, "mark-bot-home");
    yield* markCommander(orchestrator, occupiedId, "mark-bot-occupied");
    const botId = BotId.make("bot:mark-bot-home");
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-bot-deleted"),
      threadId: deletedId,
    });

    const occupiedSequenceBefore = (yield* orchestrator.getThreadSnapshot(occupiedId))
      .snapshotSequence;
    const occupied = yield* orchestrator
      .dispatch({
        type: "bot.switch-thread",
        commandId: CommandId.make("switch-to-occupied"),
        botId,
        threadId: homeId,
        targetThreadId: occupiedId,
      })
      .pipe(Effect.flip);
    assert.equal(occupied._tag, "OrchestratorDispatchError");
    // A refused move commits nothing on the target's stream.
    assert.equal(
      (yield* orchestrator.getThreadSnapshot(occupiedId)).snapshotSequence,
      occupiedSequenceBefore,
    );

    const missing = yield* orchestrator
      .dispatch({
        type: "bot.switch-thread",
        commandId: CommandId.make("switch-to-missing"),
        botId,
        threadId: homeId,
        targetThreadId: ThreadId.make("thread:no-such-target"),
      })
      .pipe(Effect.flip);
    assert.equal(missing._tag, "OrchestratorDispatchError");

    const deleted = yield* orchestrator
      .dispatch({
        type: "bot.switch-thread",
        commandId: CommandId.make("switch-to-deleted"),
        botId,
        threadId: homeId,
        targetThreadId: deletedId,
      })
      .pipe(Effect.flip);
    assert.equal(deleted._tag, "OrchestratorDispatchError");

    // A bot cannot land on a side chat: deletes lock parents before their side chats,
    // so holding a side chat's lock here would invert that order.
    const sideChatId = ThreadId.make("thread:bot-sidechat");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-bot-sidechat"),
      sourceThreadId: freeId,
      targetThreadId: sideChatId,
      sideChat: true,
      sourcePoint: { type: "latest_stable" },
      createdBy: "user",
      creationSource: "web",
    });
    const sideChat = yield* orchestrator
      .dispatch({
        type: "bot.switch-thread",
        commandId: CommandId.make("switch-to-sidechat"),
        botId,
        threadId: homeId,
        targetThreadId: sideChatId,
      })
      .pipe(Effect.flip);
    assert.equal(sideChat._tag, "OrchestratorDispatchError");
    assert.isNull((yield* projections.getThreadProjection(sideChatId)).bot);

    // Nothing moved: the bot is still home and no events were committed anywhere.
    const home = yield* projections.getThreadProjection(homeId);
    assert.equal(home.bot?.currentThreadId, homeId);
    const occupiedProjection = yield* projections.getThreadProjection(occupiedId);
    assert.equal(occupiedProjection.bot?.id, BotId.make("bot:mark-bot-occupied"));

    // The free target still accepts the move, proving the refusals were target-specific.
    const moved = yield* orchestrator.dispatch({
      type: "bot.switch-thread",
      commandId: CommandId.make("switch-to-free"),
      botId,
      threadId: homeId,
      targetThreadId: freeId,
    });
    assert.equal(moved.storedEvents.length, 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("purging a thread retires its bot in the same commit and frees the slot", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:bot-purged");
    yield* createThread(orchestrator, threadId, "Purged home");
    yield* markCommander(orchestrator, threadId, "mark-bot-purged");
    const botId = BotId.make("bot:mark-bot-purged");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-bot-purged"),
      threadId,
      messageId: MessageId.make("message:bot-purged"),
      text: "Do work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-bot-purged"),
      threadId,
    });
    const purged = yield* orchestrator.dispatch({
      type: "thread.purge",
      commandId: CommandId.make("purge-bot-purged"),
      threadId,
    });
    const types = purged.storedEvents.map((stored) => stored.event.type);
    assert.includeMembers(types, ["bot.retired", "thread.purged"]);
    const retiredEvent = purged.storedEvents.find(
      (stored) => stored.event.type === "bot.retired",
    )?.event;
    assert.equal(retiredEvent?.type === "bot.retired" ? retiredEvent.payload.id : undefined, botId);
    assert.equal(
      retiredEvent?.type === "bot.retired" ? retiredEvent.payload.status : undefined,
      "retired",
    );
    const bot = yield* projections.getBot(botId);
    assert.equal(bot?.status, "retired");

    // The retired bot no longer occupies the thread slot: a bot can land on the id.
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:test-reuse:${threadId}`),
      type: "bot.created",
      threadId,
      occurredAt: now,
      payload: {
        id: BotId.make("bot:test-reuse"),
        name: "Reuse",
        status: "active",
        currentThreadId: threadId,
        createdAt: now,
        updatedAt: now,
      },
    });
    const reused = yield* projections.getBot(BotId.make("bot:test-reuse"));
    assert.equal(reused?.status, "active");
  }).pipe(Effect.provide(layerTest)),
);

const applyProviderThread = (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly nativeId: string;
  },
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${input.nativeId}:provider-thread`),
      type: "provider-thread.updated",
      threadId: input.threadId,
      occurredAt: now,
      payload: {
        id: input.providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: input.threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: input.nativeId, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  });

const applyRun = (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly ordinal: number;
    readonly status:
      | "queued"
      | "preparing"
      | "starting"
      | "running"
      | "waiting"
      | "completed"
      | "failed"
      | "interrupted"
      | "cancelled"
      | "rolled_back";
    readonly providerThreadId?: ProviderThreadId | null;
    readonly userMessageId?: MessageId;
    readonly queuePosition?: number;
    readonly queueHeld?: boolean;
  },
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const completed = ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
      input.status,
    );
    yield* projections.apply({
      id: EventId.make(`event:${input.runId}:${input.status}`),
      type: input.status === "queued" ? "run.updated" : "run.created",
      threadId: input.threadId,
      runId: input.runId,
      occurredAt: now,
      payload: {
        id: input.runId,
        threadId: input.threadId,
        ordinal: input.ordinal,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: input.providerThreadId ?? null,
        userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: input.status,
        requestedAt: now,
        startedAt: input.status === "queued" ? null : now,
        completedAt: completed ? now : null,
        checkpointId: null,
        contextHandoffId: null,
        ...(input.queuePosition === undefined ? {} : { queuePosition: input.queuePosition }),
        ...(input.queueHeld === true ? { queueHeld: true } : {}),
      },
    });
  });

const attachReadySession = (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  threadId: ThreadId,
  sessionId: ProviderSessionId,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${sessionId}`),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
  });

/** A completed provider-finished turn on a strong native thread, forkable and portable-source. */
const seedForkableTurn = (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  input: {
    readonly threadId: ThreadId;
    readonly key: string;
  },
) =>
  Effect.gen(function* () {
    yield* applyProviderThread(projections, {
      threadId: input.threadId,
      providerThreadId: ProviderThreadId.make(`provider-thread:${input.key}`),
      nativeId: `native:${input.key}`,
    });
    yield* applyRun(projections, {
      threadId: input.threadId,
      runId: RunId.make(`run:${input.key}`),
      ordinal: 1,
      status: "completed",
      providerThreadId: ProviderThreadId.make(`provider-thread:${input.key}`),
    });
  });

const driver = ProviderDriverKind.make("codex");

const rotateSession = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  input: {
    readonly commandId: string;
    readonly markCommandId: string;
    readonly threadId: ThreadId;
    readonly targetThreadId: ThreadId;
  },
) =>
  orchestrator.dispatch({
    type: "bot.rotate-session",
    commandId: CommandId.make(input.commandId),
    botId: BotId.make(`bot:${input.markCommandId}`),
    threadId: input.threadId,
    targetThreadId: input.targetThreadId,
    reason: "manual",
  });

const sendText = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  commandId: string,
  text: string,
) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(commandId),
    threadId,
    messageId: MessageId.make(`message:${commandId}`),
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });

const queueText = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  commandId: string,
  text: string,
) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(commandId),
    threadId,
    messageId: MessageId.make(`message:${commandId}`),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: "web",
  });

/** Settles the fixture-started turn effect and ends active runs the way finished provider turns do. */
const finishRunsInFixture = (
  projections: ProjectionStore.ProjectionStoreV2Shape,
  outbox: EffectOutbox.EffectOutboxV2Shape,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    yield* outbox
      .cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.start"],
        reason: "turn finished in fixture",
      })
      .pipe(Effect.asVoid);
    const runs = (yield* projections.getThreadRecords(threadId, ["runs"])).runs;
    const now = yield* DateTime.now;
    for (const run of runs) {
      if (run.status !== "preparing" && run.status !== "starting" && run.status !== "running")
        continue;
      yield* projections.apply({
        id: EventId.make(`event:${run.id}:finished`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
    }
  });

it.effect(
  "rotate-session seals the old thread, moves the bot, and forces a portable first turn",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const source = ThreadId.make("thread:rotate-source");
      const home = ThreadId.make("thread:rotate-home");

      yield* createThread(orchestrator, source, "Rotate source");
      yield* markCommander(orchestrator, source, "mark-rotate-source");
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("provider-thread:rotate-source");
      yield* projections.apply({
        id: EventId.make("event:rotate-source-provider-thread"),
        type: "provider-thread.updated",
        threadId: source,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: source,
          ownerNodeId: null,
          nativeThreadRef: { driver, nativeId: "native:rotate-source", strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:rotate-source-run"),
        type: "run.created",
        threadId: source,
        occurredAt: now,
        payload: {
          id: RunId.make("run:rotate-source"),
          threadId: source,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:rotate-source"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const rotated = yield* rotateSession(orchestrator, {
        commandId: "rotate-source",
        markCommandId: "mark-rotate-source",
        threadId: source,
        targetThreadId: home,
      });
      assert.includeMembers(
        rotated.storedEvents.map((stored) => stored.event.type),
        [
          "thread.created",
          "context-transfer.created",
          "bot.current-thread-changed",
          "thread.metadata-updated",
        ],
      );
      const sourceAfter = yield* projections.getThreadProjection(source);
      assert.equal(sourceAfter.thread.rotatedTo?.threadId, home);
      assert.equal(sourceAfter.thread.rotatedTo?.botId, BotId.make("bot:mark-rotate-source"));
      assert.isNull(sourceAfter.bot);
      const homeProjection = yield* projections.getThreadProjection(home);
      assert.equal(homeProjection.bot?.currentThreadId, home);
      assert.equal(homeProjection.contextTransfers[0]?.requiresPortable, true);
      // The rotation's opening turn consumes the handoff as it is dispatched; nothing waits
      // for a user message anymore.
      assert.equal(homeProjection.contextTransfers[0]?.status, "consumed");
      assert.equal(homeProjection.contextTransfers[0]?.resolution?.strategy, "portable_context");

      const replayed = yield* rotateSession(orchestrator, {
        commandId: "rotate-source",
        markCommandId: "mark-rotate-source",
        threadId: source,
        targetThreadId: home,
      });
      assert.equal(replayed.replayed, true);

      const duplicate = yield* rotateSession(orchestrator, {
        commandId: "rotate-source-again",
        markCommandId: "mark-rotate-source",
        threadId: source,
        targetThreadId: ThreadId.make("thread:rotate-home-2"),
      }).pipe(Effect.flip);
      assert.equal(duplicate._tag, "OrchestratorThreadRotatedError");
      if (duplicate._tag === "OrchestratorThreadRotatedError") {
        assert.equal(duplicate.successorThreadId, home);
      }

      yield* sendText(orchestrator, home, "rotate-home-turn", "continue");
      assert.isNull(
        (yield* projections.getThreadProjection(home)).providerThreads[0]?.forkedFrom ?? null,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rotate-session moves watches and pinning to the new thread and strips them here", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const alpha = ThreadId.make("thread:watch-a");
    const bravo = ThreadId.make("thread:watch-b");
    yield* createThread(orchestrator, alpha, "Watch A");
    yield* markCommander(orchestrator, alpha, "mark-watch-a");
    const thread = yield* projections.getThread(alpha);
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    yield* projections.apply({
      id: EventId.make("event:watch-a-metadata"),
      type: "thread.metadata-updated",
      threadId: alpha,
      occurredAt: now,
      payload: {
        ...thread,
        pinnedAt: now,
        pinOrderKey: "a0",
        pullRequests: [
          {
            host: "github.com",
            repository: "example/repo",
            number: 7,
            url: "https://github.com/example/repo/pull/7",
            source: "agent" as const,
            linkedAt: nowIso,
            snapshot: null,
            stack: null,
            watch: {
              startedAt: nowIso,
              headSha: "watch-head",
              failedChecks: [] as Array<string>,
              passed: false,
              passedChecks: [] as Array<string>,
              remarksThrough: nowIso,
              remarkIds: [] as Array<string>,
              conflicting: false,
              wakes: 0,
            },
          },
        ],
      },
    });
    yield* rotateSession(orchestrator, {
      commandId: "rotate-watch",
      markCommandId: "mark-watch-a",
      threadId: alpha,
      targetThreadId: bravo,
    });
    const bravoThread = (yield* projections.getThreadProjection(bravo)).thread;
    assert.equal(bravoThread.pullRequests?.length, 1);
    assert.equal(bravoThread.pullRequests?.[0]?.watch?.headSha, "watch-head");
    assert.deepEqual(bravoThread.pinnedAt, now);
    assert.equal(bravoThread.pinOrderKey, "a0");
    const alphaThread = (yield* projections.getThreadProjection(alpha)).thread;
    assert.equal(alphaThread.pullRequests?.length, 1);
    assert.isUndefined(alphaThread.pullRequests?.[0]?.watch);
    assert.isNull(alphaThread.pinnedAt);
    assert.isNull(alphaThread.pinOrderKey);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a crash after rotation re-queues the carried messages held and queue.resume drains them",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const alpha = ThreadId.make("thread:crash-a");
      const bravo = ThreadId.make("thread:crash-b");
      yield* createThread(orchestrator, alpha, "Crash A");
      yield* markCommander(orchestrator, alpha, "mark-crash-a");
      yield* sendText(orchestrator, alpha, "crash-first", "first turn");
      yield* queueText(orchestrator, alpha, "crash-q1", "queued 1");
      yield* queueText(orchestrator, alpha, "crash-q2", "queued 2");
      yield* finishRunsInFixture(projections, outbox, alpha);
      yield* rotateSession(orchestrator, {
        commandId: "rotate-crash",
        markCommandId: "mark-crash-a",
        threadId: alpha,
        targetThreadId: bravo,
      });
      // The worker claims the opening turn start and the process dies before settling it.
      const claimed = yield* outbox.claimNext({ workerId: "worker-dead" });
      assert.isTrue(Option.isSome(claimed));
      if (Option.isSome(claimed)) {
        assert.equal(
          claimed.value.id,
          `effect:rotate-crash:opening:provider-turn.start:${`run:thread:${encodeURIComponent(bravo)}:ordinal:1`}`,
        );
      }
      yield* outbox.reconcileAfterProcessLoss;
      yield* recovery.reconcile("startup");
      const bravoAfter = yield* projections.getThreadProjection(bravo);
      const opening = bravoAfter.runs.find((run) => run.userMessageId.startsWith("bot-rotation:"));
      assert.equal(opening?.status, "cancelled");
      const held = queuedRunsInDeliveryOrder(bravoAfter);
      assert.lengthOf(held, 2);
      assert.deepEqual(
        held.map((run) => run.userMessageId),
        ["crash-q1", "crash-q2"].map((key) => MessageId.make(`message:${key}~${bravo}`)),
      );
      assert.deepEqual(
        held.map((run) => run.queueHeld === true),
        [true, true],
      );
      // The migration is exactly-once: the old thread's copies stay cancelled, no duplicates.
      const alphaAfter = yield* projections.getThreadProjection(alpha);
      assert.lengthOf(queuedRunsInDeliveryOrder(alphaAfter), 0);
      assert.lengthOf(
        bravoAfter.messages.filter((message) => message.text === "queued 1"),
        1,
      );
      // A held queue waits for the user; resuming starts the first carried message.
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("crash-resume"),
        threadId: bravo,
      });
      const bravoResumed = yield* projections.getThreadProjection(bravo);
      assert.deepEqual(
        queuedRunsInDeliveryOrder(bravoResumed).map((run) => run.userMessageId),
        [MessageId.make(`message:crash-q2~${bravo}`)],
      );
      assert.notEqual(
        bravoResumed.runs.find((run) => run.userMessageId === `message:crash-q1~${bravo}`)?.status,
        "queued",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "when the opening turn fails to start, the carried queue still starts instead of stranding",
  () => {
    const failingAdapter = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: (input: { readonly providerSessionId: ProviderSessionId }) =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: input.providerSessionId,
            notInstalled: true,
          }),
        ),
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
    const layerFailingOpen = Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "bot-rotate-failing-open" },
        ProviderAdapterRegistry.layerFromAdapters([failingAdapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const alpha = ThreadId.make("thread:failopen-a");
      const bravo = ThreadId.make("thread:failopen-b");
      yield* createThread(orchestrator, alpha, "Fail open A");
      yield* markCommander(orchestrator, alpha, "mark-failopen-a");
      yield* sendText(orchestrator, alpha, "failopen-first", "first turn");
      yield* queueText(orchestrator, alpha, "failopen-q1", "queued 1");
      yield* queueText(orchestrator, alpha, "failopen-q2", "queued 2");
      yield* finishRunsInFixture(projections, outbox, alpha);
      yield* rotateSession(orchestrator, {
        commandId: "rotate-failopen",
        markCommandId: "mark-failopen-a",
        threadId: alpha,
        targetThreadId: bravo,
      });
      // The opening turn start fails fast with a provider failure, the way a broken provider
      // install does; the queue must move on to the first carried message on its own.
      const sink = yield* EventSink.EventSinkV2;
      const afterSequence = yield* sink.latestSequence().pipe(Effect.orDie);
      yield* worker.drain();
      // Queue promotion is an asynchronous reaction to the opening's terminal events; the first
      // carried run starting is the milestone it finished. Its own start then fails in the drain.
      yield* sink.stream({ afterSequence, eventType: "run.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.threadId === bravo &&
            stored.event.payload.status === "starting" &&
            stored.event.payload.userMessageId === `message:failopen-q1~${bravo}`,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* worker.drain();
      const bravoAfter = yield* projections.getThreadProjection(bravo);
      const opening = bravoAfter.runs.find((run) => run.userMessageId.startsWith("bot-rotation:"));
      assert.equal(opening?.status, "failed");
      // The housekeeping failure does not freeze user work: the first carried run left the
      // queue without being held. It fails for the same broken provider here, and that real
      // failure does hold the rest.
      const first = bravoAfter.runs.find(
        (run) => run.userMessageId === `message:failopen-q1~${bravo}`,
      );
      assert.notEqual(first?.status, "queued");
      const second = bravoAfter.runs.find(
        (run) => run.userMessageId === `message:failopen-q2~${bravo}`,
      );
      assert.equal(second?.status, "queued");
      assert.equal(second?.queueHeld, true);
    }).pipe(Effect.provide(layerFailingOpen));
  },
);

it.effect(
  "a projection failure mid-migration rolls the whole rotation back and the same command retries",
  () => {
    // The first store read of the new thread is the opening turn's projection read; the second
    // is the first carried message's. Failing exactly that read lands inside the migration,
    // after the opening was already decided.
    let bravoReads = 0;
    let armed = true;
    const layerMidFault = Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "bot-rotate-mid-fault" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        {
          databaseLayer: layerDatabase,
          runEffectWorker: false,
          wrapProjectionStore: (store) => ({
            ...store,
            getThreadRecords: (threadId, fields, filter) => {
              if (
                threadId === ThreadId.make("thread:midfault-b") &&
                (fields as ReadonlyArray<string>).includes("runs")
              ) {
                bravoReads += 1;
                if (armed && bravoReads === 2) {
                  armed = false;
                  return Effect.die("injected mid-migration projection failure") as never;
                }
              }
              return store.getThreadRecords(threadId, fields, filter);
            },
          }),
        },
      ),
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const alpha = ThreadId.make("thread:midfault-a");
      const bravo = ThreadId.make("thread:midfault-b");
      yield* createThread(orchestrator, alpha, "Mid fault A");
      yield* markCommander(orchestrator, alpha, "mark-midfault-a");
      yield* sendText(orchestrator, alpha, "midfault-first", "first turn");
      yield* queueText(orchestrator, alpha, "midfault-q1", "queued 1");
      yield* finishRunsInFixture(projections, outbox, alpha);
      const failed = yield* rotateSession(orchestrator, {
        commandId: "rotate-midfault",
        markCommandId: "mark-midfault-a",
        threadId: alpha,
        targetThreadId: bravo,
      }).pipe(Effect.exit);
      // A projection read defect dies the command before any commit, so the failure is
      // untyped here; what matters is that nothing below it committed.
      assert.isTrue(Exit.isFailure(failed));
      // Nothing committed: no new thread, the bot still owns the old one, and the queued copy
      // there is untouched, so the same command id can be retried without a replay shortcut.
      assert.isNull(yield* projections.getThreadShell(bravo));
      assert.equal(
        (yield* projections.getBot(BotId.make("bot:mark-midfault-a")))?.currentThreadId,
        alpha,
      );
      assert.lengthOf(
        (yield* projections.getThreadProjection(alpha)).runs.filter(
          (run) => run.status === "queued",
        ),
        1,
      );
      yield* noReceipt("rotate-midfault");
      const accepted = yield* rotateSession(orchestrator, {
        commandId: "rotate-midfault",
        markCommandId: "mark-midfault-a",
        threadId: alpha,
        targetThreadId: bravo,
      });
      assert.isUndefined(accepted.replayed);
      const bravoAfter = yield* projections.getThreadProjection(bravo);
      assert.lengthOf(queuedRunsInDeliveryOrder(bravoAfter), 1);
    }).pipe(Effect.provide(layerMidFault));
  },
);

it.effect(
  "queue progression and rotation are serialized: neither order delivers a queued message twice",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      // Both sides decide under the same per-thread lock, so the only interleavings are the two
      // orderings below: whichever command decides first wins cleanly, and the loser sees the
      // result instead of acting on stale queue state.
      const alpha = ThreadId.make("thread:order-a");
      const bravo = ThreadId.make("thread:order-b");
      yield* createThread(orchestrator, alpha, "Order A");
      yield* markCommander(orchestrator, alpha, "mark-order-a");
      yield* sendText(orchestrator, alpha, "order-first", "first turn");
      yield* queueText(orchestrator, alpha, "order-q1", "queued 1");
      yield* finishRunsInFixture(projections, outbox, alpha);
      const queuedRunId = (yield* projections.getThreadProjection(alpha)).runs.find(
        (run) => run.status === "queued",
      )!.id;

      // Rotation first: the late start command is refused by the rotated read-only guard, and
      // the only copy of the message is the carried one.
      yield* rotateSession(orchestrator, {
        commandId: "rotate-order",
        markCommandId: "mark-order-a",
        threadId: alpha,
        targetThreadId: bravo,
      });
      const lateStart = yield* orchestrator
        .dispatch({
          type: "queued-run.start",
          commandId: CommandId.make("order-start-late"),
          threadId: alpha,
          runId: queuedRunId,
        })
        .pipe(Effect.flip);
      assert.include(lateStart.cause, "queued");
      const bravoAfter = yield* projections.getThreadProjection(bravo);
      assert.lengthOf(queuedRunsInDeliveryOrder(bravoAfter), 1);
      assert.lengthOf(
        bravoAfter.messages.filter((message) => message.text === "queued 1"),
        1,
      );

      // Delivery first: the run it started keeps the thread busy, so rotation refuses and
      // migrates nothing.
      const gamma = ThreadId.make("thread:order-c");
      const delta = ThreadId.make("thread:order-d");
      yield* createThread(orchestrator, gamma, "Order C");
      yield* markCommander(orchestrator, gamma, "mark-order-c");
      yield* sendText(orchestrator, gamma, "order2-first", "first turn");
      yield* queueText(orchestrator, gamma, "order2-q1", "queued 1");
      yield* finishRunsInFixture(projections, outbox, gamma);
      const gammaQueuedRunId = (yield* projections.getThreadProjection(gamma)).runs.find(
        (run) => run.status === "queued",
      )!.id;
      yield* orchestrator.dispatch({
        type: "queued-run.start",
        commandId: CommandId.make("order2-start"),
        threadId: gamma,
        runId: gammaQueuedRunId,
      });
      const refused = yield* rotateSession(orchestrator, {
        commandId: "rotate-order2",
        markCommandId: "mark-order-c",
        threadId: gamma,
        targetThreadId: delta,
      }).pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.isNull(yield* projections.getThreadShell(delta));
      const gammaAfter = yield* projections.getThreadProjection(gamma);
      assert.lengthOf(
        gammaAfter.messages.filter((message) => message.text === "queued 1"),
        1,
      );
      assert.lengthOf(
        gammaAfter.runs.filter((run) => run.userMessageId === MessageId.make("message:order2-q1")),
        1,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rotate-session carries queued messages in delivery order behind the opening turn", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const alpha = ThreadId.make("thread:migrate-a");
    const bravo = ThreadId.make("thread:migrate-b");
    yield* createThread(orchestrator, alpha, "Migrate A");
    yield* markCommander(orchestrator, alpha, "mark-migrate-a");
    yield* sendText(orchestrator, alpha, "migrate-first", "first turn");
    for (const [index, key] of ["mig-q1", "mig-q2", "mig-q3"].entries()) {
      yield* TestClock.adjust("1 second");
      yield* queueText(orchestrator, alpha, key, `queued ${index + 1}`);
    }
    const before = yield* projections.getThreadProjection(alpha);
    assert.lengthOf(
      before.runs.filter((run) => run.status === "queued"),
      3,
    );
    yield* finishRunsInFixture(projections, outbox, alpha);
    yield* rotateSession(orchestrator, {
      commandId: "rotate-migrate",
      markCommandId: "mark-migrate-a",
      threadId: alpha,
      targetThreadId: bravo,
    });

    // The three queued copies are cancelled on the sealed thread and deliver nothing there.
    const alphaAfter = yield* projections.getThreadProjection(alpha);
    for (const key of ["mig-q1", "mig-q2", "mig-q3"]) {
      const tombstone = alphaAfter.runs.find(
        (run) => run.userMessageId === MessageId.make(`message:${key}`),
      );
      assert.equal(tombstone?.status, "cancelled");
      assert.isNull(tombstone?.queuePosition ?? null);
    }
    assert.lengthOf(queuedRunsInDeliveryOrder(alphaAfter), 0);

    const bravoAfter = yield* projections.getThreadProjection(bravo);
    const opening = bravoAfter.runs.find((run) => run.userMessageId.startsWith("bot-rotation:"));
    assert.equal(opening?.status, "starting");
    const carried = queuedRunsInDeliveryOrder(bravoAfter);
    assert.lengthOf(carried, 3);
    assert.deepEqual(
      carried.map((run) => run.userMessageId),
      ["mig-q1", "mig-q2", "mig-q3"].map((key) => MessageId.make(`message:${key}~${bravo}`)),
    );
    assert.deepEqual(
      carried.map((run) => run.queuePosition),
      [1, 2, 3],
    );
    assert.deepEqual(
      carried.map(
        (run) => bravoAfter.messages.find((message) => message.id === run.userMessageId)?.text,
      ),
      ["queued 1", "queued 2", "queued 3"],
    );
    // Nothing stays queued on the old thread and nothing is duplicated.
    assert.lengthOf(
      bravoAfter.runs.filter((run) => !run.userMessageId.startsWith("bot-rotation:")),
      3,
    );

    // The opening finishes first; only then does the queue start in the same order.
    yield* finishRunsInFixture(projections, outbox, bravo);
    const startQueued = (runId: RunId, commandId: string) =>
      orchestrator.dispatch({
        type: "queued-run.start",
        commandId: CommandId.make(commandId),
        threadId: bravo,
        runId,
      });
    yield* startQueued(carried[0]!.id, "migrate-start-1");
    const afterFirst = yield* projections.getThreadProjection(bravo);
    assert.notEqual(afterFirst.runs.find((run) => run.id === carried[0]!.id)?.status, "queued");
    assert.deepEqual(
      queuedRunsInDeliveryOrder(afterFirst).map((run) => run.id),
      [carried[1]!.id, carried[2]!.id],
    );
    yield* finishRunsInFixture(projections, outbox, bravo);
    yield* startQueued(carried[1]!.id, "migrate-start-2");
    const afterSecond = yield* projections.getThreadProjection(bravo);
    assert.deepEqual(
      queuedRunsInDeliveryOrder(afterSecond).map((run) => run.id),
      [carried[2]!.id],
    );

    // Replaying the rotation command replays the receipt instead of migrating twice.
    const replayed = yield* rotateSession(orchestrator, {
      commandId: "rotate-migrate",
      markCommandId: "mark-migrate-a",
      threadId: alpha,
      targetThreadId: bravo,
    });
    assert.equal(replayed.replayed, true);
    const bravoFinal = yield* projections.getThreadProjection(bravo);
    assert.lengthOf(
      bravoFinal.messages.filter((message) => message.id.startsWith("message:mig-q1~")),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

const noReceipt = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_command_receipts
      WHERE command_id = ${commandId}
    `;
    assert.equal(rows[0]?.count, 0);
  });

it.effect("late messages follow rotatedTo and a second copy is not written", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const origin = ThreadId.make("thread:follow-origin");
    const home = ThreadId.make("thread:follow-home");
    const later = ThreadId.make("thread:follow-later");
    yield* createThread(orchestrator, origin, "Follow origin");
    yield* markCommander(orchestrator, origin, "mark-follow-origin");
    yield* rotateSession(orchestrator, {
      commandId: "rotate-follow-1",
      markCommandId: "mark-follow-origin",
      threadId: origin,
      targetThreadId: home,
    });
    yield* rotateSession(orchestrator, {
      commandId: "rotate-follow-2",
      markCommandId: "mark-follow-origin",
      threadId: home,
      targetThreadId: later,
    });
    yield* sendText(orchestrator, origin, "follow-message", "hello");
    yield* sendText(orchestrator, origin, "follow-message", "hello");
    // Each rotation writes one opening run on the new thread, so the forwarded message shares
    // the final thread with exactly one of them and the hop thread keeps its cancelled opening.
    const laterRuns = (yield* projections.getThreadProjection(later)).runs;
    const laterUserRuns = laterRuns.filter((run) => !run.userMessageId.startsWith("bot-rotation:"));
    assert.lengthOf(laterUserRuns, 1);
    assert.lengthOf(laterRuns, 2);
    assert.lengthOf((yield* projections.getThreadProjection(origin)).runs, 0);
    const homeRuns = (yield* projections.getThreadProjection(home)).runs;
    assert.lengthOf(homeRuns, 1);
    assert.equal(homeRuns[0]?.status, "cancelled");
    assert.equal(homeRuns[0]?.userMessageId, MessageId.make(`bot-rotation:${home}`));

    const bound = yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("follow-steer"),
        threadId: origin,
        messageId: MessageId.make("message:follow-steer"),
        text: "steer",
        attachments: [],
        dispatchMode: { type: "steer_active", targetRunId: RunId.make("run:follow-old") },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.equal(bound._tag, "OrchestratorThreadRotatedError");
    if (bound._tag === "OrchestratorThreadRotatedError") {
      assert.equal(bound.successorThreadId, home);
    }
    yield* noReceipt("follow-steer");
    assert.lengthOf(
      (yield* projections.getThreadProjection(later)).runs.filter(
        (run) => !run.userMessageId.startsWith("bot-rotation:"),
      ),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rotation forwarding stops after eight hops and rejects a cycle", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const origin = ThreadId.make("thread:hop-0");
    yield* createThread(orchestrator, origin, "Hop origin");
    yield* markCommander(orchestrator, origin, "mark-hop-0");
    let current = origin;
    for (let hop = 1; hop <= 8; hop++) {
      const next = ThreadId.make(`thread:hop-${hop}`);
      yield* rotateSession(orchestrator, {
        commandId: `rotate-hop-${hop}`,
        markCommandId: "mark-hop-0",
        threadId: current,
        targetThreadId: next,
      });
      current = next;
    }
    yield* sendText(orchestrator, origin, "hop-message", "arrived");
    const hopRuns = (yield* projections.getThreadProjection(current)).runs;
    assert.lengthOf(
      hopRuns.filter((run) => !run.userMessageId.startsWith("bot-rotation:")),
      1,
    );
    // The opening turn itself also lives there; only one copy of the user message does.
    assert.lengthOf(hopRuns, 2);

    const farOrigin = ThreadId.make("thread:far-0");
    yield* createThread(orchestrator, farOrigin, "Far origin");
    yield* markCommander(orchestrator, farOrigin, "mark-far-0");
    let farCurrent = farOrigin;
    for (let hop = 1; hop <= 9; hop++) {
      const next = ThreadId.make(`thread:far-${hop}`);
      yield* rotateSession(orchestrator, {
        commandId: `rotate-far-${hop}`,
        markCommandId: "mark-far-0",
        threadId: farCurrent,
        targetThreadId: next,
      });
      farCurrent = next;
    }
    const tooFar = yield* sendText(orchestrator, farOrigin, "hop-message-too-far", "no").pipe(
      Effect.flip,
    );
    assert.equal(tooFar._tag, "OrchestratorThreadRotatedError");
    yield* noReceipt("hop-message-too-far");
    assert.lengthOf(
      (yield* projections.getThreadProjection(farCurrent)).runs.filter(
        (run) => !run.userMessageId.startsWith("bot-rotation:"),
      ),
      0,
    );

    const left = ThreadId.make("thread:cycle-left");
    const right = ThreadId.make("thread:cycle-right");
    yield* createThread(orchestrator, left, "Cycle left");
    yield* createThread(orchestrator, right, "Cycle right");
    const now = yield* DateTime.now;
    const point = (threadId: ThreadId, other: ThreadId) =>
      projections.getThread(threadId).pipe(
        Effect.flatMap((thread) =>
          projections.apply({
            id: EventId.make(`event:cycle-${threadId}`),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: {
              ...thread,
              rotatedTo: {
                threadId: other,
                botId: BotId.make("bot:cycle"),
                rotatedAt: now,
              },
            },
          }),
        ),
      );
    yield* point(left, right);
    yield* point(right, left);
    const loop = yield* sendText(orchestrator, left, "cycle-message", "loop").pipe(Effect.flip);
    assert.equal(loop._tag, "OrchestratorDispatchError");
    assert.include(
      loop.cause instanceof Error ? loop.cause.message : String(loop.cause),
      "rotation chain loops",
    );
    yield* noReceipt("cycle-message");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rotate-session refuses a busy thread without a receipt and retries the same command",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:quiet-run");
      const targetId = ThreadId.make("thread:quiet-run-next");
      yield* createThread(orchestrator, threadId, "Quiet");
      yield* markCommander(orchestrator, threadId, "mark-quiet-run");
      const now = yield* DateTime.now;
      const runId = RunId.make("run:quiet");
      yield* projections.apply({
        id: EventId.make("event:quiet-run"),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:quiet"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const refused = yield* rotateSession(orchestrator, {
        commandId: "rotate-quiet-run",
        markCommandId: "mark-quiet-run",
        threadId,
        targetThreadId: targetId,
      }).pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.include(
        refused.cause instanceof Error ? refused.cause.message : String(refused.cause),
        "has a live run",
      );
      yield* noReceipt("rotate-quiet-run");
      assert.deepEqual(yield* outbox.listByCommandId(CommandId.make("rotate-quiet-run")), []);
      assert.isNull(yield* projections.getThreadShell(targetId));
      const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
      yield* projections.apply({
        id: EventId.make("event:quiet-run-done"),
        type: "run.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      const accepted = yield* rotateSession(orchestrator, {
        commandId: "rotate-quiet-run",
        markCommandId: "mark-quiet-run",
        threadId,
        targetThreadId: targetId,
      });
      assert.isUndefined(accepted.replayed);
      assert.equal(
        (yield* projections.getBot(BotId.make("bot:mark-quiet-run")))?.currentThreadId,
        targetId,
      );
    }).pipe(Effect.provide(layerTest)),
);
interface QuietFixtureContext {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly projections: ProjectionStore.ProjectionStoreV2Shape;
  readonly outbox: EffectOutbox.EffectOutboxV2Shape;
  readonly threadId: ThreadId;
  readonly key: string;
}

const quietCase = <EArrange, EClear>(
  key: string,
  reason: string,
  arrange: (ctx: QuietFixtureContext) => Effect.Effect<void, EArrange, SqlClient.SqlClient>,
  clear: (ctx: QuietFixtureContext) => Effect.Effect<void, EClear, SqlClient.SqlClient>,
) => ({
  key,
  reason,
  arrange: (ctx: QuietFixtureContext) => arrange(ctx).pipe(Effect.orDie),
  clear: (ctx: QuietFixtureContext) => clear(ctx).pipe(Effect.orDie),
});

const patchThread = (
  ctx: QuietFixtureContext,
  patch: (
    thread: {
      readonly rotatedTo?: unknown;
    } & Record<string, unknown>,
  ) => Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const thread = yield* ctx.projections.getThread(ctx.threadId);
    const now = yield* DateTime.now;
    yield* ctx.projections.apply({
      id: EventId.make(`event:${ctx.key}:thread-patch:${String(now)}`),
      type: "thread.metadata-updated",
      threadId: ctx.threadId,
      occurredAt: now,
      payload: patch(thread as never) as never,
    });
  });

const quietCases = [
  quietCase(
    "queued",
    "has queued messages it cannot carry",
    (ctx) =>
      applyRun(ctx.projections, {
        threadId: ctx.threadId,
        runId: RunId.make(`run:${ctx.key}`),
        ordinal: 1,
        status: "queued",
        queuePosition: 1,
        queueHeld: true,
      }),
    (ctx) =>
      applyRun(ctx.projections, {
        threadId: ctx.threadId,
        runId: RunId.make(`run:${ctx.key}`),
        ordinal: 1,
        status: "cancelled",
      }),
  ),
  quietCase(
    "live-run",
    "has a live run",
    (ctx) =>
      applyRun(ctx.projections, {
        threadId: ctx.threadId,
        runId: RunId.make(`run:${ctx.key}`),
        ordinal: 1,
        status: "running",
      }),
    (ctx) =>
      applyRun(ctx.projections, {
        threadId: ctx.threadId,
        runId: RunId.make(`run:${ctx.key}`),
        ordinal: 1,
        status: "completed",
      }),
  ),
  quietCase(
    "runtime-request",
    "has a pending runtime request",
    (ctx) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:request`),
          type: "runtime-request.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`request:${ctx.key}`),
            nodeId: NodeId.make(`node:${ctx.key}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }),
    (ctx) =>
      Effect.gen(function* () {
        const request = (yield* ctx.projections.getThreadRecords(ctx.threadId, ["runtimeRequests"]))
          .runtimeRequests[0]!;
        const now = yield* DateTime.now;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:request-resolved`),
          type: "runtime-request.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: { ...request, status: "resolved", resolvedAt: now },
        });
      }),
  ),
  quietCase(
    "rewind",
    "has a rewind in progress",
    (ctx) =>
      patchThread(ctx, (thread) => ({
        ...thread,
        pendingRollback: {
          requestId: CommandId.make(`rollback:${ctx.key}`),
          turnCount: 0,
          restoreFiles: true,
          requestedAt: thread.createdAt,
        },
      })),
    (ctx) =>
      patchThread(ctx, (thread) => {
        const { pendingRollback: _pendingRollback, ...rest } = thread;
        return rest;
      }),
  ),
  quietCase(
    "merge-back",
    "has unconsumed merge-back context",
    (ctx) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:merge-back`),
          type: "context-transfer.created",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: {
            id: ContextTransferId.make(`transfer:${ctx.key}`),
            type: "merge_back",
            sourceThreadId: ThreadId.make(`thread:${ctx.key}:side`),
            targetThreadId: ctx.threadId,
            sourcePoint: { threadId: ThreadId.make(`thread:${ctx.key}:side`) },
            basePoint: null,
            sourceProviderInstanceId: instanceId,
            targetProviderInstanceId: null,
            targetRunId: null,
            status: "pending",
            resolution: null,
            createdBy: "user",
            error: null,
            createdAt: now,
            updatedAt: now,
            consumedAt: null,
          },
        });
      }),
    (ctx) =>
      Effect.gen(function* () {
        const transfer = (yield* ctx.projections.getThreadRecords(ctx.threadId, [
          "contextTransfers",
        ])).contextTransfers[0]!;
        const now = yield* DateTime.now;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:merge-back-consumed`),
          type: "context-transfer.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: { ...transfer, status: "consumed", consumedAt: now, updatedAt: now },
        });
      }),
  ),
  quietCase(
    "background-work",
    "has background work",
    (ctx) =>
      Effect.gen(function* () {
        yield* applyRun(ctx.projections, {
          threadId: ctx.threadId,
          runId: RunId.make(`run:${ctx.key}`),
          ordinal: 1,
          status: "completed",
        });
        const now = yield* DateTime.now;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:bg-thread`),
          type: "provider-thread.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: {
            id: ProviderThreadId.make(`provider-thread:${ctx.key}`),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: ctx.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [
              {
                taskId: `task:${ctx.key}`,
                kind: "command" as const,
                status: "running" as const,
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
        });
      }),
    (ctx) =>
      Effect.gen(function* () {
        const thread = (yield* ctx.projections.getThreadRecords(ctx.threadId, ["providerThreads"]))
          .providerThreads[0]!;
        const now = yield* DateTime.now;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:bg-thread-done`),
          type: "provider-thread.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: { ...thread, pendingBackgroundTasks: [], updatedAt: now },
        });
      }),
  ),
  quietCase(
    "delegation",
    "has an open delegation",
    (ctx) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:subagent`),
          type: "subagent.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: {
            id: NodeId.make(`node:${ctx.key}`),
            threadId: ctx.threadId,
            runId: null,
            parentNodeId: NodeId.make(`node:${ctx.key}:parent`),
            origin: "provider_native",
            createdBy: "agent",
            driver,
            providerInstanceId: instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "fixture task",
            title: null,
            model: null,
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          },
        });
      }),
    (ctx) =>
      Effect.gen(function* () {
        const subagent = (yield* ctx.projections.getThreadRecords(ctx.threadId, ["subagents"]))
          .subagents[0]!;
        const now = yield* DateTime.now;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:subagent-done`),
          type: "subagent.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: { ...subagent, status: "completed", completedAt: now, updatedAt: now },
        });
      }),
  ),
  quietCase(
    "mailbox",
    "has an undelivered mailbox delivery",
    (ctx) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const runId = RunId.make(`run:${ctx.key}`);
        yield* applyRun(ctx.projections, {
          threadId: ctx.threadId,
          runId,
          ordinal: 1,
          status: "completed",
          userMessageId: MessageId.make(`message:${ctx.key}:original`),
        });
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:mailbox`),
          type: "message.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: {
            id: MessageId.make(`message:${ctx.key}:mailbox`),
            threadId: ctx.threadId,
            runId,
            nodeId: null,
            role: "user",
            text: "delegated completion",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: now,
            updatedAt: now,
            delegatedCompletion: {
              parentRunId: RunId.make(`run:${ctx.key}:parent`),
              generation: 1,
              taskIds: [NodeId.make(`node:${ctx.key}`)],
            },
          },
        });
      }),
    (ctx) =>
      Effect.gen(function* () {
        const message = (yield* ctx.projections.getThreadRecords(ctx.threadId, [
          "messages",
        ])).messages.find((candidate) => candidate.delegatedCompletion !== undefined)!;
        const now = yield* DateTime.now;
        const { delegatedCompletion: _delivered, ...consumed } = message;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:mailbox-consumed`),
          type: "message.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: { ...consumed, updatedAt: now },
        });
      }),
  ),
  quietCase(
    "provider-session",
    "has a live provider session",
    (ctx) =>
      Effect.gen(function* () {
        const sessionId = ProviderSessionId.make(`session:${ctx.key}`);
        yield* attachReadySession(ctx.projections, ctx.threadId, sessionId);
        const session = (yield* ctx.projections.getThreadRecords(ctx.threadId, [
          "providerSessions",
        ])).providerSessions[0]!;
        const now = yield* DateTime.now;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:session-running`),
          type: "provider-session.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: { ...session, status: "running", updatedAt: now },
        });
      }),
    (ctx) =>
      Effect.gen(function* () {
        const session = (yield* ctx.projections.getThreadRecords(ctx.threadId, [
          "providerSessions",
        ])).providerSessions[0]!;
        const now = yield* DateTime.now;
        yield* ctx.projections.apply({
          id: EventId.make(`event:${ctx.key}:session-stopped`),
          type: "provider-session.updated",
          threadId: ctx.threadId,
          occurredAt: now,
          payload: { ...session, status: "stopped", updatedAt: now },
        });
      }),
  ),
  quietCase(
    "unfinished-effects",
    "has unfinished effects",
    (ctx) =>
      ctx.outbox
        .enqueue([
          {
            id: `effect:${ctx.key}:provider-session.detach:fixture`,
            commandId: CommandId.make(`seed:${ctx.key}`),
            threadId: ctx.threadId,
            request: {
              type: "provider-session.detach",
              providerSessionId: ProviderSessionId.make(`session:${ctx.key}:fixture`),
              detail: "fixture",
            },
          },
        ])
        .pipe(Effect.asVoid),
    (ctx) =>
      ctx.outbox
        .cancelUnsettled({
          threadId: ctx.threadId,
          effectTypes: ["provider-session.detach"],
          reason: "fixture cleanup",
        })
        .pipe(Effect.asVoid),
  ),
  quietCase(
    "deleted",
    "is deleted",
    (ctx) =>
      patchThread(ctx, (thread) => ({
        ...thread,
        deletedAt: thread.updatedAt,
      })),
    (ctx) =>
      patchThread(ctx, (thread) => ({
        ...thread,
        deletedAt: null,
      })),
  ),
] as const;

it.effect.each(quietCases)(
  "rotate-session refuses a thread that $key without a receipt and retries after it clears",
  ({ key, reason, arrange, clear }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make(`thread:quiet:${key}`);
      const targetId = ThreadId.make(`thread:quiet:${key}:next`);
      yield* createThread(orchestrator, threadId, "Quiet");
      yield* markCommander(orchestrator, threadId, `mark-quiet-${key}`);
      const ctx: QuietFixtureContext = { orchestrator, projections, outbox, threadId, key };
      yield* arrange(ctx);
      const commandId = `rotate-quiet-${key}`;
      const refused = yield* rotateSession(orchestrator, {
        commandId,
        markCommandId: `mark-quiet-${key}`,
        threadId,
        targetThreadId: targetId,
      }).pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.include(
        refused.cause instanceof Error ? refused.cause.message : String(refused.cause),
        reason,
      );
      yield* noReceipt(commandId);
      assert.deepEqual(yield* outbox.listByCommandId(CommandId.make(commandId)), []);
      assert.isNull(yield* projections.getThreadShell(targetId));
      assert.equal(
        (yield* projections.getBot(BotId.make(`bot:mark-quiet-${key}`)))?.currentThreadId,
        threadId,
      );
      yield* clear(ctx);
      const accepted = yield* rotateSession(orchestrator, {
        commandId,
        markCommandId: `mark-quiet-${key}`,
        threadId,
        targetThreadId: targetId,
      });
      assert.isUndefined(accepted.replayed);
      assert.equal(
        (yield* projections.getBot(BotId.make(`bot:mark-quiet-${key}`)))?.currentThreadId,
        targetId,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rotate-session refuses a thread that was already left and records no receipt", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const source = ThreadId.make("thread:already-left");
    const first = ThreadId.make("thread:already-left-next");
    const second = ThreadId.make("thread:already-left-again");
    yield* createThread(orchestrator, source, "Already");
    yield* markCommander(orchestrator, source, "mark-already-left");
    yield* rotateSession(orchestrator, {
      commandId: "rotate-already-first",
      markCommandId: "mark-already-left",
      threadId: source,
      targetThreadId: first,
    });
    const refused = yield* rotateSession(orchestrator, {
      commandId: "rotate-already-second",
      markCommandId: "mark-already-left",
      threadId: source,
      targetThreadId: second,
    }).pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorThreadRotatedError");
    yield* noReceipt("rotate-already-second");
    assert.isNull(yield* projections.getThreadShell(second));
    assert.equal(
      (yield* projections.getBot(BotId.make("bot:mark-already-left")))?.currentThreadId,
      first,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rotate-session carries an unconsumed fork transfer forward and supersedes the old one",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const zulu = ThreadId.make("thread:inherit-z");
      const alpha = ThreadId.make("thread:inherit-a");
      const bravo = ThreadId.make("thread:inherit-b");
      yield* createThread(orchestrator, zulu, "Z");
      yield* markCommander(orchestrator, zulu, "mark-inherit-z");
      yield* seedForkableTurn(projections, { threadId: zulu, key: "inherit-z" });
      yield* rotateSession(orchestrator, {
        commandId: "rotate-inherit-za",
        markCommandId: "mark-inherit-z",
        threadId: zulu,
        targetThreadId: alpha,
      });
      yield* rotateSession(orchestrator, {
        commandId: "rotate-inherit-ab",
        markCommandId: "mark-inherit-z",
        threadId: alpha,
        targetThreadId: bravo,
      });
      // A's opening never reached a provider, so the rotation onto B supersedes the transfer it
      // had consumed and B carries that same source forward instead of the runless A. B's own
      // opening consumes the fresh copy at dispatch, so nothing stays pending for a user message.
      const alphaTransfers = (yield* projections.getThreadProjection(alpha)).contextTransfers;
      assert.lengthOf(alphaTransfers, 1);
      assert.equal(alphaTransfers[0]?.status, "superseded");
      const bravoTransfers = (yield* projections.getThreadProjection(bravo)).contextTransfers;
      assert.lengthOf(bravoTransfers, 1);
      const transfer = bravoTransfers[0]!;
      assert.equal(transfer.status, "consumed");
      assert.equal(transfer.resolution?.strategy, "portable_context");
      assert.equal(transfer.requiresPortable, true);
      assert.equal(transfer.sourceThreadId, zulu);
      assert.equal(transfer.sourcePoint.runId, RunId.make("run:inherit-z"));
      assert.equal(transfer.sourceProviderInstanceId, instanceId);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a message accepted before rotation replays in place instead of forwarding", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const alpha = ThreadId.make("thread:replay-a");
    const bravo = ThreadId.make("thread:replay-b");
    yield* createThread(orchestrator, alpha, "Replay A");
    yield* markCommander(orchestrator, alpha, "mark-replay-a");
    yield* sendText(orchestrator, alpha, "replay-message", "hello");
    assert.lengthOf((yield* projections.getThreadProjection(alpha)).runs, 1);
    // Rotation requires a quiet thread; settle the turn effect and end the run the way a
    // finished provider turn does.
    yield* outbox
      .cancelUnsettled({
        threadId: alpha,
        effectTypes: ["provider-turn.start"],
        reason: "turn finished in fixture",
      })
      .pipe(Effect.asVoid);
    const run = (yield* projections.getThreadRecords(alpha, ["runs"])).runs[0]!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:replay-run-completed"),
      type: "run.updated",
      threadId: alpha,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    yield* rotateSession(orchestrator, {
      commandId: "rotate-replay",
      markCommandId: "mark-replay-a",
      threadId: alpha,
      targetThreadId: bravo,
    });
    const replayed = yield* sendText(orchestrator, alpha, "replay-message", "hello");
    assert.equal(replayed.replayed, true);
    // Bravo holds only its opening run: the replayed receipt keeps the message on alpha and
    // writes no copy.
    const bravoRuns = (yield* projections.getThreadProjection(bravo)).runs;
    assert.lengthOf(
      bravoRuns.filter((run) => !run.userMessageId.startsWith("bot-rotation:")),
      0,
    );
    assert.lengthOf((yield* projections.getThreadProjection(alpha)).runs, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("read-only rotated threads refuse commander marks and switch-thread moves", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const alpha = ThreadId.make("thread:readonly-a");
    const bravo = ThreadId.make("thread:readonly-b");
    const other = ThreadId.make("thread:readonly-other");
    yield* createThread(orchestrator, alpha, "Readonly A");
    yield* createThread(orchestrator, other, "Other");
    yield* markCommander(orchestrator, alpha, "mark-readonly-a");
    yield* markCommander(orchestrator, other, "mark-readonly-other");
    yield* rotateSession(orchestrator, {
      commandId: "rotate-readonly",
      markCommandId: "mark-readonly-a",
      threadId: alpha,
      targetThreadId: bravo,
    });

    const marked = yield* orchestrator
      .dispatch({
        type: "thread.commander.mark",
        commandId: CommandId.make("mark-readonly-again"),
        threadId: alpha,
      })
      .pipe(Effect.flip);
    assert.equal(marked._tag, "OrchestratorThreadRotatedError");
    assert.isNull((yield* projections.getThreadProjection(alpha)).bot);

    // The bot is on B; a switch naming read-only A as its source is refused.
    const fromSource = yield* orchestrator
      .dispatch({
        type: "bot.switch-thread",
        commandId: CommandId.make("switch-readonly-source"),
        botId: BotId.make("bot:mark-readonly-a"),
        threadId: alpha,
        targetThreadId: other,
      })
      .pipe(Effect.flip);
    assert.equal(fromSource._tag, "OrchestratorThreadRotatedError");

    // A switch onto read-only A from a live thread is refused.
    const toRotated = yield* orchestrator
      .dispatch({
        type: "bot.switch-thread",
        commandId: CommandId.make("switch-readonly-target"),
        botId: BotId.make("bot:mark-readonly-other"),
        threadId: other,
        targetThreadId: alpha,
      })
      .pipe(Effect.flip);
    assert.equal(toRotated._tag, "OrchestratorThreadRotatedError");
    assert.equal(
      (yield* projections.getBot(BotId.make("bot:mark-readonly-other")))?.currentThreadId,
      other,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rotation refuses a target thread id another commander rotates onto first", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const first = ThreadId.make("thread:target-first");
    const second = ThreadId.make("thread:target-second");
    const target = ThreadId.make("thread:target-shared");
    yield* createThread(orchestrator, first, "First");
    yield* createThread(orchestrator, second, "Second");
    yield* markCommander(orchestrator, first, "mark-target-first");
    yield* markCommander(orchestrator, second, "mark-target-second");
    yield* rotateSession(orchestrator, {
      commandId: "rotate-target-first",
      markCommandId: "mark-target-first",
      threadId: first,
      targetThreadId: target,
    });
    const refused = yield* rotateSession(orchestrator, {
      commandId: "rotate-target-second",
      markCommandId: "mark-target-second",
      threadId: second,
      targetThreadId: target,
    }).pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorDispatchError");
    yield* noReceipt("rotate-target-second");
    assert.equal(
      (yield* projections.getBot(BotId.make("bot:mark-target-second")))?.currentThreadId,
      second,
    );
    // The target belongs to the first rotation only.
    assert.equal((yield* projections.getThreadProjection(target)).thread.rotatedTo ?? null, null);
    assert.equal(
      (yield* projections.getBot(BotId.make("bot:mark-target-first")))?.currentThreadId,
      target,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("two concurrent rotations of one bot commit exactly one thread", () => {
  const alpha = ThreadId.make("thread:race-rotate-a");
  const targetOne = ThreadId.make("thread:race-rotate-t1");
  const targetTwo = ThreadId.make("thread:race-rotate-t2");
  const firstReadEntered = Deferred.makeUnsafe<void>();
  const firstReadRelease = Deferred.makeUnsafe<void>();
  let gateArmed = false;
  const layerGated = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "bot-rotate-concurrent" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: layerDatabase,
        runEffectWorker: false,
        wrapProjectionStore: (store) => ({
          ...store,
          getThread: (id) => {
            if (!gateArmed || id !== alpha) return store.getThread(id);
            gateArmed = false;
            return store.getThread(id).pipe(
              Effect.tap(() => Deferred.succeed(firstReadEntered, undefined)),
              Effect.tap(() => Deferred.await(firstReadRelease)),
            );
          },
        }),
      },
    ),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread(orchestrator, alpha, "Concurrent");
    yield* markCommander(orchestrator, alpha, "mark-race-rotate");
    gateArmed = true;
    const firstFiber = yield* rotateSession(orchestrator, {
      commandId: "rotate-race-one",
      markCommandId: "mark-race-rotate",
      threadId: alpha,
      targetThreadId: targetOne,
    }).pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(firstReadEntered);
    const secondFiber = yield* rotateSession(orchestrator, {
      commandId: "rotate-race-two",
      markCommandId: "mark-race-rotate",
      threadId: alpha,
      targetThreadId: targetTwo,
    }).pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.succeed(firstReadRelease, undefined);
    const firstExit = yield* Fiber.join(firstFiber);
    const secondExit = yield* Fiber.join(secondFiber);
    assert.isTrue(Exit.isSuccess(firstExit));
    assert.isTrue(Exit.isFailure(secondExit));
    const winner = Exit.isSuccess(firstExit) ? targetOne : targetTwo;
    const loser = Exit.isSuccess(firstExit) ? targetTwo : targetOne;
    assert.equal(
      (yield* projections.getBot(BotId.make("bot:mark-race-rotate")))?.currentThreadId,
      winner,
    );
    assert.isNull(yield* projections.getThreadShell(loser));
    yield* noReceipt("rotate-race-two");
  }).pipe(Effect.provide(layerGated));
});

it.effect("metadata updates never strip a rotated thread's successor", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const alpha = ThreadId.make("thread:persist-a");
    const bravo = ThreadId.make("thread:persist-b");
    yield* createThread(orchestrator, alpha, "Persist A");
    yield* markCommander(orchestrator, alpha, "mark-persist-a");
    yield* rotateSession(orchestrator, {
      commandId: "rotate-persist",
      markCommandId: "mark-persist-a",
      threadId: alpha,
      targetThreadId: bravo,
    });
    // A writer replaying pre-rotation state (an old server's event, or a direct apply)
    // must not reopen the thread.
    const stale = yield* projections.getThread(alpha);
    const now = yield* DateTime.now;
    const { rotatedTo: _rotatedTo, ...withoutRotation } = stale;
    yield* projections.apply({
      id: EventId.make("event:persist-stale-metadata"),
      type: "thread.metadata-updated",
      threadId: alpha,
      occurredAt: now,
      payload: withoutRotation,
    });
    const after = yield* projections.getThreadProjection(alpha);
    assert.equal(after.thread.rotatedTo?.threadId, bravo);
    // Still read-only: a commander mark is refused and a plain message forwards to the successor.
    const marked = yield* markCommander(orchestrator, alpha, "mark-persist-again").pipe(
      Effect.flip,
    );
    assert.equal(marked._tag, "OrchestratorThreadRotatedError");
    yield* sendText(orchestrator, alpha, "persist-message", "late");
    assert.lengthOf(
      (yield* projections.getThreadProjection(bravo)).runs.filter(
        (run) => !run.userMessageId.startsWith("bot-rotation:"),
      ),
      1,
    );
    assert.lengthOf((yield* projections.getThreadProjection(alpha)).runs, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a rotate that lands while a forwarded message waits is followed once", () => {
  const origin = ThreadId.make("thread:race-origin");
  const home = ThreadId.make("thread:race-home");
  const newer = ThreadId.make("thread:race-newer");
  // The first read of the new home is the message's chain walk; holding it open lets the
  // next rotate commit before the message's in-lock read, the same interleaving a slow
  // lineage read produces in production.
  const walkReadEntered = Deferred.makeUnsafe<void>();
  const walkReadRelease = Deferred.makeUnsafe<void>();
  let gateArmed = false;
  const layerGated = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "bot-rotate-race" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: layerDatabase,
        runEffectWorker: false,
        wrapProjectionStore: (store) => ({
          ...store,
          getThread: (id) => {
            if (!gateArmed || id !== home) return store.getThread(id);
            gateArmed = false;
            // The walk resolves the pre-rotate thread, then stalls: the rewrite targets
            // the old home, the rotate commits meanwhile, and the in-lock guard re-walks.
            return store.getThread(id).pipe(
              Effect.tap(() => Deferred.succeed(walkReadEntered, undefined)),
              Effect.tap(() => Deferred.await(walkReadRelease)),
            );
          },
        }),
      },
    ),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread(orchestrator, origin, "Race origin");
    yield* markCommander(orchestrator, origin, "mark-race-origin");
    yield* rotateSession(orchestrator, {
      commandId: "rotate-race-1",
      markCommandId: "mark-race-origin",
      threadId: origin,
      targetThreadId: home,
    });
    gateArmed = true;
    const message = yield* sendText(orchestrator, origin, "race-message", "late").pipe(
      Effect.forkChild,
    );
    yield* Deferred.await(walkReadEntered);
    yield* rotateSession(orchestrator, {
      commandId: "rotate-race-2",
      markCommandId: "mark-race-origin",
      threadId: home,
      targetThreadId: newer,
    });
    yield* Deferred.succeed(walkReadRelease, undefined);
    yield* Fiber.join(message);
    const newerRuns = (yield* projections.getThreadProjection(newer)).runs;
    assert.lengthOf(
      newerRuns.filter((run) => !run.userMessageId.startsWith("bot-rotation:")),
      1,
    );
    // The forwarded message shares the final thread with its opening; the hop thread keeps
    // only its cancelled opening.
    assert.lengthOf(newerRuns, 2);
    assert.lengthOf((yield* projections.getThreadProjection(home)).runs, 1);
    assert.lengthOf((yield* projections.getThreadProjection(origin)).runs, 0);
  }).pipe(Effect.provide(layerGated));
});

it.effect("an injected enqueue failure rolls the rotate back and the same command retries", () => {
  const failEnqueues = { count: 1 };
  const layerFaulting = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "bot-rotate-enqueue-fault" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: layerDatabase,
        runEffectWorker: false,
        wrapEffectOutbox: (outbox) => ({
          ...outbox,
          enqueue: (effects) => {
            const hitsRotate =
              failEnqueues.count > 0 &&
              effects.some((effect) => effect.commandId === CommandId.make("rotate-fault"));
            if (!hitsRotate) return outbox.enqueue(effects);
            failEnqueues.count -= 1;
            return Effect.fail(
              new EffectOutbox.EffectOutboxError({
                operation: "enqueue",
                cause: "injected enqueue failure",
              }),
            );
          },
        }),
      },
    ),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:fault-source");
    const targetId = ThreadId.make("thread:fault-home");
    yield* createThread(orchestrator, threadId, "Fault");
    yield* markCommander(orchestrator, threadId, "mark-fault-source");
    yield* attachReadySession(
      projections,
      threadId,
      ProviderSessionId.make("session:fault-source"),
    );
    const failed = yield* rotateSession(orchestrator, {
      commandId: "rotate-fault",
      markCommandId: "mark-fault-source",
      threadId,
      targetThreadId: targetId,
    }).pipe(Effect.flip);
    assert.equal(failed._tag, "OrchestratorDispatchError");
    assert.isNull(yield* projections.getThreadShell(targetId));
    assert.equal(
      (yield* projections.getBot(BotId.make("bot:mark-fault-source")))?.currentThreadId,
      threadId,
    );
    yield* noReceipt("rotate-fault");
    const accepted = yield* rotateSession(orchestrator, {
      commandId: "rotate-fault",
      markCommandId: "mark-fault-source",
      threadId,
      targetThreadId: targetId,
    });
    assert.isUndefined(accepted.replayed);
    assert.equal(
      (yield* projections.getBot(BotId.make("bot:mark-fault-source")))?.currentThreadId,
      targetId,
    );
  }).pipe(Effect.provide(layerFaulting));
});

it.effect("rotation detach effects have stable ids and stay idempotent after process loss", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:detach-source");
    const targetId = ThreadId.make("thread:detach-home");
    yield* createThread(orchestrator, threadId, "Detach source");
    yield* markCommander(orchestrator, threadId, "mark-detach-source");
    const sessionId = ProviderSessionId.make("session:detach-source");
    yield* attachReadySession(projections, threadId, sessionId);
    yield* rotateSession(orchestrator, {
      commandId: "rotate-detach",
      markCommandId: "mark-detach-source",
      threadId,
      targetThreadId: targetId,
    });
    const effectId = `effect:rotate-detach:provider-session.detach:${sessionId}`;
    // The rotation also enqueues the opening turn's start; what matters here is that the
    // detach row exists under exactly this stable id.
    assert.isTrue(Option.isSome(yield* outbox.get(effectId)));
    // A worker that claimed the effect and died before settling it leaves the lease;
    // recovery requeues the same row instead of enqueueing a copy.
    let detachClaimed = false;
    for (let claim = 0; claim < 4 && !detachClaimed; claim++) {
      const workerA = yield* outbox.claimNext({ workerId: "worker-a" });
      if (!Option.isSome(workerA)) break;
      detachClaimed = workerA.value.id === effectId;
    }
    assert.isTrue(detachClaimed);
    const reconciled = yield* outbox.reconcileAfterProcessLoss;
    assert.isAtLeast(reconciled.requeued, 1);
    const settled = yield* worker.drain();
    assert.isAtLeast(settled, 1);
    const drainedAgain = yield* worker.drain();
    assert.equal(drainedAgain, 0);
    const effect = yield* outbox.get(effectId);
    assert.isTrue(Option.isSome(effect));
    if (Option.isSome(effect)) {
      assert.notInclude(["pending", "running"], effect.value.status);
    }
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND event_type = 'provider-session.detached'
    `;
    assert.equal(rows[0]?.count, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a failed opening handoff prepare rolls the whole rotation back and the same command retries",
  () => {
    const failPrepares = { count: 1 };
    const layerFailingPrepare = Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "bot-rotate-prepare-fault" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        {
          databaseLayer: layerDatabase,
          runEffectWorker: false,
          wrapContextHandoffService: (service) => ({
            ...service,
            prepareProviderHandoff: (input) => {
              if (failPrepares.count <= 0) return service.prepareProviderHandoff(input);
              failPrepares.count -= 1;
              return Effect.fail(
                new ContextHandoffService.ContextHandoffPrepareError({
                  threadId: input.threadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                  toProviderThreadId: input.toProviderThreadId,
                  cause: "injected handoff prepare failure",
                }),
              );
            },
          }),
        },
      ),
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const source = ThreadId.make("thread:prepare-source");
      const home = ThreadId.make("thread:prepare-home");
      yield* createThread(orchestrator, source, "Prepare source");
      yield* markCommander(orchestrator, source, "mark-prepare-source");
      yield* seedForkableTurn(projections, { threadId: source, key: "prepare-source" });
      // The opening consumes the handoff inside the rotation transaction, so a prepare failure
      // there must commit nothing at all.
      const failed = yield* rotateSession(orchestrator, {
        commandId: "rotate-prepare",
        markCommandId: "mark-prepare-source",
        threadId: source,
        targetThreadId: home,
      }).pipe(Effect.flip);
      assert.equal(failed._tag, "OrchestratorDispatchError");
      assert.isNull(yield* projections.getThreadShell(home));
      assert.equal(
        (yield* projections.getBot(BotId.make("bot:mark-prepare-source")))?.currentThreadId,
        source,
      );
      assert.isNull((yield* projections.getThreadProjection(source)).thread.rotatedTo ?? null);
      yield* noReceipt("rotate-prepare");
      const accepted = yield* rotateSession(orchestrator, {
        commandId: "rotate-prepare",
        markCommandId: "mark-prepare-source",
        threadId: source,
        targetThreadId: home,
      });
      assert.isUndefined(accepted.replayed);
      const homeProjection = yield* projections.getThreadProjection(home);
      assert.equal(homeProjection.bot?.currentThreadId, home);
      assert.equal(homeProjection.contextTransfers[0]?.status, "consumed");
    }).pipe(Effect.provide(layerFailingPrepare));
  },
);

it.effect("rotation refuses when the provider cannot consume a full-thread handoff", () => {
  const adapterNoHandoff = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () =>
      Effect.succeed({
        ...CodexProviderCapabilitiesV2,
        context: {
          ...CodexProviderCapabilitiesV2.context,
          supportsFullThreadHandoff: false,
        },
      }),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed for bot commands"),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  const layerNoHandoff = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "bot-rotate-no-handoff" },
      ProviderAdapterRegistry.layerFromAdapters([adapterNoHandoff]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const alpha = ThreadId.make("thread:nohandoff-a");
    const bravo = ThreadId.make("thread:nohandoff-b");
    yield* createThread(orchestrator, alpha, "No handoff");
    yield* markCommander(orchestrator, alpha, "mark-nohandoff");
    yield* seedForkableTurn(projections, { threadId: alpha, key: "nohandoff" });
    const refused = yield* rotateSession(orchestrator, {
      commandId: "rotate-nohandoff",
      markCommandId: "mark-nohandoff",
      threadId: alpha,
      targetThreadId: bravo,
    }).pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorDispatchError");
    yield* noReceipt("rotate-nohandoff");
    assert.isNull(yield* projections.getThreadShell(bravo));
    assert.equal(
      (yield* projections.getBot(BotId.make("bot:mark-nohandoff")))?.currentThreadId,
      alpha,
    );
    assert.isNull((yield* projections.getThreadProjection(alpha)).thread.rotatedTo ?? null);
  }).pipe(Effect.provide(layerNoHandoff));
});
