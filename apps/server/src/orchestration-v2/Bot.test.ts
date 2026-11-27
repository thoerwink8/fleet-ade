import { assert, it } from "@effect/vitest";
import {
  BotId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

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
