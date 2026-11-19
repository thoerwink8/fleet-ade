import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { FLEET_SUMMARY_PAGE_SIZE, FLEET_SUMMARY_PROGRESS_LIMIT } from "@t3tools/contracts";
import * as FleetSummary from "./FleetSummary.ts";

const ledgerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR IGNORE INTO repos (owner, name) VALUES ('example', 'one')`;
    yield* sql`
      INSERT OR IGNORE INTO node_claims (
        fleet_id, repo, issue, task_id, claimed_by, holder_environment, lease_until, executor,
        state, fencing, attempt, claim_idempotency_key)
      VALUES
        ('coordinator', 'example/one', 7, 'root', 'session-a', 'environment-a', '2999-01-01T00:00:00.000Z', 'fleet', 'running', '1', 1, 'fixture-root'),
        ('coordinator', 'example/one', 7, 'other', 'session-a', 'environment-a', '2999-01-01T00:00:00.000Z', 'fleet', 'running', '1', 1, 'fixture-other'),
        ('coordinator', 'example/one', 7, 'task-a', 'session-a', 'environment-a', '2999-01-01T00:00:00.000Z', 'fleet', 'running', '1', 1, 'fixture-task-a'),
        ('coordinator', 'example/one', 7, 'task-b', 'session-b', 'environment-b', '2999-01-01T00:00:00.000Z', 'fleet', 'running', '1', 1, 'fixture-task-b'),
        ('coordinator', 'example/one', 7, 'b-task', 'session-b', 'environment-b', '2999-01-01T00:00:00.000Z', 'fleet', 'running', '1', 1, 'fixture-b-task')
    `;
    yield* sql`
      WITH RECURSIVE ids(task_id) AS (
        SELECT 'task-0'
        UNION ALL SELECT 'task-' || (CAST(substr(task_id, 6) AS INTEGER) + 1) FROM ids
        WHERE CAST(substr(task_id, 6) AS INTEGER) BETWEEN 0 AND 999
      )
      INSERT OR IGNORE INTO node_claims (
        fleet_id, repo, issue, task_id, claimed_by, holder_environment, lease_until, executor,
        state, fencing, attempt, claim_idempotency_key)
      SELECT 'coordinator', 'example/one', 7, task_id, 'session-a', 'environment-a',
        '2999-01-01T00:00:00.000Z', 'fleet', 'running', '1', 1, 'fixture-' || task_id
      FROM ids
    `;
  }),
).pipe(Layer.provideMerge(FleetSummary.layerForTest()), Layer.provideMerge(TestClock.layer()));

const task = (taskId: string, overrides: Record<string, unknown> = {}) => ({
  type: "upsert-task" as const,
  repo: "example/one",
  issue: 7,
  taskId,
  threadId: `thread-${taskId}`,
  title: `Task ${taskId}`,
  sessionRun: "running" as const,
  reason: "working",
  needsYou: false,
  lastProgress: "building",
  ...overrides,
});

const adhoc = (threadId: string, overrides: Record<string, unknown> = {}) => ({
  type: "upsert-adhoc" as const,
  threadId,
  title: `Adhoc ${threadId}`,
  sessionRun: "running" as const,
  reason: "working",
  needsYou: false,
  lastProgress: "waiting",
  ...overrides,
});

const first = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  Stream.runCollect(stream.pipe(Stream.take(1))).pipe(Effect.map((events) => events[0]));

const serviceTest = <A, E>(
  effect: Effect.Effect<A, E, FleetSummary.FleetSummary | Scope.Scope | SqlClient.SqlClient>,
) => effect.pipe(Effect.scoped, Effect.provide(ledgerLayer));

it.effect("报告只生成 DTO 摘要，隐藏正文、工具输出和 diff，并映射 phase/截断进度", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      const result = yield* summary.report(
        "environment-a",
        task("root", {
          title: "visible title",
          sessionRun: "waiting",
          lastProgress: `  first\nsecond ${"x".repeat(200)} `,
          // These fields deliberately model detail that must never cross the summary DTO.
          body: "secret transcript",
          toolOutput: "secret tool output",
          diff: "secret diff",
        }) as never,
      );
      expect(result.changed).toBe(true);
      const event = yield* first(yield* summary.subscribe({}));
      assert(event?.type === "snapshot");
      const row = event.rows[0];
      assert(row !== undefined);
      expect(row).toMatchObject({
        environmentId: "environment-a",
        repo: "example/one",
        issue: 7,
        taskId: "root",
        phase: "stuck",
      });
      expect(row.lastProgress).toHaveLength(FLEET_SUMMARY_PROGRESS_LIMIT);
      expect(row).not.toHaveProperty("body");
      expect(row).not.toHaveProperty("toolOutput");
      expect(row).not.toHaveProperty("diff");
    }),
  ),
);

it.effect("游标从 R+1 推增量，且无变化不推", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      const initial = yield* summary.report("environment-a", task("root"));
      const live = yield* summary.subscribe({ cursor: initial.revision });
      const changed = yield* summary.report(
        "environment-a",
        task("root", { reason: "needs attention", needsYou: true }),
      );
      expect(changed.revision).toBe(initial.revision + 1);
      const event = yield* first(live);
      expect(event?.type).toBe("upsert");
      if (event?.type === "upsert") {
        expect(event.revision).toBe(initial.revision + 1);
        expect(event.row.reason).toBe("needs attention");
      }
      const unchanged = yield* summary.report(
        "environment-a",
        task("root", { reason: "needs attention", needsYou: true }),
      );
      expect(unchanged).toEqual({ revision: changed.revision, changed: false });
    }),
  ),
);

it.effect("任务键和 adhoc 键包含环境身份，删除产生 tombstone", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      yield* summary.report("environment-a", task("root"));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE node_claims SET claimed_by = 'session-b', holder_environment = 'environment-b'
        WHERE repo = 'example/one' AND issue = 7 AND task_id = 'root'`;
      yield* summary.report("environment-b", task("root"));
      yield* summary.report("environment-a", adhoc("same-thread"));
      const stream = yield* summary.subscribe({});
      const pages = yield* Stream.runCollect(stream.pipe(Stream.take(1)));
      expect(pages[0]?.type).toBe("snapshot");
      if (pages[0]?.type === "snapshot") {
        expect(pages[0].rows).toHaveLength(3);
        expect(new Set(pages[0].rows.map((row) => row.environmentId))).toEqual(
          new Set(["environment-a", "environment-b"]),
        );
      }
      const cursor = pages[0]?.type === "snapshot" ? pages[0].revision : 0;
      const changes = yield* summary.subscribe({ cursor });
      yield* summary.report("environment-a", {
        type: "delete-task",
        repo: "example/one",
        issue: 7,
        taskId: "root",
      });
      const tombstone = yield* first(changes);
      expect(tombstone).toMatchObject({
        type: "tombstone",
        key: { environmentId: "environment-a", repo: "example/one", issue: 7, taskId: "root" },
      });
    }),
  ),
);
it.effect("双环境订阅汇总四行且更新只推对应行", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      yield* summary.report("environment-a", task("task-a"));
      yield* summary.report("environment-a", adhoc("adhoc-a"));
      yield* summary.report("environment-b", task("task-b"));
      yield* summary.report("environment-b", adhoc("adhoc-b"));

      const snapshot = yield* first(yield* summary.subscribe({}));
      assert(snapshot?.type === "snapshot");
      expect(snapshot.rows).toHaveLength(4);
      expect(new Set(snapshot.rows.map((row) => row.environmentId))).toEqual(
        new Set(["environment-a", "environment-b"]),
      );

      const live = yield* summary.subscribe({ cursor: snapshot.revision });
      yield* summary.report(
        "environment-b",
        adhoc("adhoc-b", { reason: "needs attention", needsYou: true }),
      );
      const change = yield* first(live);
      expect(change).toMatchObject({
        type: "upsert",
        row: { environmentId: "environment-b", threadId: "adhoc-b", reason: "needs attention" },
      });
    }),
  ),
);
it.effect("合并行移动到队尾保持 revision 顺序", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      yield* summary.report("environment-a", task("root"));
      yield* summary.report("environment-a", adhoc("other"));
      const live = yield* summary.subscribe({ cursor: 2 });
      yield* summary.report("environment-a", task("root", { reason: "first" }));
      yield* summary.report("environment-a", adhoc("other", { reason: "second" }));
      yield* summary.report("environment-a", task("root", { reason: "third" }));
      const events = yield* Stream.runCollect(live.pipe(Stream.take(2)));
      expect(events.map((event) => event.type)).toEqual(["upsert", "upsert"]);
      if (events[0]?.type === "upsert" && events[1]?.type === "upsert") {
        expect(events[0].revision).toBe(4);
        expect(events[1].revision).toBe(5);
      }
    }),
  ),
);

it.effect("快照分页每页不超过 200 行，并携带同一 revision", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      for (let index = 0; index < FLEET_SUMMARY_PAGE_SIZE + 1; index++) {
        yield* summary.report("environment-a", task(`task-${index}`));
      }
      const pages = yield* Stream.runCollect((yield* summary.subscribe({})).pipe(Stream.take(2)));
      expect(pages).toHaveLength(2);
      expect(pages[0]?.type).toBe("snapshot");
      expect(pages[1]?.type).toBe("snapshot");
      if (pages[0]?.type === "snapshot" && pages[1]?.type === "snapshot") {
        expect(pages[0].rows).toHaveLength(FLEET_SUMMARY_PAGE_SIZE);
        expect(pages[1].rows).toHaveLength(1);
        expect(pages[0].revision).toBe(pages[1].revision);
        expect(pages[0].pageCount).toBe(2);
      }
    }),
  ),
);

it.effect("未来和过期游标返回 resync，缺口也拒绝静默跳过", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      const firstWrite = yield* summary.report("environment-a", adhoc("first"));
      const future = yield* first(yield* summary.subscribe({ cursor: firstWrite.revision + 1 }));
      expect(future).toEqual({ type: "resync", reason: "gap" });
      const sql = yield* SqlClient.SqlClient;
      yield* summary.report("environment-a", adhoc("gap-one"));
      yield* summary.report("environment-a", adhoc("gap-two"));
      yield* sql`DELETE FROM fleet_summary_changes WHERE revision = 2`;
      const gap = yield* first(yield* summary.subscribe({ cursor: 1 }));
      expect(gap).toEqual({ type: "resync", reason: "gap" });
      for (let index = 0; index < 1001; index++) {
        yield* summary.report("environment-a", adhoc(`thread-${index}`));
      }
      const expired = yield* first(yield* summary.subscribe({ cursor: 0 }));
      expect(expired).toEqual({ type: "resync", reason: "expired" });
    }),
  ),
);

it.effect("重放缺少末尾 revision 时返回 resync", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      const sql = yield* SqlClient.SqlClient;
      const initial = yield* summary.report("environment-a", adhoc("initial"));
      const middle = yield* summary.report("environment-a", adhoc("middle"));
      const latest = yield* summary.report("environment-a", adhoc("latest"));
      yield* sql`DELETE FROM fleet_summary_changes WHERE revision = ${latest.revision}`;
      expect(yield* first(yield* summary.subscribe({ cursor: initial.revision }))).toEqual({
        type: "resync",
        reason: "gap",
      });
      // Empty replay is also a missing suffix, not a valid live-only subscription.
      expect(yield* first(yield* summary.subscribe({ cursor: middle.revision }))).toEqual({
        type: "resync",
        reason: "gap",
      });
    }),
  ),
);

it.effect("重建同一 filename 后 revision 不回退", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fleet-summary-test-" });
      const filename = path.join(directory, "ledger.sqlite");
      const firstContext = yield* FleetSummary.layerForTest(filename).pipe(Layer.build);
      const firstSummary = Context.get(firstContext, FleetSummary.FleetSummary);
      const sql = Context.get(firstContext, SqlClient.SqlClient);
      yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
      const write = yield* firstSummary.report("environment-a", adhoc("root"));
      const secondContext = yield* FleetSummary.layerForTest(filename).pipe(Layer.build);
      const secondSummary = Context.get(secondContext, FleetSummary.FleetSummary);
      const second = yield* secondSummary.report("environment-a", adhoc("other"));
      expect(second.revision).toBeGreaterThan(write.revision);
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("markEnvironmentStale 只改 stale，不改 phase", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      yield* summary.report("environment-a", task("root", { sessionRun: "waiting" }));
      const result = yield* summary.markEnvironmentStale("environment-a", true, "lease lost");
      expect(result.changed).toBe(true);
      const event = yield* first(yield* summary.subscribe({ cursor: 1 }));
      expect(event?.type).toBe("upsert");
      if (event?.type === "upsert") {
        expect(event.row.phase).toBe("stuck");
        expect(event.row.stale).toBe(true);
        expect(event.row.staleReason).toBe("lease lost");
      }
    }),
  ),
);
it.effect("订阅返回后延迟消费仍限制队列，溢出返回 resync 且不丢 tombstone", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      const initial = yield* summary.report("environment-a", task("root"));
      const live = yield* summary.subscribe({ cursor: initial.revision });
      for (let index = 0; index < 200; index++) {
        yield* summary.report("environment-a", adhoc(`row-${index}`));
      }
      yield* summary.report("environment-a", {
        type: "delete-task",
        repo: "example/one",
        issue: 7,
        taskId: "root",
      });
      const events = yield* Stream.runCollect(live);
      expect(events).toEqual([{ type: "resync", reason: "gap" }]);
    }),
  ),
);

it.effect("慢消费者同一行最终收到最后变化", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      const initial = yield* summary.report("environment-a", task("root"));
      const stream = yield* summary.subscribe({ cursor: initial.revision });
      let latest = initial.revision;
      for (let index = 0; index < 220; index++) {
        latest = (yield* summary.report(
          "environment-a",
          task("root", { reason: `change-${index}` }),
        )).revision;
      }
      const final = yield* Stream.runCollect(
        stream.pipe(
          Stream.filter((event) => event.type === "upsert" && event.revision === latest),
          Stream.take(1),
        ),
      );
      const last = final[0];
      expect(last?.type).toBe("upsert");
      if (last?.type === "upsert") {
        expect(last.revision).toBe(latest);
        expect(last.row.reason).toBe("change-219");
      }
    }),
  ),
);

it.effect("任务行随租约状态转 stale，租约恢复后自动清除", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fleet-summary-stale-" });
      const context = yield* FleetSummary.layerForTest(path.join(directory, "ledger.sqlite")).pipe(
        Layer.build,
      );
      const summary = Context.get(context, FleetSummary.FleetSummary);
      const sql = Context.get(context, SqlClient.SqlClient);
      yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
      const holdLease = (taskId: string, until = "2999-01-01T00:00:00.000Z") =>
        sql`INSERT INTO node_claims (repo, issue, task_id, claimed_by, holder_environment, lease_until, state, attempt)
          VALUES ('example/one', 7, ${taskId}, 'session-a', 'environment-a', ${until}, 'running', 1)
          ON CONFLICT(repo, issue, task_id) DO UPDATE SET
            holder_environment = excluded.holder_environment, lease_until = excluded.lease_until,
            state = excluded.state`;
      const snapshot = Effect.gen(function* () {
        const event = yield* first(yield* summary.subscribe({}));
        if (event?.type !== "snapshot") throw new Error("Expected summary snapshot");
        return event.rows;
      });
      yield* holdLease("root");
      yield* holdLease("other");
      yield* summary.report("environment-a", task("root", { sessionRun: "waiting" }));
      yield* summary.report("environment-a", task("other"));
      yield* summary.report("environment-a", adhoc("adhoc-a"));
      yield* summary.report("environment-b", adhoc("adhoc-b"));
      yield* summary.markEnvironmentStale("environment-b", true, "disconnected");

      // One expired task must not be hidden by another live lease in the same environment.
      yield* holdLease("root", "1970-01-01T00:00:00.000Z");
      yield* summary.sweepStale;
      const stale = yield* snapshot;
      expect(stale.find((row) => row.taskId === "root")).toMatchObject({
        phase: "stuck",
        reason: "working",
        stale: true,
        staleReason: "lease lost",
      });
      expect(stale.find((row) => row.taskId === "other")).toMatchObject({ stale: false });
      expect(stale.find((row) => row.threadId === "adhoc-a")).toMatchObject({ stale: false });
      expect(stale.find((row) => row.threadId === "adhoc-b")).toMatchObject({
        stale: true,
        staleReason: "disconnected",
      });

      yield* holdLease("root");
      yield* summary.sweepStale;
      const recovered = (yield* snapshot).find((row) => row.taskId === "root");
      expect(recovered).toMatchObject({ phase: "stuck", reason: "working", stale: false });
      expect(recovered?.staleReason).toBeUndefined();

      // A successful report with a recovered exact lease also clears stale immediately.
      yield* holdLease("root", "1970-01-01T00:00:00.000Z");
      yield* summary.sweepStale;
      yield* holdLease("root");
      const report = yield* summary.report(
        "environment-a",
        task("root", { sessionRun: "waiting" }),
      );
      expect(report.changed).toBe(true);
      const reported = (yield* snapshot).find((row) => row.taskId === "root");
      expect(reported).toMatchObject({ phase: "stuck", reason: "working", stale: false });
      expect(reported?.staleReason).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
it.effect("任务上报要求调用方持有该任务租约", () =>
  serviceTest(
    Effect.gen(function* () {
      const summary = yield* FleetSummary.FleetSummary;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT OR IGNORE INTO repos (owner, name) VALUES ('example', 'one')`;
      yield* sql`UPDATE node_claims SET claimed_by = 'session-b', holder_environment = 'environment-b' WHERE repo = 'example/one' AND issue = 7 AND task_id = 'root'`;
      const error = yield* summary.report("environment-a", task("root")).pipe(Effect.flip);
      expect(error.reason).toBe("lease-required");
    }),
  ),
);
