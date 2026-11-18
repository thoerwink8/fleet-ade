import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeClaims from "./nodeClaims.ts";
import * as FleetClaims from "./FleetClaims.ts";

const ledgerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one'), ('other', 'repo')`;
  }),
).pipe(Layer.provideMerge(FleetClaims.layerForTest()));

const caller = (environmentId: string, sessionId = environmentId) => ({
  sessionId,
  environmentId,
});

const input = (taskId: string, idempotencyKey: string, attempt = 1, fencing = "1") => ({
  repo: "example/one",
  issue: 7,
  taskId,
  attempt,
  fencing,
  idempotencyKey,
});

const beat = (
  environmentId: string,
  leases: ReadonlyArray<{ readonly taskId: string; readonly attempt: number }>,
  sequence = 1,
) => ({
  environmentId,
  input: {
    sequence,
    leases: leases.map((lease) => ({
      repo: "example/one",
      issue: 7,
      taskId: lease.taskId,
      attempt: lease.attempt,
      fencing: String(lease.attempt),
    })),
  },
});

it.effect("同一键两台机器并发 claim 只有一个成功", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const results = yield* Effect.all(
      [
        claims.claim(caller("node-a"), input("root", "claim-a")),
        claims.claim(caller("node-b"), input("root", "claim-b")),
      ],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(results.map((result) => result.outcome).toSorted(), [
      "already-held",
      "claimed",
    ]);
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("不同调用方不能用 fleetId 拆开同一租约键", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const first = yield* claims.claim(caller("node-a"), input("root", "claim-a"));
    const second = yield* claims.claim(caller("node-b"), input("root", "claim-b"));
    assert.strictEqual(first.outcome, "claimed");
    assert.strictEqual(second.outcome, "already-held");
    assert.strictEqual(second.claim, null);
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("同仓不同 taskId 和不同仓可同时成功", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const root = yield* claims.claim(caller("node-a"), input("root", "claim-root"));
    const child = yield* claims.claim(caller("node-b"), input("child-1", "claim-child"));
    const other = yield* claims.claim(caller("node-c"), {
      ...input("root", "claim-other"),
      repo: "other/repo",
    });
    assert.strictEqual(root.outcome, "claimed");
    assert.strictEqual(child.outcome, "claimed");
    assert.strictEqual(other.outcome, "claimed");
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("仓名按登记写法归一，非法尾斜杠拒绝", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const canonical = yield* claims.claim(caller("node-a"), {
      ...input("root", "claim-a"),
      repo: "EXAMPLE/ONE",
    });
    assert.strictEqual(canonical.claim?.repo, "example/one");
    assert.strictEqual(
      (yield* claims.claim(caller("node-b"), input("root", "claim-b"))).outcome,
      "already-held",
    );
    const malformed = yield* claims
      .claim(caller("node-c"), { ...input("root", "bad"), repo: "example/one/" })
      .pipe(Effect.flip);
    assert.strictEqual(malformed.reason, "unknown-repo");
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("legacy 与机群路径按 repo issue root 互相阻止", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const sql = yield* SqlClient.SqlClient;
    yield* NodeClaims.apply(
      sql,
      {
        action: "claim",
        repo: "example/one",
        issue: 7,
        title: "单 7",
        claimedBy: "pipeline",
        leaseUntil: "9999-01-01T00:00:00.000Z",
      },
      0,
    );
    assert.strictEqual(
      (yield* claims.claim(caller("node-a"), input("root", "fleet"))).outcome,
      "already-held",
    );
    yield* sql`DELETE FROM node_claims`;
    yield* claims.claim(caller("node-a"), input("root", "fleet"));
    assert.strictEqual(
      (yield* NodeClaims.apply(
        sql,
        {
          action: "claim",
          repo: "example/one",
          issue: 7,
          title: "单 7",
          claimedBy: "pipeline",
          leaseUntil: "9999-01-01T00:00:00.000Z",
        },
        0,
      )).code,
      "engine_has_it",
    );
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("同持有者换 claim key 返回当前租约，旧 key 在释放后变 stale", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const first = yield* claims.claim(caller("node-a"), input("root", "claim-a"));
    const held = yield* claims.claim(caller("node-a"), input("root", "claim-b"));
    assert.strictEqual(held.outcome, "already-held");
    assert.deepEqual(held.claim, first.claim);
    yield* claims.release(caller("node-a"), input("root", "release-a", 1, first.claim!.fencing));
    assert.strictEqual(
      (yield* claims.claim(caller("node-a"), input("root", "claim-a"))).outcome,
      "stale",
    );
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("renew 重放只在当前租约仍运行且未过期时幂等", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const claimed = yield* claims.claim(caller("node-a"), input("root", "claim-a"));
    const lease = input("root", "renew-a", 1, claimed.claim!.fencing);
    const renewed = yield* claims.renew(caller("node-a"), lease);
    yield* TestClock.adjust("10 seconds");
    assert.deepEqual(yield* claims.renew(caller("node-a"), lease), renewed);
    yield* claims.release(caller("node-a"), { ...lease, idempotencyKey: "release-a" });
    assert.strictEqual((yield* claims.renew(caller("node-a"), lease)).outcome, "stale");
    assert.strictEqual(
      (yield* claims.release(caller("node-a"), { ...lease, idempotencyKey: "release-a" })).outcome,
      "stale",
    );
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("旧 attempt 不能修改新 attempt，fencing 随 attempt 递增", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const first = yield* claims.claim(caller("node-a"), input("root", "claim-a"));
    assert.strictEqual(first.claim?.fencing, "1");
    const oldLease = input("root", "release-a", 1, first.claim!.fencing);
    yield* claims.release(caller("node-a"), oldLease);
    const second = yield* claims.claim(caller("node-b"), input("root", "claim-b"));
    assert.strictEqual(second.claim?.attempt, 2);
    assert.strictEqual(second.claim?.fencing, "2");
    assert.strictEqual(
      (yield* claims.renew(caller("node-a"), { ...oldLease, idempotencyKey: "renew-old" })).outcome,
      "stale",
    );
    assert.strictEqual(
      (yield* claims.release(caller("node-a"), { ...oldLease, idempotencyKey: "release-old" }))
        .outcome,
      "stale",
    );
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("两个文件连接并发 claim 仍只有一个成功", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(directory, "ledger.sqlite");
      const a = Context.get(
        yield* FleetClaims.layerForTest(filename).pipe(Layer.build),
        FleetClaims.FleetClaims,
      );
      const b = Context.get(
        yield* FleetClaims.layerForTest(filename).pipe(Layer.build),
        FleetClaims.FleetClaims,
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      const results = yield* Effect.all(
        [
          a.claim(caller("node-a"), input("root", "a")),
          b.claim(caller("node-b"), input("root", "b")),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map((result) => result.outcome).toSorted(), [
        "already-held",
        "claimed",
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("一次心跳同时续上自己的租约并拒绝别人的", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const owned = yield* claims.claim(caller("node-a"), input("root", "claim-a"));
    const foreign = yield* claims.claim(caller("node-b"), input("child-1", "claim-b"));
    const result = yield* claims.heartbeat(
      "node-a",
      beat("node-a", [
        { taskId: "root", attempt: owned.claim!.attempt },
        { taskId: "child-1", attempt: 1 },
        { taskId: "missing", attempt: 1 },
      ]).input,
    );
    assert.deepEqual(
      result.results.map((item) => item.outcome),
      ["renewed", "not-owned", "not-claimed"],
    );
    const sql = yield* SqlClient.SqlClient;
    assert.strictEqual(
      (yield* sql<{ readonly lease_until: string }>`
        SELECT lease_until FROM node_claims WHERE task_id = 'child-1'
      `)[0]?.lease_until,
      foreign.claim?.leaseUntil,
    );
    assert.strictEqual(
      (yield* sql<{ readonly holder_environment: string }>`
        SELECT holder_environment FROM node_claims WHERE task_id = 'root'
      `)[0]?.holder_environment,
      "node-a",
    );
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("断开 60 秒不能抢，满 90 秒才能领，原机器再续期是 taken-over", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const held = yield* claims.claim(caller("node-a", "session-a"), input("root", "claim-a"));
    yield* TestClock.adjust("60 seconds");
    assert.strictEqual(
      (yield* claims.claim(caller("node-b"), input("root", "claim-b"))).outcome,
      "already-held",
    );
    yield* TestClock.adjust("30 seconds");
    const taken = yield* claims.claim(caller("node-b"), input("root", "claim-b"));
    assert.strictEqual(taken.outcome, "claimed");
    assert.strictEqual(taken.claim?.attempt, 2);
    const again = yield* claims.heartbeat(
      "node-a",
      beat("node-a", [{ taskId: "root", attempt: held.claim!.attempt }]).input,
    );
    assert.strictEqual(again.results[0]?.outcome, "taken-over");
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("89 秒发出、91 秒才到的心跳按服务端时钟算过期", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const sql = yield* SqlClient.SqlClient;
    const held = yield* claims.claim(caller("node-a"), input("root", "claim-a"));
    const before = (yield* sql<{ readonly lease_until: string }>`
      SELECT lease_until FROM node_claims WHERE task_id = 'root'
    `)[0]?.lease_until;
    yield* TestClock.adjust("89 seconds");
    const request = beat("node-a", [{ taskId: "root", attempt: held.claim!.attempt }]).input;
    yield* TestClock.adjust("2 seconds");
    const late = yield* claims.heartbeat("node-a", request);
    assert.strictEqual(late.results[0]?.outcome, "expired");
    assert.strictEqual(
      (yield* sql<{ readonly lease_until: string }>`
        SELECT lease_until FROM node_claims WHERE task_id = 'root'
      `)[0]?.lease_until,
      before,
    );
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("释放和伪造环境各有自己的结果，且不改租约", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const sql = yield* SqlClient.SqlClient;
    const held = yield* claims.claim(caller("node-a"), input("root", "claim-a"));
    yield* claims.claim(caller("node-b"), input("child-1", "claim-b"));
    yield* claims.release(caller("node-a"), input("root", "release-a", 1, held.claim!.fencing));
    const before =
      yield* sql`SELECT task_id, lease_until, attempt FROM node_claims ORDER BY task_id`;
    const released = yield* claims.heartbeat("node-a", {
      sequence: 5,
      leases: [{ repo: "example/one", issue: 7, taskId: "root", attempt: 1, fencing: "1" }],
    });
    assert.strictEqual(released.results[0]?.outcome, "released");
    const forged = yield* claims.heartbeat("node-c", {
      sequence: 6,
      leases: [{ repo: "example/one", issue: 7, taskId: "child-1", attempt: 1, fencing: "1" }],
    });
    assert.strictEqual(forged.results[0]?.outcome, "not-owned");
    assert.deepEqual(
      yield* sql`SELECT task_id, lease_until, attempt FROM node_claims ORDER BY task_id`,
      before,
    );
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("心跳不改 legacy 行，重放已释放的租约也不再续上", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const sql = yield* SqlClient.SqlClient;
    yield* NodeClaims.apply(
      sql,
      {
        action: "claim",
        repo: "example/one",
        issue: 8,
        title: "单 8",
        claimedBy: "pipeline",
        leaseUntil: "9999-01-01T00:00:00.000Z",
      },
      0,
    );
    const legacy = yield* claims.heartbeat("node-a", {
      sequence: 1,
      leases: [{ repo: "example/one", issue: 8, taskId: "root", attempt: 1, fencing: "1" }],
    });
    assert.strictEqual(legacy.results[0]?.outcome, "not-owned");
    assert.strictEqual(
      (yield* sql<{ readonly lease_until: string }>`
        SELECT lease_until FROM node_claims WHERE issue = 8
      `)[0]?.lease_until,
      "9999-01-01T00:00:00.000Z",
    );
    const held = yield* claims.claim(caller("node-a"), input("root", "claim-a"));
    yield* claims.heartbeat("node-a", beat("node-a", [{ taskId: "root", attempt: 1 }]).input);
    yield* claims.release(caller("node-a"), input("root", "release", 1, held.claim!.fencing));
    const replay = yield* claims.heartbeat(
      "node-a",
      beat("node-a", [{ taskId: "root", attempt: 1 }], 2).input,
    );
    assert.strictEqual(replay.results[0]?.outcome, "released");
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("旧 holder_environment=NULL 不再按 session 认领、续期或释放", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const sql = yield* SqlClient.SqlClient;
    yield* NodeClaims.apply(
      sql,
      {
        action: "claim",
        repo: "example/one",
        issue: 9,
        title: "单 9",
        claimedBy: "session-a",
        leaseUntil: "9999-01-01T00:00:00.000Z",
      },
      0,
    );
    const lease = input("root", "legacy", 1, "1");
    const sameSession = caller("node-a", "session-a");
    const claim = yield* claims.claim(sameSession, {
      ...lease,
      issue: 9,
      idempotencyKey: "claim-new",
    });
    assert.strictEqual(claim.outcome, "already-held");
    assert.strictEqual((yield* claims.renew(sameSession, { ...lease, issue: 9 })).outcome, "stale");
    assert.strictEqual(
      (yield* claims.release(sameSession, { ...lease, issue: 9 })).outcome,
      "stale",
    );
    assert.strictEqual(
      (yield* sql`SELECT holder_environment, state FROM node_claims WHERE issue = 9`)[0]
        ?.holder_environment,
      null,
    );
    assert.strictEqual(
      (yield* sql`SELECT holder_environment, state FROM node_claims WHERE issue = 9`)[0]?.state,
      "running",
    );
  }).pipe(Effect.provide(ledgerLayer)),
);
it.effect("claim 和 renew 使用服务端配置的 fleet lease TTL", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const claimed = yield* claims.claim(caller("node-a"), input("root", "claim-configured"));
    assert.strictEqual(claimed.claim?.leaseUntil, "1970-01-01T00:00:15.000Z");
    const renewed = yield* claims.renew(
      caller("node-a"),
      input("root", "renew-configured", claimed.claim!.attempt, claimed.claim!.fencing),
    );
    assert.strictEqual(renewed.claim?.leaseUntil, "1970-01-01T00:00:15.000Z");
  }).pipe(
    Effect.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
        }),
      ).pipe(Layer.provideMerge(FleetClaims.layerForTest(":memory:", "coordinator", 15_000))),
    ),
  ),
);
