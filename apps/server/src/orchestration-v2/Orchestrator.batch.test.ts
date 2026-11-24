import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const isDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for batch thread commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-batch" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const makeProject = Effect.fn("test.batch.makeProject")(function* (name: string) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectId = ProjectId.make(name);
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make(`event:${name}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: IsoDateTime.make("2026-11-01T00:00:00.000Z"),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: name,
      workspaceRoot: `/workspace/${name}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: IsoDateTime.make("2026-11-01T00:00:00.000Z"),
      updatedAt: IsoDateTime.make("2026-11-01T00:00:00.000Z"),
    },
  });
  return projectId;
});

const deleteProject = Effect.fn("test.batch.deleteProject")(function* (projectId: ProjectId) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make(`event:${projectId}:deleted`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: IsoDateTime.make("2026-11-02T00:00:00.000Z"),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.deleted",
    payload: { projectId, deletedAt: IsoDateTime.make("2026-11-02T00:00:00.000Z") },
  });
});

const threadInProject = Effect.fn("test.batch.threadInProject")(function* (
  name: string,
  projectId: ProjectId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(name);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${name}`),
    threadId,
    projectId,
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const createThread = Effect.fn("test.batch.createThread")(function* (name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(name);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${name}`),
    threadId,
    projectId: ProjectId.make("project:batch"),
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const queueRun = Effect.fn("test.batch.queueRun")(function* (threadId: ThreadId, name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`queue-${name}`),
    threadId,
    messageId: MessageId.make(`queue-${name}`),
    text: "Still queued",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return (yield* projections.getThreadProjection(threadId)).runs.at(-1)!;
});

it.effect("one batch reports each thread and does not fail the rest", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const live = yield* createThread("batch-live");
    const already = yield* createThread("batch-archived");
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-already"),
      threadId: already,
    });
    const missing = ThreadId.make("batch-missing");
    const first = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId: CommandId.make("batch-archive"),
      operation: "archive",
      threadIds: [live, already, missing, live],
    });
    assert.equal(first.replayed, undefined);
    assert.deepEqual(
      first.batch?.items.map((item) => item.status),
      ["applied", "already_target", "not_found"],
    );
    assert.equal(first.batch?.appliedCount, 1);
    assert.equal(first.batch?.rejectedCount, 0);
    assert.isNotNull((yield* projections.getThread(live)).archivedAt);
    const archivedAt = (yield* projections.getThread(live)).archivedAt;

    const replay = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId: CommandId.make("batch-archive"),
      operation: "archive",
      threadIds: [live, already, missing, live],
    });
    assert.equal(replay.replayed, true);
    // The retry sees the same per-item outcome the first answer reported.
    assert.deepEqual(replay.batch, first.batch);
    assert.deepEqual((yield* projections.getThread(live)).archivedAt, archivedAt);

    const restored = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId: CommandId.make("batch-unarchive"),
      operation: "unarchive",
      threadIds: [live, missing],
    });
    assert.deepEqual(
      restored.batch?.items.map((item) => item.status),
      ["applied", "not_found"],
    );
    assert.isNull((yield* projections.getThread(live)).archivedAt);
    assert.equal(restored.batch?.appliedCount, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("batch archive enqueues one cleanup effect set per archived thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const first = yield* createThread("batch-archive-fx-a");
    const second = yield* createThread("batch-archive-fx-b");
    const commandId = CommandId.make("batch-archive-fx");
    yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId,
      operation: "archive",
      threadIds: [first, second],
    });
    const effects = yield* outbox.listByCommandId(commandId);
    const terminalCleanups = effects.filter((effect) => effect.request.type === "terminal.cleanup");
    assert.deepEqual(
      terminalCleanups.map((effect) => effect.threadId).toSorted(),
      [first, second].toSorted(),
    );
    // Effect ids collide under `ON CONFLICT DO NOTHING`; each row must name its thread.
    assert.equal(new Set(effects.map((effect) => effect.id)).size, effects.length);
    for (const effect of effects) {
      assert.include(effect.id, String(effect.threadId));
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("batch archive refuses a thread with a queued run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const queued = yield* createThread("batch-archive-queued");
    const idle = yield* createThread("batch-archive-idle");
    yield* queueRun(queued, "archive-queued");
    const result = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId: CommandId.make("batch-archive-running"),
      operation: "archive",
      threadIds: [queued, idle],
    });
    assert.deepEqual(
      result.batch?.items.map((item) => item.status),
      ["running", "applied"],
    );
    assert.equal(result.batch?.rejectedCount, 1);
    assert.isNull((yield* projections.getThread(queued)).archivedAt);
    assert.isNotNull((yield* projections.getThread(idle)).archivedAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("batch mark-unread rewinds only threads with a completed run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const unreadable = yield* createThread("batch-unread-empty");
    const read = yield* createThread("batch-unread-ok");
    const run = yield* queueRun(read, "unread-ok");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("unread-ok-interrupt"),
      threadId: read,
      runId: run.id,
    });
    const completedAt = (yield* projections.getThreadProjection(read)).runs.at(-1)?.completedAt;
    assert.ok(completedAt);
    const result = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId: CommandId.make("batch-mark-unread"),
      operation: "mark-unread",
      threadIds: [unreadable, read],
    });
    assert.deepEqual(
      result.batch?.items.map((item) => item.status),
      ["already_target", "applied"],
    );
    assert.ok((yield* projections.getThread(read)).lastVisitedAt! < completedAt);
    assert.isNull((yield* projections.getThread(unreadable)).lastVisitedAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("batch delete refuses a queued run and deletes the idle thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const running = yield* createThread("batch-running");
    const idle = yield* createThread("batch-idle");
    yield* queueRun(running, "batch-running");
    const deleted = yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-idle-first"),
      threadId: idle,
    });
    assert.ok(deleted.sequence > 0);
    const gone = ThreadId.make("batch-gone");
    const result = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId: CommandId.make("batch-delete"),
      operation: "delete",
      threadIds: [running, idle, gone],
    });
    assert.deepEqual(
      result.batch?.items.map((item) => [item.threadId, item.status]),
      [
        [running, "running"],
        [idle, "deleted"],
        [gone, "not_found"],
      ],
    );
    assert.equal(result.batch?.appliedCount, 0);
    assert.equal(result.batch?.rejectedCount, 1);
    assert.isNull((yield* projections.getThread(running)).deletedAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("batch delete plans full cleanup for every thread and side chat", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const parent = yield* createThread("batch-delete-parent");
    const other = yield* createThread("batch-delete-other");
    const sideChat = ThreadId.make("batch-delete-side-chat");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("batch-delete-fork"),
      sourceThreadId: parent,
      targetThreadId: sideChat,
      sideChat: true,
      sourcePoint: { type: "latest_stable" },
      createdBy: "user",
      creationSource: "web",
    });
    const commandId = CommandId.make("batch-delete-plan");
    const result = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId,
      operation: "delete",
      threadIds: [parent, other],
    });
    assert.deepEqual(
      result.batch?.items.map((item) => item.status),
      ["applied", "applied"],
    );
    assert.isNotNull((yield* projections.getThread(parent)).deletedAt);
    assert.isNotNull((yield* projections.getThread(other)).deletedAt);
    // The parent's side chat is deleted with it.
    assert.isNotNull((yield* projections.getThread(sideChat)).deletedAt);

    const effects = yield* outbox.listByCommandId(commandId);
    const kinds = ["terminal.cleanup", "preview.cleanup"] as const;
    for (const threadId of [parent, other, sideChat]) {
      for (const kind of kinds) {
        assert.ok(
          effects.some((effect) => effect.threadId === threadId && effect.request.type === kind),
          `missing ${kind} for ${threadId}`,
        );
      }
    }
    assert.equal(new Set(effects.map((effect) => effect.id)).size, effects.length);
    for (const effect of effects) {
      assert.include(effect.id, String(effect.threadId));
    }
    assert.isFalse(effects.some((effect) => effect.request.type === "scheduled-tasks.cleanup"));
    assert.isFalse(effects.some((effect) => effect.request.type === "attachment.cleanup"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a batch that changes nothing still accepts the command", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = yield* createThread("batch-noop");
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-noop"),
      threadId,
    });
    const result = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId: CommandId.make("batch-noop"),
      operation: "archive",
      threadIds: [threadId],
    });
    assert.equal(result.replayed, undefined);
    assert.deepEqual(
      result.batch?.items.map((item) => item.status),
      ["already_target"],
    );
    const replay = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId: CommandId.make("batch-noop"),
      operation: "archive",
      threadIds: [threadId],
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.batch, result.batch);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("deleting an unused thread commits the soft delete and the purge together", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = yield* createThread("delete-unused");
    const commandId = CommandId.make("delete-unused-once");
    const result = yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId,
      threadId,
      onlyIfUnused: true,
    });
    assert.deepEqual(
      result.storedEvents.map((stored) => stored.event.type),
      ["thread.deleted", "thread.purged"],
    );
    const deletedEvent = result.storedEvents[0]?.event;
    assert.ok(deletedEvent?.type === "thread.deleted");
    assert.deepEqual(deletedEvent.cascadeRootId, threadId);
    assert.isNull(yield* projections.getThreadTrash(threadId));
    const effects = yield* outbox.listByCommandId(commandId);
    assert.deepEqual(
      effects.map((effect) => effect.request.type),
      ["scheduled-tasks.cleanup", "terminal.cleanup", "preview.cleanup", "terminal.cleanup"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a second delete keeps the original deleted timestamp", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* createThread("delete-twice");
    const first = yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-twice-first"),
      threadId,
    });
    const deletedAt = (yield* projections.getThread(threadId)).deletedAt;
    assert.isNotNull(deletedAt);
    const replayed = yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-twice-first"),
      threadId,
    });
    assert.equal(replayed.replayed, true);
    assert.equal(
      DateTime.toEpochMillis((yield* projections.getThread(threadId)).deletedAt!),
      DateTime.toEpochMillis(deletedAt!),
    );
    const again = yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-twice-second"),
      threadId,
    });
    assert.equal(again.sequence > first.sequence, true);
    assert.equal(
      DateTime.toEpochMillis((yield* projections.getThread(threadId)).deletedAt!),
      DateTime.toEpochMillis(deletedAt!),
    );
    const trash = yield* projections.getThreadTrash(threadId);
    assert.deepEqual(trash?.deletedAt, deletedAt);
    assert.deepEqual(trash?.cascadeRootId, threadId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("restores a deleted parent with its side chat and keeps archive state", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = yield* makeProject("restore-project");
    const parent = yield* threadInProject("restore-parent", projectId);
    const sideChat = ThreadId.make("restore-side-chat");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("restore-fork"),
      sourceThreadId: parent,
      targetThreadId: sideChat,
      sideChat: true,
      sourcePoint: { type: "latest_stable" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("restore-archive"),
      threadId: parent,
    });
    const archivedAt = (yield* projections.getThread(parent)).archivedAt;
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("restore-delete"),
      threadId: parent,
    });
    assert.isNotNull(yield* projections.getThreadTrash(parent));
    assert.isNotNull(yield* projections.getThreadTrash(sideChat));

    const restored = yield* orchestrator.dispatch({
      type: "thread.restore",
      commandId: CommandId.make("restore-root"),
      threadId: parent,
    });
    assert.deepEqual(
      restored.storedEvents.map((stored) => stored.event.type),
      ["thread.restored", "thread.restored"],
    );
    assert.deepEqual(
      restored.storedEvents.map((stored) => stored.event.threadId),
      [parent, sideChat],
    );
    assert.isNull((yield* projections.getThread(parent)).deletedAt);
    assert.isNull((yield* projections.getThread(sideChat)).deletedAt);
    assert.deepEqual((yield* projections.getThread(parent)).archivedAt, archivedAt);
    assert.isNull(yield* projections.getThreadTrash(parent));
    assert.isNull(yield* projections.getThreadTrash(sideChat));

    const listed = yield* projections.getRecentlyDeleted();
    assert.isFalse(listed.some((item) => item.threadId === parent));

    // A restored thread is a normal thread again: it shows in the shell and takes new messages.
    assert.isNotNull(yield* projections.getThreadShell(parent));
    assert.isNotNull(yield* projections.getThreadShell(sideChat));
    const run = yield* queueRun(parent, "after-restore");
    assert.notEqual(run.status, "cancelled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("batch restore reports stable rejection codes per root", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = yield* makeProject("batch-restore-project");
    const parent = yield* threadInProject("batch-restore-parent", projectId);
    const sideChat = ThreadId.make("batch-restore-side-chat");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("batch-restore-fork"),
      sourceThreadId: parent,
      targetThreadId: sideChat,
      sideChat: true,
      sourcePoint: { type: "latest_stable" },
      createdBy: "user",
      creationSource: "web",
    });
    const live = yield* threadInProject("batch-restore-live", projectId);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("batch-restore-delete"),
      threadId: parent,
    });

    const failed = yield* orchestrator
      .dispatch({
        type: "thread.restore",
        commandId: CommandId.make("batch-restore-side-request"),
        threadId: sideChat,
      })
      .pipe(Effect.flip);
    assert.ok(isDispatchError(failed));
    assert.equal(failed.code, "cascade-member");

    const result = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId: CommandId.make("batch-restore-op"),
      operation: "restore",
      threadIds: [live, sideChat, parent],
    });
    assert.deepEqual(
      result.batch?.items.map((item) => [item.threadId, item.status, item.reason]),
      [
        [live, "rejected", "thread-not-deleted"],
        [sideChat, "rejected", "cascade-member"],
        [parent, "applied", undefined],
      ],
    );
    assert.equal(result.batch?.appliedCount, 1);
    assert.isNull((yield* projections.getThread(sideChat)).deletedAt);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("restore rejects a deleted project and purge still succeeds", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const projectId = yield* makeProject("purged-project");
    const threadId = yield* threadInProject("purged-thread", projectId);
    yield* deleteProject(projectId);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("purged-delete"),
      threadId,
    });

    const failed = yield* orchestrator
      .dispatch({
        type: "thread.restore",
        commandId: CommandId.make("purged-restore"),
        threadId,
      })
      .pipe(Effect.flip);
    assert.ok(isDispatchError(failed));
    assert.equal(failed.code, "project-deleted");

    const commandId = CommandId.make("purged-final");
    const purged = yield* orchestrator.dispatch({
      type: "thread.purge",
      commandId,
      threadId,
    });
    assert.deepEqual(
      purged.storedEvents.map((stored) => stored.event.type),
      ["thread.purged"],
    );
    const effects = yield* outbox.listByCommandId(commandId);
    assert.deepEqual(
      effects.map((effect) => effect.request.type),
      ["scheduled-tasks.cleanup", "terminal.cleanup"],
    );
    assert.isNull(yield* projections.getThreadTrash(threadId));
    assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);

    const afterPurge = yield* orchestrator
      .dispatch({
        type: "thread.purge",
        commandId: CommandId.make("purged-again"),
        threadId,
      })
      .pipe(Effect.flip);
    assert.ok(isDispatchError(afterPurge));
    assert.equal(afterPurge.code, "thread-not-recoverable");

    // A repeated delete of the tombstone must not put it back in the trash.
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("purged-delete-again"),
      threadId,
    });
    assert.isNull(yield* projections.getThreadTrash(threadId));
    const restoreTombstone = yield* orchestrator
      .dispatch({
        type: "thread.restore",
        commandId: CommandId.make("purged-restore-again"),
        threadId,
      })
      .pipe(Effect.flip);
    assert.ok(isDispatchError(restoreTombstone));
    assert.equal(restoreTombstone.code, "thread-not-recoverable");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("batch purge cascades across the whole group and rejects tombstones", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const projectId = yield* makeProject("batch-purge-project");
    const parent = yield* threadInProject("batch-purge-parent", projectId);
    const sideChat = ThreadId.make("batch-purge-side-chat");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("batch-purge-fork"),
      sourceThreadId: parent,
      targetThreadId: sideChat,
      sideChat: true,
      sourcePoint: { type: "latest_stable" },
      createdBy: "user",
      creationSource: "web",
    });
    const missing = yield* threadInProject("batch-purge-live", projectId);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("batch-purge-delete"),
      threadId: parent,
    });

    const commandId = CommandId.make("batch-purge-op");
    const result = yield* orchestrator.dispatch({
      type: "thread.batch",
      commandId,
      operation: "purge",
      threadIds: [sideChat, parent, missing],
    });
    assert.deepEqual(
      result.batch?.items.map((item) => [item.threadId, item.status, item.reason]),
      [
        [sideChat, "rejected", "cascade-member"],
        [parent, "applied", undefined],
        [missing, "rejected", "thread-not-deleted"],
      ],
    );
    assert.deepEqual(
      result.storedEvents.map((stored) => stored.event.type),
      ["thread.purged", "thread.purged"],
    );
    assert.deepEqual(
      result.storedEvents.map((stored) => stored.event.threadId),
      [parent, sideChat],
    );
    const effects = yield* outbox.listByCommandId(commandId);
    assert.deepEqual(
      effects.map((effect) => [effect.threadId, effect.request.type]).toSorted(),
      [
        [parent, "scheduled-tasks.cleanup"],
        [parent, "terminal.cleanup"],
        [sideChat, "scheduled-tasks.cleanup"],
        [sideChat, "terminal.cleanup"],
      ].toSorted(),
    );
    assert.isNull(yield* projections.getThreadTrash(parent));
    assert.isNull(yield* projections.getThreadTrash(sideChat));
  }).pipe(Effect.provide(layerTest)),
);
