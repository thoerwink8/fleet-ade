import { assert, it } from "@effect/vitest";
import {
  CHILD_SUMMARY_PAGE_SIZE,
  ChildSummaryCursorError,
  EventId,
  ProjectId,
  ThreadId,
  type ChildSummaryStreamEvent,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
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

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { ChildSessionSummary, ChildSessionSummaryInternal } from "./ChildSessionSummary.ts";
import * as CommandAssist from "./CommandAssist.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
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
  type: "thread.deleted" | "thread.metadata-updated" | "run.updated",
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
