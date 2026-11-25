import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  IsoDateTime,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodePath from "node:path";
import { createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadTrashPurgeWorker from "./ThreadTrashPurgeWorker.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for trash purge tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerConfigDefault = Layer.effect(
  ServerConfig.ServerConfig,
  ProviderReplayHarness.makeReplayServerConfig("thread-trash-purge").pipe(Effect.orDie),
).pipe(Layer.provide(NodeServices.layer));

const layerCleanupFor = (layerConfig: Layer.Layer<ServerConfig.ServerConfig>) =>
  ResourceCleanupService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        layerConfig,
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          deleteForThread: () => Effect.void,
        }),
      ),
    ),
  );
const layerTest = (input: {
  readonly name: string;
  readonly queries: Ref.Ref<number>;
  readonly layerConfig?: Layer.Layer<ServerConfig.ServerConfig>;
  readonly databaseLayer?: Layer.Layer<SqlClient.SqlClient>;
  readonly failGetThreadRecordsFor?: Ref.Ref<ThreadId | null>;
  readonly purgeCommands?: Queue.Queue<CommandId>;
}) => {
  const layerConfig = input.layerConfig ?? layerConfigDefault;
  const layerDatabase = input.databaseLayer ?? SqlitePersistence.layerMemory;
  const layerCountingProjections = Layer.effect(
    ProjectionStore.ProjectionStoreV2,
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      return {
        ...store,
        listThreadTrashRootsByDueAt: (args: { limit: number }) =>
          Ref.update(input.queries, (count) => count + 1).pipe(
            Effect.andThen(store.listThreadTrashRootsByDueAt(args)),
          ),
      };
    }),
  ).pipe(Layer.provide(ProjectionStore.layer), Layer.provide(layerDatabase));
  const failGetThreadRecordsFor = input.failGetThreadRecordsFor;
  const layerHarness = ProviderReplayHarness.layerWithRegistry(
    { name: input.name },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      ...(failGetThreadRecordsFor === undefined
        ? {}
        : {
            wrapProjectionStore: (
              store: ProjectionStore.ProjectionStoreV2Shape,
            ): ProjectionStore.ProjectionStoreV2Shape => ({
              ...store,
              getThreadRecords: (threadId, fields, filter) =>
                Ref.get(failGetThreadRecordsFor).pipe(
                  Effect.flatMap((failing) =>
                    failing === threadId
                      ? Ref.set(failGetThreadRecordsFor, null).pipe(
                          Effect.andThen(
                            Effect.fail(
                              new ProjectionStore.ProjectionStoreReadError({
                                threadId,
                                cause: new Error("injected projection read failure"),
                              }),
                            ),
                          ),
                        )
                      : store.getThreadRecords(threadId, fields, filter),
                  ),
                ),
            }),
          }),
    },
  );
  const layerOrchestratorRecorded =
    input.purgeCommands === undefined
      ? Layer.empty
      : Layer.effect(
          Orchestrator.OrchestratorV2,
          Effect.gen(function* () {
            const base = yield* Orchestrator.OrchestratorV2;
            const queue = input.purgeCommands;
            return {
              ...base,
              dispatch: (command: OrchestrationV2ServerCommand) =>
                (command.type === "thread.purge" && queue !== undefined
                  ? Queue.offer(queue, command.commandId)
                  : Effect.void
                ).pipe(Effect.andThen(base.dispatch(command))),
            };
          }),
        ).pipe(Layer.provide(layerHarness));
  return Layer.mergeAll(
    layerDatabase,
    layerConfig,
    Layer.mergeAll(
      EventStore.layer,
      ProjectionStore.layer,
      ProjectStore.layer,
      CommandReceiptStore.layer,
    ).pipe(Layer.provide(layerDatabase)),
    Scheduler.layer,
    Layer.merge(layerHarness, layerOrchestratorRecorded),
    ThreadTrashPurgeWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerCountingProjections,
          Layer.merge(layerHarness, layerOrchestratorRecorded),
          Scheduler.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
    NodeServices.layer,
  ).pipe(Layer.provideMerge(layerCleanupFor(layerConfig)));
};

const makeProject = Effect.fn("test.trashPurge.makeProject")(function* (name: string) {
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

const createThread = (name: string, projectId = ProjectId.make("project:trash-purge")) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) => {
    const threadId = ThreadId.make(`thread:${name}`);
    return orchestrator
      .dispatch({
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
      })
      .pipe(Effect.as(threadId));
  });

const deleteThread = (threadId: ThreadId, key: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make(`delete-${key}`),
      threadId,
    }),
  );

const attachmentIdFor = (threadId: ThreadId) =>
  `${createDeterministicAttachmentId(threadId, "stable")}-png`;

const attachmentPathFor = (attachmentsDir: string, attachmentId: string) =>
  NodePath.join(attachmentsDir, `${attachmentId}.png`);

const seedAttachment = Effect.fn("test.trashPurge.seedAttachment")(function* (
  threadId: ThreadId,
  messageId: string,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const attachmentId = attachmentIdFor(threadId);
  const path = attachmentPathFor(config.attachmentsDir, attachmentId);
  yield* fileSystem.writeFile(path, new Uint8Array([1, 2, 3]));
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages (
      message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at,
      search_text, payload_json
    ) VALUES (
      ${messageId}, ${threadId}, NULL, NULL, 'user', 0,
      '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'attachment',
      ${JSON.stringify({ id: messageId, attachments: [{ id: attachmentId }] })}
    )
  `;
  return { attachmentId, path };
});

const watchPurged = Effect.fn("test.trashPurge.watchPurged")(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  yield* Stream.runForEach(sink.stream({ eventType: "thread.purged" }), (stored) =>
    Queue.offer(events, stored),
  ).pipe(Effect.forkScoped);
  return events;
});

const takePurged = (events: Queue.Queue<OrchestrationV2StoredEvent>, count: number) =>
  Stream.fromQueue(events).pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

const countTrashRows = (threadIds: ReadonlyArray<ThreadId>) =>
  ProjectionStore.ProjectionStoreV2.use((projections) =>
    Effect.forEach(threadIds, projections.getThreadTrash).pipe(
      Effect.map((trash) => trash.filter((row) => row !== null).length),
    ),
  );
const countPurgedEvents = (threadIds: ReadonlyArray<ThreadId>) =>
  EventStore.EventStoreV2.use((store) =>
    Effect.forEach(threadIds, (threadId) =>
      store.read({ threadId, eventType: "thread.purged" }).pipe(Stream.runCount),
    ).pipe(Effect.map((counts) => counts.reduce((total, count) => total + count, 0))),
  );

const receiptsFor = (commandIds: Iterable<CommandId>) =>
  CommandReceiptStore.CommandReceiptStoreV2.use((receipts) =>
    Effect.forEach([...commandIds], receipts.getByCommandId).pipe(
      Effect.map((options) => options.filter(Option.isSome).map((option) => option.value)),
    ),
  );

const RETENTION = "7 days";

it.effect("purges a trashed thread once it passes the retention window", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00.000Z"));
    const queries = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const threadId = yield* createThread("due-once");
      const { attachmentId, path } = yield* seedAttachment(threadId, "message:due-once");
      assert.isTrue((yield* projections.getThreadAttachmentIds(threadId)).includes(attachmentId));
      yield* deleteThread(threadId, "due-once");
      const trash = yield* projections.getThreadTrash(threadId);
      assert.isNotNull(trash);
      assert.equal(
        trash!.purgeDueAt - DateTime.toEpochMillis(trash!.deletedAt),
        7 * 24 * 60 * 60 * 1000,
      );
      const events = yield* watchPurged();
      yield* TestClock.adjust(RETENTION);
      yield* TestClock.adjust("5 seconds");
      const purged = yield* takePurged(events, 1);
      yield* worker.drain();

      assert.lengthOf(purged, 1);
      assert.equal(purged[0]?.event.threadId, threadId);
      assert.isNull(yield* projections.getThreadTrash(threadId));
      assert.isFalse(yield* fileSystem.exists(path));
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const effects = yield* outbox.listByCommandId(purged[0]!.commandId!);
      assert.lengthOf(
        effects.filter((effect) => effect.request.type === "attachment.cleanup"),
        1,
      );
      assert.isTrue(effects.every((effect) => effect.status === "succeeded"));
    }).pipe(Effect.provide(layerTest({ name: "due-once", queries })));
  }),
);

it.effect("does not purge before the retention window", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00.000Z"));
    const queries = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* createThread("not-yet-due");
      yield* deleteThread(threadId, "not-yet-due");
      assert.isNotNull(yield* projections.getThreadTrash(threadId));
      yield* TestClock.adjust("6 days");
      yield* TestClock.adjust("23 hours");
      yield* TestClock.adjust("30 seconds");
      assert.isNotNull(yield* projections.getThreadTrash(threadId));
      assert.equal(yield* countPurgedEvents([threadId]), 0);
    }).pipe(Effect.provide(layerTest({ name: "not-yet-due", queries })));
  }),
);

it.effect("retries a purge that failed during planning on the next tick", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00.000Z"));
    const queries = yield* Ref.make(0);
    const failGetThreadRecordsFor = yield* Ref.make<ThreadId | null>(null);
    const purgeCommands = yield* Queue.unbounded<CommandId>();
    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* createThread("retry-purge");
      yield* deleteThread(threadId, "retry-purge");
      yield* Ref.set(failGetThreadRecordsFor, threadId);

      const events = yield* watchPurged();
      yield* TestClock.adjust(RETENTION);
      yield* TestClock.adjust("15 seconds");
      yield* takePurged(events, 1);

      const attempts = Array.from(yield* Queue.takeAll(purgeCommands)).filter((id) =>
        id.includes(`${threadId}:`),
      );
      assert.lengthOf(attempts, 2);
      assert.notEqual(attempts[0], attempts[1]);
      const receipts = yield* receiptsFor(attempts);
      assert.deepEqual(
        receipts.map((receipt) => receipt.status),
        ["rejected", "accepted"],
      );
      assert.equal(yield* countPurgedEvents([threadId]), 1);
      assert.isNull(yield* projections.getThreadTrash(threadId));
    }).pipe(
      Effect.provide(
        layerTest({ name: "retry-purge", queries, failGetThreadRecordsFor, purgeCommands }),
      ),
    );
  }),
);

it.effect("splits an overdue backlog across ticks and a failure does not block the rest", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00.000Z"));
    const queries = yield* Ref.make(0);
    const failGetThreadRecordsFor = yield* Ref.make<ThreadId | null>(null);
    const purgeCommands = yield* Queue.unbounded<CommandId>();
    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const total = ThreadTrashPurgeWorker.THREAD_TRASH_PURGE_BATCH_LIMIT + 2;
      const ids: Array<ThreadId> = [];
      for (let index = 0; index < total; index += 1) {
        ids.push(yield* createThread(`backlog-${index}`));
      }
      for (const [index, threadId] of ids.entries()) {
        yield* deleteThread(threadId, `backlog-${index}`);
      }
      const failing = ids[1]!;
      yield* Ref.set(failGetThreadRecordsFor, failing);

      const events = yield* watchPurged();
      yield* TestClock.adjust(RETENTION);
      // First tick purges the batch of 25 minus the injected failure; three
      // roots stay trashed until the next tick.
      yield* takePurged(events, total - 3);
      assert.equal(yield* countTrashRows(ids), 3);
      assert.isNotNull(yield* projections.getThreadTrash(failing));

      yield* TestClock.adjust("5 seconds");
      yield* takePurged(events, 3);
      assert.equal(yield* countTrashRows(ids), 0);
      assert.equal(yield* countPurgedEvents(ids), total);
      const failingAttempts = Array.from(yield* Queue.takeAll(purgeCommands)).filter((id) =>
        id.includes(`${failing}:`),
      );
      assert.lengthOf(failingAttempts, 2);
      const receipts = yield* receiptsFor(failingAttempts);
      assert.deepEqual(
        receipts.map((receipt) => receipt.status),
        ["rejected", "accepted"],
      );
    }).pipe(
      Effect.provide(
        layerTest({ name: "backlog", queries, failGetThreadRecordsFor, purgeCommands }),
      ),
    );
  }),
);

it.effect("resumes committed cleanup effects after a restart without a second event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00.000Z"));
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "trash-purge-resume-",
      });
      // One SqlClient for the whole test; only the orchestration stack is rebuilt per scope.
      const layerDb = Layer.succeedContext(
        yield* Layer.build(
          SqlitePersistence.layerFromPath(NodePath.join(directory, "statev2.sqlite")),
        ),
      );
      const config = yield* ProviderReplayHarness.makeReplayServerConfig("resume-purge").pipe(
        Effect.orDie,
      );
      const layerConfig = Layer.succeed(ServerConfig.ServerConfig, config);
      const queries = yield* Ref.make(0);
      const layer = layerTest({
        name: "resume-purge",
        queries,
        layerConfig,
        databaseLayer: layerDb,
      });
      const threadId = ThreadId.make("thread:resume-purge");
      const attachmentId = attachmentIdFor(threadId);
      const path = attachmentPathFor(config.attachmentsDir, attachmentId);
      const purgeCommands = yield* Queue.unbounded<CommandId>();
      const layerWithCommands = layerTest({
        name: "resume-purge",
        queries,
        layerConfig,
        databaseLayer: layerDb,
        purgeCommands,
      });

      const firstPurge = yield* Effect.scoped(
        Effect.gen(function* () {
          const thread = yield* createThread("resume-purge");
          yield* seedAttachment(thread, "message:resume-purge");
          yield* deleteThread(thread, "resume-purge");
          const events = yield* watchPurged();
          yield* TestClock.adjust(RETENTION);
          yield* TestClock.adjust("5 seconds");
          const purged = yield* takePurged(events, 1);
          // The purge committed; this scope never drained the outbox, standing in for a crash.
          assert.lengthOf(purged, 1);
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const effects = yield* outbox.listByCommandId(purged[0]!.commandId!);
          assert.isTrue(
            effects.some((effect) => effect.status === "pending" || effect.status === "running"),
          );
          return purged[0]!;
        }).pipe(Effect.provide(layerWithCommands)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* worker.drain();
          assert.isFalse(yield* fileSystem.exists(path));
          // Restart did not replay the committed purge as a second event.
          assert.equal(yield* countPurgedEvents([threadId]), 1);
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const effects = yield* outbox.listByCommandId(firstPurge.commandId!);
          assert.isTrue(effects.every((effect) => effect.status === "succeeded"));
        }).pipe(Effect.provide(layer)),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("purges immediately at startup when the retention window passed while down", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00.000Z"));
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "trash-purge-startup-",
      });
      // One SqlClient for the whole test; only the orchestration stack is rebuilt per scope.
      const layerDb = Layer.succeedContext(
        yield* Layer.build(
          SqlitePersistence.layerFromPath(NodePath.join(directory, "statev2.sqlite")),
        ),
      );
      const layerSeed = ProviderReplayHarness.layerWithRegistry(
        { name: "overdue-seed" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDb, runEffectWorker: false },
      );
      const queries = yield* Ref.make(0);
      const layerPurge = layerTest({
        name: "overdue-purge",
        queries,
        databaseLayer: layerDb,
      });
      const threadId = ThreadId.make("thread:overdue-start");

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* createThread("overdue-start");
          yield* deleteThread(threadId, "overdue-start");
        }).pipe(Effect.provide(layerSeed)),
      );

      yield* TestClock.adjust("30 days");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const events = yield* watchPurged();
          yield* TestClock.adjust("5 seconds");
          yield* takePurged(events, 1);
          assert.isNull(yield* projections.getThreadTrash(threadId));
          assert.equal(yield* countPurgedEvents([threadId]), 1);
        }).pipe(Effect.provide(layerPurge)),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("skips a thread restored before its window and uses the new deletion time", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00.000Z"));
    const queries = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = yield* makeProject("restore-cycle");
      const threadId = yield* createThread("restore-cycle", projectId);
      yield* deleteThread(threadId, "restore-cycle-first");
      yield* orchestrator.dispatch({
        type: "thread.restore",
        commandId: CommandId.make("restore-cycle"),
        threadId,
      });
      assert.isNull(yield* projections.getThreadTrash(threadId));

      yield* TestClock.adjust("30 days");
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* countPurgedEvents([threadId]), 0);

      yield* deleteThread(threadId, "restore-cycle-second");
      const events = yield* watchPurged();
      yield* TestClock.adjust(RETENTION);
      yield* TestClock.adjust("5 seconds");
      yield* takePurged(events, 1);
      assert.equal(yield* countPurgedEvents([threadId]), 1);
    }).pipe(Effect.provide(layerTest({ name: "restore-cycle", queries })));
  }),
);

it.effect("purges a cascade group with its root and a lone side-chat row on its own time", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T00:00:00.000Z"));
    const queries = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* createThread("cascade-parent");
      const otherParent = yield* createThread("cascade-other-parent");
      const sideChat = ThreadId.make("thread:cascade-side");
      const lone = ThreadId.make("thread:cascade-lone");
      for (const [key, source, target] of [
        ["side", parent, sideChat],
        ["lone", otherParent, lone],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`cascade-fork-${key}`),
          sourceThreadId: source,
          targetThreadId: target,
          sideChat: true,
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      // The lone side chat is its own trash root; its parent stays live.
      yield* deleteThread(lone, "cascade-lone");
      assert.isNotNull(yield* projections.getThreadTrash(lone));
      assert.equal((yield* projections.getThreadTrash(lone))?.cascadeRootId, lone);
      assert.isNull(yield* projections.getThreadTrash(parent));
      yield* TestClock.adjust("1 day");
      yield* deleteThread(parent, "cascade-parent");
      assert.isNotNull(yield* projections.getThreadTrash(parent));
      assert.isNotNull(yield* projections.getThreadTrash(sideChat));

      const events = yield* watchPurged();
      yield* TestClock.adjust("6 days");
      yield* TestClock.adjust("10 seconds");
      yield* takePurged(events, 1);
      assert.isNull(yield* projections.getThreadTrash(lone));
      assert.isNotNull(yield* projections.getThreadTrash(parent));
      assert.isNotNull(yield* projections.getThreadTrash(sideChat));

      yield* TestClock.adjust("1 day");
      yield* TestClock.adjust("5 seconds");
      yield* takePurged(events, 2);
      assert.isNull(yield* projections.getThreadTrash(parent));
      assert.isNull(yield* projections.getThreadTrash(sideChat));
      assert.equal(yield* countPurgedEvents([parent, sideChat, lone]), 3);
    }).pipe(Effect.provide(layerTest({ name: "cascade", queries })));
  }),
);
