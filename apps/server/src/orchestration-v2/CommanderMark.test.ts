import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  openSession: () => Effect.die("No provider process needed for commander marks"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "commander-mark" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("marks and unmarks a commander without detaching its child", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:commander-parent");
    const otherThreadId = ThreadId.make("thread:commander-other");
    const projectId = ProjectId.make("project:commander");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-commander-parent"),
      threadId: parentThreadId,
      projectId,
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-commander-other"),
      threadId: otherThreadId,
      projectId,
      title: "Other",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-commander-parent"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:commander-parent"),
      text: "Delegate the work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-commander-child"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Do the work",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const childThreadId = (yield* projections.getThreadProjection(parentThreadId)).subagents[0]!
      .childThreadId!;
    const before = yield* projections.getThreadProjection(parentThreadId);
    const childBefore = yield* projections.getThreadProjection(childThreadId);
    assert.isNull(before.bot);
    assert.equal(childBefore.thread.lineage.parentThreadId, parentThreadId);

    const marked = yield* orchestrator.dispatch({
      type: "thread.commander.mark",
      commandId: CommandId.make("mark-commander-parent"),
      threadId: parentThreadId,
    });
    yield* orchestrator.dispatch({
      type: "thread.commander.mark",
      commandId: CommandId.make("mark-commander-other"),
      threadId: otherThreadId,
    });
    const markedAgain = yield* orchestrator.dispatch({
      type: "thread.commander.mark",
      commandId: CommandId.make("mark-commander-parent-again"),
      threadId: parentThreadId,
    });
    const markedParent = yield* projections.getThreadProjection(parentThreadId);
    const markedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
      (thread) => thread.id === parentThreadId,
    );
    const markedOther = yield* projections.getThreadProjection(otherThreadId);
    assert.deepEqual(
      marked.storedEvents.map((stored) => stored.event.type),
      ["bot.created"],
    );
    assert.equal(marked.storedEvents[0]?.event.threadId, parentThreadId);
    assert.lengthOf(markedAgain.storedEvents, 0);
    // The thread payload carries no commander key: the bot is the only record.
    assert.isFalse("commander" in markedParent.thread);
    assert.equal(markedParent.bot?.currentThreadId, parentThreadId);
    assert.equal(markedParent.bot?.name, "Parent");
    assert.equal(markedParent.bot?.status, "active");
    const firstBotId = markedParent.bot?.id;
    assert.isDefined(firstBotId);
    assert.equal(markedShell?.commander, true);
    assert.isNotNull(markedOther.bot);
    assert.equal(
      DateTime.toEpochMillis(markedParent.thread.updatedAt),
      DateTime.toEpochMillis(before.thread.updatedAt),
    );
    assert.equal(markedParent.thread.lineage.parentThreadId, before.thread.lineage.parentThreadId);
    assert.deepEqual(
      markedParent.runs.map((run) => [run.id, run.status]),
      before.runs.map((run) => [run.id, run.status]),
    );

    const childStillAttached = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(childStillAttached.thread, childBefore.thread);
    const unmarked = yield* orchestrator.dispatch({
      type: "thread.commander.unmark",
      commandId: CommandId.make("unmark-commander-parent"),
      threadId: parentThreadId,
    });
    const unmarkedParent = yield* projections.getThreadProjection(parentThreadId);
    const unmarkedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
      (thread) => thread.id === parentThreadId,
    );
    const childAfter = yield* projections.getThreadProjection(childThreadId);
    const otherAfter = yield* projections.getThreadProjection(otherThreadId);
    assert.deepEqual(
      unmarked.storedEvents.map((stored) => stored.event.threadId),
      [parentThreadId],
    );
    assert.equal(unmarked.storedEvents[0]?.event.type, "bot.retired");
    const retiredEvent = unmarked.storedEvents[0]?.event;
    assert.equal(
      retiredEvent?.type === "bot.retired" ? retiredEvent.payload.id : undefined,
      firstBotId,
    );
    assert.equal(
      retiredEvent?.type === "bot.retired" ? retiredEvent.payload.status : undefined,
      "retired",
    );
    assert.isNull(unmarkedParent.bot);
    assert.isFalse("commander" in unmarkedParent.thread);
    assert.equal(unmarkedShell?.commander, false);
    assert.isNotNull(otherAfter.bot);
    assert.equal(
      DateTime.toEpochMillis(unmarkedParent.thread.updatedAt),
      DateTime.toEpochMillis(before.thread.updatedAt),
    );
    assert.equal(unmarkedParent.thread.deletedAt, null);
    assert.deepEqual(childAfter.thread, childBefore.thread);
    assert.equal(childAfter.thread.lineage.parentThreadId, parentThreadId);
    assert.deepEqual(
      childAfter.runs.map((run) => [run.id, run.status]),
      childBefore.runs.map((run) => [run.id, run.status]),
    );
    assert.deepEqual(
      unmarkedParent.runs.map((run) => [run.id, run.status]),
      before.runs.map((run) => [run.id, run.status]),
    );

    // A retired bot does not block a new mark: the thread gets a fresh bot id.
    const remarked = yield* orchestrator.dispatch({
      type: "thread.commander.mark",
      commandId: CommandId.make("remark-commander-parent"),
      threadId: parentThreadId,
    });
    const remarkedParent = yield* projections.getThreadProjection(parentThreadId);
    assert.equal(remarked.storedEvents[0]?.event.type, "bot.created");
    const recreated = remarked.storedEvents[0]?.event;
    assert.isDefined(remarkedParent.bot);
    assert.notEqual(remarkedParent.bot?.id, firstBotId);
    assert.equal(
      recreated?.type === "bot.created" ? recreated.payload.id : undefined,
      remarkedParent.bot?.id,
    );
    const remarkedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
      (thread) => thread.id === parentThreadId,
    );
    assert.equal(remarkedShell?.commander, true);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("fails to mark a missing thread and writes no thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const existingThreadId = ThreadId.make("thread:commander-existing");
    const missingThreadId = ThreadId.make("thread:commander-missing");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-commander-existing"),
      threadId: existingThreadId,
      projectId: ProjectId.make("project:commander-missing"),
      title: "Existing",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const before = yield* projections.getThreadProjection(existingThreadId);
    const beforeShell = yield* orchestrator.getShellSnapshot();
    const failure = yield* orchestrator
      .dispatch({
        type: "thread.commander.mark",
        commandId: CommandId.make("mark-commander-missing"),
        threadId: missingThreadId,
      })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "OrchestratorProjectionError");
    if (failure._tag === "OrchestratorProjectionError") {
      assert.equal(failure.threadId, missingThreadId);
    }
    const after = yield* projections.getThreadProjection(existingThreadId);
    const afterShell = yield* orchestrator.getShellSnapshot();
    const missing = yield* projections.getThreadProjection(missingThreadId).pipe(Effect.flip);
    assert.isNull(before.bot);
    assert.isNull(after.bot);
    assert.equal(
      DateTime.toEpochMillis(after.thread.updatedAt),
      DateTime.toEpochMillis(before.thread.updatedAt),
    );
    assert.deepEqual(
      afterShell.threads.map((thread) => thread.id),
      beforeShell.threads.map((thread) => thread.id),
    );
    assert.notInclude(
      afterShell.threads.map((thread) => thread.id),
      missingThreadId,
    );
    assert.notInclude(
      afterShell.archivedThreads.map((thread) => thread.id),
      missingThreadId,
    );
    assert.equal(missing._tag, "ProjectionStoreThreadNotFoundError");
  }).pipe(Effect.provide(layerTest)),
);
