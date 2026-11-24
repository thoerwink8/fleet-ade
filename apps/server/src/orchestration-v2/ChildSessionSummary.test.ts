import { assert, it } from "@effect/vitest";
import {
  CHILD_SUMMARY_PAGE_SIZE,
  ChildSummaryCursorError,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type ChildSummaryStreamEvent,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as FleetSummary from "../ledger/FleetSummary.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ChildSessionSummary, ChildSessionSummaryInternal } from "./ChildSessionSummary.ts";
import * as CommandAssist from "./CommandAssist.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type { SummaryFacts } from "./childSummaryDerive.ts";

const layerTest = ChildSessionSummary.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
const isChildSummaryCursorError = Schema.is(ChildSummaryCursorError);

const factsFor = (
  threadId: ThreadId,
  parentThreadId: ThreadId,
  createdAtMs: number,
): SummaryFacts => ({
  threadId,
  parentThreadId,
  createdAtMs,
  activityAtMs: createdAtMs,
  status: "running",
  approvalCommand: null,
  waitingForAnswer: false,
  items: [],
  goal: `goal ${threadId}`,
  taskText: null,
  branch: null,
  pr: null,
  grandchildCount: 0,
});

const storedEvent = (
  type:
    | "thread.deleted"
    | "thread.restored"
    | "thread.purged"
    | "thread.metadata-updated"
    | "run.updated",
  threadId: ThreadId,
  sequence: number,
): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    id: EventId.make(`event:${String(sequence)}`),
    threadId,
    type,
    occurredAt: DateTime.makeUnsafe(0),
    payload: null,
  } as unknown as OrchestrationV2StoredEvent["event"],
});

const timedOutSubagentEvent = (
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  sequence: number,
): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    id: EventId.make(`event:${String(sequence)}`),
    threadId: parentThreadId,
    type: "subagent.updated",
    occurredAt: DateTime.makeUnsafe(0),
    payload: {
      childThreadId,
      origin: "app_owned",
      timedOutAt: "2026-01-01T00:01:00.000Z",
    },
  } as unknown as OrchestrationV2StoredEvent["event"],
});

const seedProjectionThread = (threadId: ThreadId, parentThreadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const shell = liveThreadShell(threadId);
    const payload = {
      ...shell,
      creationSource: "web",
      lineage: {
        rootThreadId: parentThreadId,
        parentThreadId,
        relationshipToParent: "subagent" as const,
      },
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${threadId}, ${ProjectId.make("project:mcp-test")}, ${threadId}, 'codex',
        'full-access', 'default', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', ${JSON.stringify(payload)}
      )
    `;
  });

const workerLayer = (
  events: Queue.Queue<OrchestrationV2StoredEvent>,
  getThreadShell: ProjectionStore.ProjectionStoreV2Shape["getThreadShell"],
  setup: Effect.Effect<void, never, SqlClient.SqlClient>,
  ready: Deferred.Deferred<void>,
) => {
  const database = SqlitePersistence.layerMemory;
  const setupLayer = Layer.effectDiscard(setup).pipe(Layer.provide(database));
  const dependencies = Layer.mergeAll(
    Layer.mock(EventSinkV2, {
      latestSequence: () => Effect.succeed(0),
      stream: () =>
        Stream.unwrap(Deferred.succeed(ready, undefined).pipe(Effect.as(Stream.fromQueue(events)))),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2, { getThreadShell }),
  );
  return Layer.mergeAll(ChildSessionSummary.layer, ChildSessionSummary.layerWorker).pipe(
    Layer.provide(dependencies),
    Layer.provide(Layer.merge(database, setupLayer)),
  );
};

it.layer(layerTest)("child session summaries", (it) => {
  it.effect("pages children by creation order without duplicates", () =>
    Effect.gen(function* () {
      const internal = yield* ChildSessionSummaryInternal;
      const service = yield* ChildSessionSummary;
      const parent = ThreadId.make("thread:parent");
      for (let index = 0; index < CHILD_SUMMARY_PAGE_SIZE + 25; index += 1) {
        yield* internal.note(
          factsFor(ThreadId.make(`thread:${String(index).padStart(3, "0")}`), parent, index * 1000),
        );
      }
      const first = yield* service.list({ threadId: parent });
      assert.strictEqual(first.children.length, CHILD_SUMMARY_PAGE_SIZE);
      assert.ok(first.nextCursor !== null);
      const second = yield* service.list({ threadId: parent, cursor: first.nextCursor });
      assert.strictEqual(second.children.length, 25);
      assert.strictEqual(second.nextCursor, null);
      const ids = [...first.children, ...second.children].map((row) => row.threadId);
      assert.strictEqual(new Set(ids).size, ids.length);
      const ordered = [
        ...first.children.map((row) => row.createdAtMs),
        ...second.children.map((row) => row.createdAtMs),
      ];
      assert.deepStrictEqual(
        ordered,
        [...ordered].sort((left, right) => left - right),
      );
      const invalid = yield* service.list({ threadId: parent, cursor: "nope" }).pipe(Effect.flip);
      assert.ok(isChildSummaryCursorError(invalid));
    }),
  );

  it.effect("marks a quiet running child as stuck and bumps the revision", () =>
    Effect.gen(function* () {
      const internal = yield* ChildSessionSummaryInternal;
      const service = yield* ChildSessionSummary;
      const parent = ThreadId.make("thread:idle-parent");
      const child = ThreadId.make("thread:idle-child");
      yield* internal.note(factsFor(child, parent, 0));
      yield* TestClock.adjust("4 minutes");
      yield* internal.markIdle();
      const detail = yield* service.detail({ threadId: child });
      assert.ok(detail !== null);
      assert.strictEqual(detail.phase, "卡住");
      assert.strictEqual(detail.reason, "没动静");
      assert.strictEqual(detail.revision, 2);
    }),
  );

  it.effect("replays the snapshot then pushes a delete", () =>
    Effect.gen(function* () {
      const internal = yield* ChildSessionSummaryInternal;
      const service = yield* ChildSessionSummary;
      const parent = ThreadId.make("thread:sub-parent");
      const child = ThreadId.make("thread:sub-child");
      yield* internal.note(factsFor(child, parent, 0));
      const queue = yield* Queue.unbounded<ChildSummaryStreamEvent>();
      yield* service.subscribe(parent).pipe(
        Stream.runForEach((event) => Queue.offer(queue, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const first = yield* Queue.take(queue);
      assert.ok(first._tag === "upsert");
      if (first._tag === "upsert") {
        assert.strictEqual(first.row.threadId, child);
      }
      yield* internal.recompute(child, null);
      const second = yield* Queue.take(queue);
      assert.ok(second._tag === "deleted");
      if (second._tag === "deleted") {
        assert.strictEqual(second.threadId, child);
        assert.strictEqual(second.parentThreadId, parent);
      }
    }),
  );
});

it.effect.each([
  { scenario: "deleted", name: "worker publishes deletion and removes the row" },
  { scenario: "read-failure", name: "worker preserves the row after shell read failure" },
] as const)("$name", ({ scenario }) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const ready = yield* Deferred.make<void>();
    const processed = yield* Deferred.make<void>();
    const parent = ThreadId.make("thread:worker-parent");
    const child = ThreadId.make("thread:worker-child");
    const marker = ThreadId.make("thread:marker");
    const shell = {
      ...liveThreadShell(child),
      lineage: {
        parentThreadId: parent,
        rootThreadId: parent,
        relationshipToParent: "subagent" as const,
      },
    };
    const getThreadShell: ProjectionStore.ProjectionStoreV2Shape["getThreadShell"] = (id) => {
      if (id === marker) return Deferred.succeed(processed, undefined).pipe(Effect.as(null));
      return Deferred.isDone(ready).pipe(
        Effect.flatMap((started) =>
          started && scenario === "read-failure"
            ? Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId: child }))
            : Effect.succeed(shell),
        ),
      );
    };
    yield* Effect.gen(function* () {
      yield* Deferred.await(ready);
      const internal = yield* ChildSessionSummaryInternal;
      const service = yield* ChildSessionSummary;
      yield* internal.note(factsFor(child, parent, 0));
      const updates = yield* Queue.unbounded<ChildSummaryStreamEvent>();
      yield* service.subscribe(parent).pipe(
        Stream.runForEach((event) => Queue.offer(updates, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      assert.strictEqual((yield* Queue.take(updates))._tag, "upsert");
      yield* Queue.offer(
        events,
        storedEvent(
          scenario === "deleted" ? "thread.deleted" : "thread.metadata-updated",
          child,
          1,
        ),
      );
      yield* Queue.offer(events, storedEvent("thread.metadata-updated", marker, 2));
      yield* Deferred.await(processed);
      const detail = yield* service.detail({ threadId: child });
      if (scenario === "deleted") {
        assert.strictEqual(detail, null);
        const deleted = yield* Queue.take(updates);
        assert.strictEqual(deleted._tag, "deleted");
        if (deleted._tag === "deleted") assert.strictEqual(deleted.threadId, child);
      } else {
        assert.ok(detail !== null);
        assert.strictEqual(detail.threadId, child);
        assert.ok(Option.isNone(yield* Queue.poll(updates)));
      }
    }).pipe(
      Effect.provide(
        workerLayer(
          events,
          getThreadShell,
          seedProjectionThread(child, parent).pipe(Effect.orDie),
          ready,
        ),
      ),
    );
  }),
);

it.effect("rebuilds a soft-deleted child summary on restore and drops it on purge", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const ready = yield* Deferred.make<void>();
    const processed = yield* Ref.make(0);
    const parent = ThreadId.make("thread:lifecycle-parent");
    const child = ThreadId.make("thread:lifecycle-child");
    const marker = ThreadId.make("thread:lifecycle-marker");
    const shell = {
      ...liveThreadShell(child),
      lineage: {
        parentThreadId: parent,
        rootThreadId: parent,
        relationshipToParent: "subagent" as const,
      },
    };
    const getThreadShell: ProjectionStore.ProjectionStoreV2Shape["getThreadShell"] = (id) =>
      id === marker
        ? Ref.updateAndGet(processed, (count) => count + 1).pipe(Effect.as(null))
        : Effect.succeed(shell);
    yield* Effect.gen(function* () {
      yield* Deferred.await(ready);
      const internal = yield* ChildSessionSummaryInternal;
      const service = yield* ChildSessionSummary;
      yield* internal.note(factsFor(child, parent, 0));
      yield* Queue.offer(events, storedEvent("thread.deleted", child, 1));
      yield* Queue.offer(events, storedEvent("thread.metadata-updated", marker, 2));
      yield* Ref.get(processed).pipe(Effect.repeat({ until: (count) => count === 1 }));
      assert.strictEqual(yield* service.detail({ threadId: child }), null);

      yield* Queue.offer(events, storedEvent("thread.restored", child, 3));
      yield* Queue.offer(events, storedEvent("thread.metadata-updated", marker, 4));
      yield* Ref.get(processed).pipe(Effect.repeat({ until: (count) => count === 2 }));
      assert.strictEqual((yield* service.detail({ threadId: child }))?.threadId, child);

      yield* Queue.offer(events, storedEvent("thread.purged", child, 5));
      yield* Queue.offer(events, storedEvent("thread.metadata-updated", marker, 6));
      yield* Ref.get(processed).pipe(Effect.repeat({ until: (count) => count === 3 }));
      assert.strictEqual(yield* service.detail({ threadId: child }), null);
    }).pipe(
      Effect.provide(
        workerLayer(
          events,
          getThreadShell,
          seedProjectionThread(child, parent).pipe(Effect.orDie),
          ready,
        ),
      ),
    );
  }),
);

it.effect("recomputes the child row when its parent delegation times out", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const ready = yield* Deferred.make<void>();
    const processed = yield* Deferred.make<void>();
    const parent = ThreadId.make("thread:timeout-parent");
    const child = ThreadId.make("thread:timeout-child");
    const marker = ThreadId.make("thread:timeout-marker");
    const childShell = {
      ...liveThreadShell(child),
      lineage: {
        parentThreadId: parent,
        rootThreadId: parent,
        relationshipToParent: "subagent" as const,
      },
    };
    const parentShell = {
      ...liveThreadShell(parent),
      lineage: { parentThreadId: null, rootThreadId: parent, relationshipToParent: null },
    };
    const getThreadShell: ProjectionStore.ProjectionStoreV2Shape["getThreadShell"] = (id) =>
      id === marker
        ? Deferred.succeed(processed, undefined).pipe(Effect.as(null))
        : Deferred.isDone(ready).pipe(Effect.map(() => (id === child ? childShell : parentShell)));
    yield* Effect.gen(function* () {
      yield* Deferred.await(ready);
      const internal = yield* ChildSessionSummaryInternal;
      const service = yield* ChildSessionSummary;
      yield* internal.note(factsFor(child, parent, 0));
      yield* Queue.offer(events, timedOutSubagentEvent(parent, child, 1));
      yield* Queue.offer(events, storedEvent("thread.metadata-updated", marker, 2));
      yield* Deferred.await(processed);
      const detail = yield* service.detail({ threadId: child });
      assert.ok(detail !== null);
      assert.strictEqual(detail.phase, "卡住");
      assert.strictEqual(detail.reason, "超时");
      assert.strictEqual(detail.activity, "超时");
    }).pipe(
      Effect.provide(
        workerLayer(
          events,
          getThreadShell,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* seedProjectionThread(child, parent);
            yield* sql`
              INSERT INTO orchestration_v2_projection_subagents
                (subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json)
              VALUES ('timeout-task', ${parent}, 'timeout-node', 'codex', ${child}, 'app_owned', 'running', '2026-01-01T00:00:00.000Z', ${JSON.stringify({ childThreadId: child, timedOutAt: "2026-01-01T00:01:00.000Z" })})
            `;
          }).pipe(Effect.orDie),
          ready,
        ),
      ),
    );
  }),
);

it.effect("worker keeps completion newer than a blocked startup scan", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const ready = yield* Deferred.make<void>();
    const scanStarted = yield* Deferred.make<void>();
    const releaseScan = yield* Deferred.make<void>();
    const processed = yield* Deferred.make<void>();
    const reads = yield* Ref.make(0);
    const parent = ThreadId.make("thread:race-parent");
    const child = ThreadId.make("thread:race-child");
    const marker = ThreadId.make("thread:race-marker");
    const running = {
      ...liveThreadShell(child),
      lineage: {
        parentThreadId: parent,
        rootThreadId: parent,
        relationshipToParent: "subagent" as const,
      },
    };
    const getThreadShell: ProjectionStore.ProjectionStoreV2Shape["getThreadShell"] = (id) =>
      Effect.gen(function* () {
        if (id === marker) {
          yield* Deferred.succeed(processed, undefined);
          return null;
        }
        const read = yield* Ref.getAndUpdate(reads, (count) => count + 1);
        if (read === 0) {
          yield* Deferred.succeed(scanStarted, undefined);
          yield* Deferred.await(releaseScan);
          return running;
        }
        return {
          ...running,
          status: "completed" as const,
          latestRunCompletedAt: DateTime.makeUnsafe(1),
        };
      });
    yield* Effect.gen(function* () {
      yield* Deferred.await(scanStarted);
      yield* Queue.offer(events, storedEvent("run.updated", child, 1));
      // Let runnable event work settle while the scan still holds its stale shell.
      yield* TestClock.adjust(0);
      yield* Deferred.succeed(releaseScan, undefined);
      yield* Queue.offer(events, storedEvent("thread.metadata-updated", marker, 2));
      yield* Deferred.await(processed);
      yield* TestClock.adjust(0);
      const service = yield* ChildSessionSummary;
      const detail = yield* service.detail({ threadId: child });
      assert.ok(detail !== null);
      assert.strictEqual(detail.phase, "做完");
    }).pipe(
      Effect.provide(
        workerLayer(
          events,
          getThreadShell,
          seedProjectionThread(child, parent).pipe(Effect.orDie),
          ready,
        ),
      ),
    );
  }),
);

it.effect("reads outlook from command assist and leaves the child phase alone", () => {
  const database = SqlitePersistence.layerMemory;
  return Effect.gen(function* () {
    const internal = yield* ChildSessionSummaryInternal;
    const summary = yield* ChildSessionSummary;
    const sql = yield* SqlClient.SqlClient;
    const parent = ThreadId.make("thread:outlook-parent");
    const child = ThreadId.make("thread:outlook-child");
    yield* internal.note(factsFor(child, parent, 0));
    const before = yield* summary.detail({ threadId: child });
    assert.ok(before !== null);
    assert.strictEqual(before.outlook, null);
    yield* sql`
      INSERT INTO command_assist_state (thread_id, state_json, updated_at)
      VALUES (
        ${child},
        ${JSON.stringify({ outlook: "会改 parser.ts，加 3 行" })},
        ${"2026-11-23T00:00:00.000Z"}
      )
    `;
    const after = yield* summary.detail({ threadId: child });
    assert.ok(after !== null);
    assert.strictEqual(after.outlook, "会改 parser.ts，加 3 行");
    assert.strictEqual(after.phase, before.phase);
    assert.strictEqual(after.reason, before.reason);
  }).pipe(
    Effect.provide(Layer.merge(ChildSessionSummary.layer.pipe(Layer.provide(database)), database)),
  );
});

const assistProjectId = ProjectId.make("project:mcp-test");

const seedAssistWorkspace = (threadId: ThreadId, parentThreadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedProjectionThread(threadId, parentThreadId);
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (
        ${assistProjectId}, ${"child"}, ${"/work/child-repo"}, ${"[]"},
        ${"2026-01-01T00:00:00.000Z"}, ${"2026-01-01T00:00:00.000Z"}
      )
    `;
  });

const assistStack = <E, R>(
  assist: Layer.Layer<CommandAssist.CommandAssist, E, R>,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
) => {
  const ready = assist.pipe(Layer.provide(database));
  const services = Layer.merge(ready, database);
  return Layer.merge(ChildSessionSummary.layer.pipe(Layer.provide(services)), services);
};

it.effect("marks the child's current drift as a false positive", () => {
  const database = SqlitePersistence.layerMemory;
  const assist = CommandAssist.layer.pipe(
    Layer.provide(
      Layer.succeed(CommandAssist.CommandAssistModel, { complete: () => Effect.succeed("{}") }),
    ),
    Layer.provide(ServerSettingsService.layerTest({})),
    Layer.provide(database),
  );
  return Effect.gen(function* () {
    const internal = yield* ChildSessionSummaryInternal;
    const summary = yield* ChildSessionSummary;
    const service = yield* CommandAssist.CommandAssist;
    const sql = yield* SqlClient.SqlClient;
    const parent = ThreadId.make("thread:mark-parent");
    const child = ThreadId.make("thread:mark-child");
    yield* internal.note(factsFor(child, parent, 0));
    yield* sql`
      INSERT INTO command_assist_state (thread_id, state_json, updated_at)
      VALUES (${child}, ${JSON.stringify({ cacheKey: "key-one", drift: "走偏" })}, ${"2026-01-01T00:00:00.000Z"})
    `;
    yield* summary.markDriftFalsePositive({ threadId: child });
    const stored = yield* service.read(child);
    assert.strictEqual(stored.falsePositiveKey, "key-one");
    assert.strictEqual(stored.drift, null);
    assert.strictEqual((yield* summary.detail({ threadId: child }))?.phase, "在做");
    const missing = yield* summary
      .markDriftFalsePositive({ threadId: ThreadId.make("thread:missing") })
      .pipe(Effect.flip);
    assert.strictEqual(missing._tag, "ChildSummaryReadError");
  }).pipe(Effect.provide(assistStack(assist, database)));
});

it.effect("notifies the parent once when an eligible child crosses the silence line", () => {
  const database = SqlitePersistence.layerMemory;
  const settings = ServerSettingsService.layerTest({
    commandAssist: { patrol: { enabled: true, modelSelection: null } },
  });
  const assist = CommandAssist.layer.pipe(
    Layer.provide(
      Layer.succeed(CommandAssist.CommandAssistModel, { complete: () => Effect.succeed("{}") }),
    ),
    Layer.provide(settings),
    Layer.provide(database),
  );
  return Effect.gen(function* () {
    const delivered = yield* Deferred.make<Orchestrator.OrchestratorV2DispatchResult>();
    const sent = yield* Ref.make<ReadonlyArray<string>>([]);
    const engine = Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Ref.update(sent, (all) => [...all, command.type]).pipe(
          Effect.andThen(Deferred.succeed(delivered, { sequence: 1, storedEvents: [] })),
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    });
    const services = Layer.mergeAll(assist, database, engine);
    yield* Effect.gen(function* () {
      const internal = yield* ChildSessionSummaryInternal;
      const service = yield* CommandAssist.CommandAssist;
      const sql = yield* SqlClient.SqlClient;
      const parent = ThreadId.make("thread:patrol-parent");
      const child = ThreadId.make("thread:patrol-child");
      yield* seedAssistWorkspace(child, parent);
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${"patrol-run"}, ${child}, 1, ${"codex"}, ${"running"}, ${"2026-01-01T00:00:00.000Z"}, ${"{}"})
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_subagents
          (subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json)
        VALUES (${"patrol-task"}, ${parent}, ${"node"}, ${"codex"}, ${child}, ${"app_owned"}, ${"running"}, ${"2026-01-01T00:00:00.000Z"}, ${"{}"})
      `;
      yield* internal.note(factsFor(child, parent, 0));
      yield* TestClock.adjust("4 minutes");
      yield* internal.markIdle();
      yield* Deferred.await(delivered);
      yield* internal.markIdle();
      assert.deepStrictEqual(yield* Ref.get(sent), ["message.dispatch"]);
      assert.strictEqual((yield* service.read(child)).patrolCount, 1);
    }).pipe(
      Effect.provide(
        Layer.merge(ChildSessionSummary.layer.pipe(Layer.provide(services)), services),
      ),
    );
  });
});

it.effect("detail triggers one observe with the row opened when activity is on", () => {
  const gate: { enabled: boolean; queue: Queue.Queue<boolean> | undefined } = {
    enabled: false,
    queue: undefined,
  };
  const quiet = {
    called: false,
    activity: null,
    drift: null,
    outlook: null,
    childPhase: "在跑",
  };
  const database = SqlitePersistence.layerMemory;
  const assist = Layer.succeed(
    CommandAssist.CommandAssist,
    CommandAssist.CommandAssist.of({
      run: () => Effect.die("run is not part of this test"),
      observe: (input) => {
        const queue = gate.queue;
        if (queue === undefined) return Effect.die("observe queue was not ready");
        return Queue.offer(queue, input.opened).pipe(Effect.as(quiet));
      },
      markDriftFalsePositive: () => Effect.void,
      rememberDispatch: () => Effect.void,
      handback: () => Effect.die("handback is not part of this test"),
      tidy: () => Effect.die("tidy is not part of this test"),
      considerPatrol: () => Effect.die("patrol is not part of this test"),
      read: () => Effect.die("read is not part of this test"),
      activityOrDriftEnabled: () => Effect.succeed(gate.enabled),
      patrolEnabled: () => Effect.succeed(false),
    }),
  );
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<boolean>();
    gate.queue = queue;
    const internal = yield* ChildSessionSummaryInternal;
    const summary = yield* ChildSessionSummary;
    const parent = ThreadId.make("thread:opened-parent");
    const child = ThreadId.make("thread:opened-child");
    yield* seedAssistWorkspace(child, parent);
    yield* internal.note(factsFor(child, parent, 0));
    yield* TestClock.adjust(0);
    assert.strictEqual(Option.isNone(yield* Queue.poll(queue)), true);
    gate.enabled = true;
    const detail = yield* summary.detail({ threadId: child });
    assert.ok(detail !== null);
    const opened = yield* Queue.take(queue);
    assert.strictEqual(opened, true);
    yield* TestClock.adjust(0);
    assert.strictEqual(Option.isNone(yield* Queue.poll(queue)), true);
  }).pipe(Effect.provide(assistStack(assist, database)));
});

it.effect("default assist rows do not call a model or write state from detail or note", () => {
  const calls = { complete: 0 };
  const database = SqlitePersistence.layerMemory;
  const assist = CommandAssist.layer.pipe(
    Layer.provide(
      Layer.succeed(CommandAssist.CommandAssistModel, {
        complete: () => {
          calls.complete += 1;
          return Effect.succeed("{}");
        },
      }),
    ),
    Layer.provide(ServerSettingsService.layerTest({})),
    Layer.provide(database),
  );
  return Effect.gen(function* () {
    const internal = yield* ChildSessionSummaryInternal;
    const summary = yield* ChildSessionSummary;
    const sql = yield* SqlClient.SqlClient;
    const parent = ThreadId.make("thread:assist-off-parent");
    const child = ThreadId.make("thread:assist-off-child");
    yield* seedAssistWorkspace(child, parent);
    yield* internal.note(factsFor(child, parent, 0));
    const detail = yield* summary.detail({ threadId: child });
    assert.ok(detail !== null);
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (${"run-off"}, ${child}, 1, ${"codex"}, ${"completed"}, ${"2026-01-01T00:00:00.000Z"}, ${"{}"})
    `;
    yield* internal.note({ ...factsFor(child, parent, 0), status: "completed" });
    yield* TestClock.adjust(0);
    const rows = yield* sql<{ readonly total: number }>`
      SELECT count(*) AS total FROM command_assist_state WHERE thread_id = ${child}
    `;
    assert.strictEqual(Number(rows[0]?.total ?? 0), 0);
    assert.strictEqual(calls.complete, 0);
  }).pipe(Effect.provide(assistStack(assist, database)));
});

it.effect("hand-back reads the last assistant message of the current run", () => {
  const prompts: string[] = [];
  const database = SqlitePersistence.layerMemory;
  const assist = CommandAssist.layer.pipe(
    Layer.provide(
      Layer.succeed(CommandAssist.CommandAssistModel, {
        complete: (input) => {
          prompts.push(input.prompt);
          return Effect.succeed(JSON.stringify({ answer: "是", reason: "同一件事" }));
        },
      }),
    ),
    Layer.provide(
      ServerSettingsService.layerTest({
        commandAssist: { handback: { enabled: true, modelSelection: null } },
      }),
    ),
    Layer.provide(database),
  );
  return Effect.gen(function* () {
    const internal = yield* ChildSessionSummaryInternal;
    const assistService = yield* CommandAssist.CommandAssist;
    const sql = yield* SqlClient.SqlClient;
    const parent = ThreadId.make("thread:report-parent");
    const child = ThreadId.make("thread:report-child");
    yield* seedAssistWorkspace(child, parent);
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES
        (${"run-old"}, ${child}, 1, ${"codex"}, ${"completed"}, ${"2026-01-01T00:00:00.000Z"}, ${"{}"}),
        (${"run-new"}, ${child}, 2, ${"codex"}, ${"completed"}, ${"2026-01-01T00:01:00.000Z"}, ${"{}"})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
      ) VALUES
        (
          ${"old-last"}, ${child}, ${"run-old"}, 9, ${"assistant_message"}, ${"completed"},
          ${"2026-01-01T00:00:00.000Z"}, ${JSON.stringify({ text: "旧运行的最后一句" })}
        ),
        (
          ${"new-early"}, ${child}, ${"run-new"}, 1, ${"assistant_message"}, ${"completed"},
          ${"2026-01-01T00:01:00.000Z"}, ${JSON.stringify({ text: "当前运行的前一句" })}
        ),
        (
          ${"new-last"}, ${child}, ${"run-new"}, 2, ${"assistant_message"}, ${"completed"},
          ${"2026-01-01T00:02:00.000Z"}, ${JSON.stringify({ text: "当前运行的最后一句" })}
        )
    `;
    yield* internal.note(factsFor(child, parent, 0));
    yield* assistService.rememberDispatch({
      threadId: child,
      goal: "修好解析",
      avoid: null,
      testCommands: ["vp test run parser"],
    });
    yield* internal.note({ ...factsFor(child, parent, 0), status: "completed" });
    yield* TestClock.adjust(0);
    const asked = prompts.filter((prompt) => prompt.includes("当前运行的最后一句"));
    assert.strictEqual(asked.length, 1);
    assert.ok(prompts.every((prompt) => !prompt.includes("旧运行的最后一句")));
    assert.ok(prompts.every((prompt) => !prompt.includes("当前运行的前一句")));
  }).pipe(Effect.provide(assistStack(assist, database)));
});

const seedParentAndRemoteSubagent = (input: {
  readonly parentThreadId: ThreadId;
  readonly remoteEnvId: EnvironmentId;
  readonly remoteThreadId: ThreadId;
  readonly label: string;
  readonly title: string;
  readonly prompt: string;
  readonly subagentId: NodeId;
  readonly startedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const parentShell = liveThreadShell(input.parentThreadId);
    yield* sql`
      INSERT OR IGNORE INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${input.parentThreadId}, ${ProjectId.make("project:commander")}, ${"Commander"},
        'codex', 'full-access', 'default', ${input.startedAt}, ${input.startedAt},
        ${JSON.stringify({ ...parentShell, commander: true })}
      )
    `;
    const subagentPayload = {
      id: input.subagentId,
      threadId: input.parentThreadId,
      runId: null,
      parentNodeId: NodeId.make("node:root"),
      origin: "app_owned",
      createdBy: "agent",
      driver: "remote",
      providerInstanceId: "codex",
      providerThreadId: null,
      childThreadId: null,
      remoteChild: {
        environmentId: input.remoteEnvId,
        threadId: input.remoteThreadId,
        label: input.label,
        title: input.title,
      },
      nativeTaskRef: null,
      prompt: input.prompt,
      title: input.title,
      model: "gpt-5.4",
      status: "running",
      result: null,
      startedAt: input.startedAt,
      completedAt: null,
      updatedAt: input.startedAt,
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_subagents (
        subagent_id, thread_id, run_id, parent_node_id, provider, origin, child_thread_id,
        status, updated_at, payload_json
      ) VALUES (
        ${input.subagentId}, ${input.parentThreadId}, ${null}, ${"node:root"},
        ${"remote"}, ${"app_owned"}, ${null}, ${"running"}, ${input.startedAt},
        ${JSON.stringify(subagentPayload)}
      )
    `;
  });

const takeUpsertMatching = (
  queue: Queue.Queue<ChildSummaryStreamEvent>,
  predicate: (event: Extract<ChildSummaryStreamEvent, { readonly _tag: "upsert" }>) => boolean,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(queue);
      if (event._tag === "upsert" && predicate(event)) return event.row;
    }
  });

it.effect(
  "surfaces cross-machine child rows from FleetSummary in commandChildren without fetching remote transcripts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fleetContext = yield* FleetSummary.layerForTest().pipe(Layer.build);
        const fleetSummary = Context.get(fleetContext, FleetSummary.FleetSummary);
        const parent = ThreadId.make("thread:commander-1");
        const localChild = ThreadId.make("thread:local-child-1");
        const remoteEnv = EnvironmentId.make("env-linux-box");
        const remoteChild = ThreadId.make("thread:remote-child-1");

        const database = SqlitePersistence.layerMemory;
        const seeded = Layer.effectDiscard(
          seedParentAndRemoteSubagent({
            parentThreadId: parent,
            remoteEnvId: remoteEnv,
            remoteThreadId: remoteChild,
            label: "Linux Box",
            title: "Fix remote parser",
            prompt: "Run parser suite on Linux Box",
            subagentId: NodeId.make("node:remote-subagent-1"),
            startedAt: "2026-11-24T00:00:01.000Z",
          }).pipe(Effect.orDie),
        ).pipe(Layer.provide(database));
        const appLayer = Layer.mergeAll(
          ChildSessionSummary.layer,
          ChildSessionSummary.layerRemoteWorker.pipe(
            Layer.provide(ChildSessionSummary.layer),
            Layer.provide(Layer.succeed(FleetSummary.FleetSummary, fleetSummary)),
            Layer.provide(
              Layer.mock(Orchestrator.OrchestratorV2)({
                streamDomainEvents: Stream.never as Stream.Stream<OrchestrationV2DomainEvent>,
              }),
            ),
          ),
        ).pipe(Layer.provide(Layer.merge(database, seeded)));

        yield* Effect.gen(function* () {
          const internal = yield* ChildSessionSummaryInternal;
          const service = yield* ChildSessionSummary;
          yield* internal.note({
            ...factsFor(localChild, parent, Date.parse("2026-11-24T00:00:00.000Z")),
            branch: "local/118-local",
          });
          const updates = yield* Queue.unbounded<ChildSummaryStreamEvent>();
          yield* service.subscribe(parent).pipe(
            Stream.runForEach((event) => Queue.offer(updates, event)),
            Effect.forkScoped({ startImmediately: true }),
          );

          // Report cross-machine child progress exclusively via FleetSummary.
          yield* fleetSummary.report(remoteEnv, {
            type: "upsert-adhoc",
            threadId: remoteChild,
            title: "Fix remote parser",
            sessionRun: "running",
            reason: "running",
            needsYou: false,
            lastProgress: "Running parser tests",
            branch: "local/118-fleet-row",
            commit: "deadbeef1234",
          });

          const pushed = yield* takeUpsertMatching(
            updates,
            (event) =>
              event.row.threadId === remoteChild && event.row.activity === "Running parser tests",
          );
          assert.strictEqual(pushed.environmentId, remoteEnv);
          assert.strictEqual(pushed.environmentLabel, "Linux Box");
          assert.strictEqual(pushed.branch, "local/118-fleet-row");
          assert.strictEqual(pushed.commit, "deadbeef1234");

          // Both local and cross-machine children appear in the same commandChildren list.
          const page = yield* service.list({ threadId: parent });
          assert.strictEqual(page.children.length, 2);
          const localRow = page.children.find((row) => row.threadId === localChild);
          const remoteRow = page.children.find((row) => row.threadId === remoteChild);
          assert.ok(localRow !== undefined);
          assert.ok(remoteRow !== undefined);
          assert.strictEqual(localRow.environmentId, undefined);
          assert.strictEqual(localRow.branch, "local/118-local");
          assert.strictEqual(remoteRow.environmentId, remoteEnv);
          assert.strictEqual(remoteRow.environmentLabel, "Linux Box");
          assert.strictEqual(remoteRow.title, "Fix remote parser");
          assert.strictEqual(remoteRow.phase, "在做");
          assert.strictEqual(remoteRow.activity, "Running parser tests");
          assert.strictEqual(remoteRow.branch, "local/118-fleet-row");
          assert.strictEqual(remoteRow.commit, "deadbeef1234");
          // No tenure / term / handoff fields are added in this phase.
          assert.strictEqual("tenure" in remoteRow, false);
          assert.strictEqual("termNumber" in remoteRow, false);

          // Detail serves cached summary data without subscribing to any remote transcript.
          const detail = yield* service.detail({ threadId: remoteChild });
          assert.ok(detail !== null);
          assert.strictEqual(detail.branch, "local/118-fleet-row");
          assert.strictEqual(detail.commit, "deadbeef1234");
          assert.strictEqual(detail.goal, "Run parser suite on Linux Box");
        }).pipe(Effect.provide(appLayer));
      }),
    ),
);

it.effect("rebuilds a remote child summary on restore and drops it on purge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fleetContext = yield* FleetSummary.layerForTest().pipe(Layer.build);
      const fleetSummary = Context.get(fleetContext, FleetSummary.FleetSummary);
      const parent = ThreadId.make("thread:remote-lifecycle-parent");
      const remoteEnv = EnvironmentId.make("env-remote-lifecycle");
      const remoteChild = ThreadId.make("thread:remote-lifecycle-child");
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const database = SqlitePersistence.layerMemory;
      const seeded = Layer.effectDiscard(
        seedParentAndRemoteSubagent({
          parentThreadId: parent,
          remoteEnvId: remoteEnv,
          remoteThreadId: remoteChild,
          label: "Linux Box",
          title: "Restore remote parser",
          prompt: "Keep the remote parser running",
          subagentId: NodeId.make("node:remote-lifecycle"),
          startedAt: "2026-11-24T00:00:01.000Z",
        }).pipe(Effect.orDie),
      ).pipe(Layer.provide(database));
      const appLayer = Layer.mergeAll(
        ChildSessionSummary.layer,
        ChildSessionSummary.layerRemoteWorker.pipe(
          Layer.provide(ChildSessionSummary.layer),
          Layer.provide(Layer.succeed(FleetSummary.FleetSummary, fleetSummary)),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
          ),
        ),
      ).pipe(Layer.provide(Layer.merge(database, seeded)));

      yield* Effect.gen(function* () {
        const service = yield* ChildSessionSummary;
        const updates = yield* Queue.unbounded<ChildSummaryStreamEvent>();
        yield* service.subscribe(parent).pipe(
          Stream.runForEach((event) => Queue.offer(updates, event)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* fleetSummary.report(remoteEnv, {
          type: "upsert-adhoc",
          threadId: remoteChild,
          title: "Restore remote parser",
          sessionRun: "running",
          reason: "running",
          needsYou: false,
          lastProgress: "Running parser tests",
        });
        yield* takeUpsertMatching(updates, (event) => event.row.threadId === remoteChild);

        const lifecycle = (type: "thread.deleted" | "thread.restored" | "thread.purged") =>
          Queue.offer(events, {
            id: EventId.make(`event:${type}`),
            threadId: parent,
            type,
            occurredAt: DateTime.makeUnsafe(0),
            payload: liveThreadShell(parent),
          } as OrchestrationV2DomainEvent);
        yield* lifecycle("thread.deleted");
        const deleted = yield* Queue.take(updates);
        assert.strictEqual(deleted._tag, "deleted");
        assert.strictEqual(yield* service.detail({ threadId: remoteChild }), null);

        yield* lifecycle("thread.restored");
        const restored = yield* takeUpsertMatching(
          updates,
          (event) => event.row.threadId === remoteChild,
        );
        assert.strictEqual(restored.environmentId, remoteEnv);
        assert.strictEqual(restored.activity, "Running parser tests");

        yield* lifecycle("thread.purged");
        const purged = yield* Queue.take(updates);
        assert.strictEqual(purged._tag, "deleted");
        assert.strictEqual(yield* service.detail({ threadId: remoteChild }), null);
      }).pipe(Effect.provide(appLayer));
    }),
  ),
);

it.effect(
  "marks only an unreachable remote row stuck with reason while commander input remains usable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fleetContext = yield* FleetSummary.layerForTest().pipe(Layer.build);
        const fleetSummary = Context.get(fleetContext, FleetSummary.FleetSummary);
        const fleetSql = Context.get(fleetContext, SqlClient.SqlClient);

        const instanceId = ProviderInstanceId.make("codex");
        const driver = ProviderDriverKind.make("codex");
        const modelSelection = { instanceId, model: "gpt-5.4" };
        const adapter = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("no provider process needed"),
        } as ProviderAdapter.ProviderAdapterV2["Service"];

        const database = SqlitePersistence.layerMemory;
        const harness = ProviderReplayHarness.layerWithRegistry(
          { name: "remote-row-unreachable" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: database, runEffectWorker: false },
        );
        const summaryLayer = ChildSessionSummary.layer.pipe(Layer.provide(database));
        const fullLayer = Layer.mergeAll(
          database,
          harness,
          summaryLayer,
          ChildSessionSummary.layerRemoteWorker.pipe(
            Layer.provide(summaryLayer),
            Layer.provide(harness),
            Layer.provide(Layer.succeed(FleetSummary.FleetSummary, fleetSummary)),
            Layer.provide(database),
          ),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSinkV2;
          const internal = yield* ChildSessionSummaryInternal;
          const service = yield* ChildSessionSummary;

          const commander = ThreadId.make("thread:commander-unreachable");
          const localChild = ThreadId.make("thread:local-healthy");
          const downEnv = EnvironmentId.make("env-down");
          const downChild = ThreadId.make("thread:remote-down");
          const runId = RunId.make("run:commander-unreachable");
          const rootNodeId = NodeId.make("node:commander-unreachable:root");
          const providerThreadId = ProviderThreadId.make("provider-thread:commander-unreachable");
          const now = yield* DateTime.now;

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:create-commander"),
            threadId: commander,
            projectId: ProjectId.make("project:commander"),
            title: "Commander",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* sink.write({
            commandId: CommandId.make("command:seed-commander-run"),
            events: [
              {
                id: EventId.make("event:seed-pt"),
                type: "provider-thread.updated",
                threadId: commander,
                driver,
                providerInstanceId: instanceId,
                occurredAt: now,
                payload: {
                  id: providerThreadId,
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: null,
                  appThreadId: commander,
                  ownerNodeId: rootNodeId,
                  nativeThreadRef: { driver, nativeId: "native:commander", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "active",
                  firstRunOrdinal: 1,
                  lastRunOrdinal: 1,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make("event:seed-node"),
                type: "node.updated",
                threadId: commander,
                runId,
                nodeId: rootNodeId,
                driver,
                providerInstanceId: instanceId,
                occurredAt: now,
                payload: {
                  id: rootNodeId,
                  threadId: commander,
                  runId,
                  parentNodeId: null,
                  rootNodeId,
                  kind: "root_turn",
                  status: "running",
                  countsForRun: true,
                  providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  runtimeRequestId: null,
                  checkpointScopeId: null,
                  startedAt: now,
                  completedAt: null,
                },
              },
              {
                id: EventId.make("event:seed-run"),
                type: "run.updated",
                threadId: commander,
                runId,
                nodeId: rootNodeId,
                providerInstanceId: instanceId,
                occurredAt: now,
                payload: {
                  id: runId,
                  threadId: commander,
                  ordinal: 1,
                  providerInstanceId: instanceId,
                  modelSelection,
                  providerThreadId,
                  userMessageId: MessageId.make("message:seed-user"),
                  rootNodeId,
                  activeAttemptId: null,
                  status: "running",
                  requestedAt: now,
                  startedAt: now,
                  completedAt: null,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
            ],
          });

          // Subscribe before dispatching so every live transition is captured deterministically.
          const updates = yield* Queue.unbounded<ChildSummaryStreamEvent>();
          yield* service.subscribe(commander).pipe(
            Stream.runForEach((event) => Queue.offer(updates, event)),
            Effect.forkScoped({ startImmediately: true }),
          );

          // Local sibling child is running normally.
          yield* internal.note(factsFor(localChild, commander, 1000));
          yield* takeUpsertMatching(updates, (event) => event.row.threadId === localChild);

          // Remote child is delegated through OrchestratorV2 and reports progress via FleetSummary.
          yield* orchestrator.dispatch({
            type: "delegated_task.remote.request",
            commandId: CommandId.make("command:remote-delegate-down"),
            parentThreadId: commander,
            parentRunId: runId,
            parentNodeId: rootNodeId,
            task: "Build on Worker Down",
            title: "Build worker",
            driver: ProviderDriverKind.make("remote"),
            modelSelection,
            remoteChild: {
              environmentId: downEnv,
              threadId: downChild,
              label: "Worker Down",
              title: "Build worker",
            },
          });
          yield* fleetSummary.report(downEnv, {
            type: "upsert-adhoc",
            threadId: downChild,
            title: "Build worker",
            sessionRun: "running",
            reason: "running",
            needsYou: false,
            lastProgress: "Compiling server",
            branch: "local/118-down",
            commit: "9999aaaa",
          });
          const liveRemote = yield* takeUpsertMatching(
            updates,
            (event) =>
              event.row.threadId === downChild && event.row.activity === "Compiling server",
          );
          assert.strictEqual(liveRemote.phase, "在做");

          // Worker Down stops heartbeating: FleetSummary marks its row offline.
          yield* fleetSql`
            INSERT INTO fleet_environment_heartbeats (environment_id, last_seen)
            VALUES (${downEnv}, '1970-01-01T00:00:00.000Z')
          `;
          yield* TestClock.adjust("100 seconds");
          yield* fleetSummary.sweepStale;

          const stuckRemote = yield* takeUpsertMatching(
            updates,
            (event) => event.row.threadId === downChild && event.row.phase === "卡住",
          );
          assert.strictEqual(stuckRemote.stale, true);
          assert.strictEqual(stuckRemote.staleReason, "environment offline");
          assert.strictEqual(stuckRemote.reason, "执行环境连不上");
          assert.strictEqual(stuckRemote.needsYou, true);
          assert.strictEqual(stuckRemote.activity, "Compiling server");

          // Only the unreachable row is stuck; sibling local row stays working.
          const listed = yield* service.list({ threadId: commander });
          const sibling = listed.children.find((row) => row.threadId === localChild);
          assert.ok(sibling !== undefined);
          assert.strictEqual(sibling.phase, "在做");
          assert.strictEqual(sibling.stale, undefined);

          // Commander thread input remains fully usable while that remote row is unreachable.
          const userMsgId = MessageId.make("message:commander-input-while-row-offline");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:commander-input"),
            threadId: commander,
            messageId: userMsgId,
            text: "继续派别的活",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
          const projection = yield* orchestrator.getThreadProjection(commander);
          assert.ok(projection.messages.some((message) => message.id === userMsgId));

          // When Worker Down reconnects, its row recovers cleanly.
          yield* fleetSql`
            UPDATE fleet_environment_heartbeats
            SET last_seen = '2999-01-01T00:00:00.000Z'
            WHERE environment_id = ${downEnv}
          `;
          yield* fleetSummary.sweepStale;
          const recovered = yield* takeUpsertMatching(
            updates,
            (event) =>
              event.row.threadId === downChild &&
              event.row.phase === "在做" &&
              event.row.stale !== true,
          );
          assert.strictEqual(recovered.activity, "Compiling server");
        }).pipe(Effect.provide(fullLayer));
      }),
    ),
);
