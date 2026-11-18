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

const input = (taskId: string, idempotencyKey: string, attempt = 1, fencing = "1") => ({
  repo: "example/one",
  issue: 7,
  taskId,
  attempt,
  fencing,
  idempotencyKey,
});

it.effect("同一键两台机器并发 claim 只有一个成功", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const results = yield* Effect.all(
      [
        claims.claim("node-a", input("root", "claim-a")),
        claims.claim("node-b", input("root", "claim-b")),
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
    const first = yield* claims.claim("node-a", input("root", "claim-a"));
    const second = yield* claims.claim("node-b", input("root", "claim-b"));
    assert.strictEqual(first.outcome, "claimed");
    assert.strictEqual(second.outcome, "already-held");
    assert.strictEqual(second.claim, null);
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("同仓不同 taskId 和不同仓可同时成功", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const root = yield* claims.claim("node-a", input("root", "claim-root"));
    const child = yield* claims.claim("node-b", input("child-1", "claim-child"));
    const other = yield* claims.claim("node-c", {
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
    const canonical = yield* claims.claim("node-a", {
      ...input("root", "claim-a"),
      repo: "EXAMPLE/ONE",
    });
    assert.strictEqual(canonical.claim?.repo, "example/one");
    assert.strictEqual(
      (yield* claims.claim("node-b", input("root", "claim-b"))).outcome,
      "already-held",
    );
    const malformed = yield* claims
      .claim("node-c", { ...input("root", "bad"), repo: "example/one/" })
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
      (yield* claims.claim("node-a", input("root", "fleet"))).outcome,
      "already-held",
    );
    yield* sql`DELETE FROM node_claims`;
    yield* claims.claim("node-a", input("root", "fleet"));
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
    const first = yield* claims.claim("node-a", input("root", "claim-a"));
    const held = yield* claims.claim("node-a", input("root", "claim-b"));
    assert.strictEqual(held.outcome, "already-held");
    assert.deepEqual(held.claim, first.claim);
    yield* claims.release("node-a", input("root", "release-a", 1, first.claim!.fencing));
    assert.strictEqual((yield* claims.claim("node-a", input("root", "claim-a"))).outcome, "stale");
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("renew 重放只在当前租约仍运行且未过期时幂等", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const claimed = yield* claims.claim("node-a", input("root", "claim-a"));
    const lease = input("root", "renew-a", 1, claimed.claim!.fencing);
    const renewed = yield* claims.renew("node-a", lease);
    yield* TestClock.adjust("10 seconds");
    assert.deepEqual(yield* claims.renew("node-a", lease), renewed);
    yield* claims.release("node-a", { ...lease, idempotencyKey: "release-a" });
    assert.strictEqual((yield* claims.renew("node-a", lease)).outcome, "stale");
    assert.strictEqual(
      (yield* claims.release("node-a", { ...lease, idempotencyKey: "release-a" })).outcome,
      "stale",
    );
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("旧 attempt 不能修改新 attempt，fencing 随 attempt 递增", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const first = yield* claims.claim("node-a", input("root", "claim-a"));
    assert.strictEqual(first.claim?.fencing, "1");
    const oldLease = input("root", "release-a", 1, first.claim!.fencing);
    yield* claims.release("node-a", oldLease);
    const second = yield* claims.claim("node-b", input("root", "claim-b"));
    assert.strictEqual(second.claim?.attempt, 2);
    assert.strictEqual(second.claim?.fencing, "2");
    assert.strictEqual(
      (yield* claims.renew("node-a", { ...oldLease, idempotencyKey: "renew-old" })).outcome,
      "stale",
    );
    assert.strictEqual(
      (yield* claims.release("node-a", { ...oldLease, idempotencyKey: "release-old" })).outcome,
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
        [a.claim("node-a", input("root", "a")), b.claim("node-b", input("root", "b"))],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map((result) => result.outcome).toSorted(), [
        "already-held",
        "claimed",
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
