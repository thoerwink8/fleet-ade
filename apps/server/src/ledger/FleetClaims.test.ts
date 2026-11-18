import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as FleetClaims from "./FleetClaims.ts";

const ledgerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one'), ('other', 'repo')`;
  }),
).pipe(Layer.provideMerge(FleetClaims.layerForTest));

const input = (
  taskId: string,
  holder: string,
  idempotencyKey: string,
  attempt = 1,
  fencing = "fence",
) => ({
  fleetId: "fleet-a",
  repo: "example/one",
  issue: 7,
  taskId,
  holder,
  attempt,
  fencing,
  idempotencyKey,
});

it.effect("同一键两台机器并发 claim 只有一个成功", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const results = yield* Effect.all(
      [
        claims.claim(input("root", "node-a", "claim-a")),
        claims.claim(input("root", "node-b", "claim-b")),
      ],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(results.map((result) => result.outcome).toSorted(), [
      "already-held",
      "claimed",
    ]);
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("同仓不同 taskId 和不同仓可同时成功", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const root = yield* claims.claim(input("root", "node-a", "claim-root"));
    const child = yield* claims.claim(input("child-1", "node-b", "claim-child"));
    const other = yield* claims.claim({
      ...input("root", "node-c", "claim-other"),
      repo: "other/repo",
    });
    assert.strictEqual(root.outcome, "claimed");
    assert.strictEqual(child.outcome, "claimed");
    assert.strictEqual(other.outcome, "claimed");
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("claim 重试返回第一次结果", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const first = yield* claims.claim(input("root", "node-a", "claim-a"));
    yield* TestClock.adjust("10 seconds");
    const retry = yield* claims.claim(input("root", "node-a", "claim-a"));
    assert.deepEqual(retry, first);
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("renew 和 release 重试返回第一次结果", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const claimed = yield* claims.claim(input("root", "node-a", "claim-a"));
    const lease = input("root", "node-a", "renew-a", 1, claimed.claim!.fencing);
    const renewed = yield* claims.renew(lease);
    yield* TestClock.adjust("10 seconds");
    assert.deepEqual(yield* claims.renew(lease), renewed);
    const release = { ...lease, idempotencyKey: "release-a" };
    const released = yield* claims.release(release);
    assert.deepEqual(yield* claims.release(release), released);
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("旧 attempt 的 renew 和 release 不能修改新 attempt", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const first = yield* claims.claim(input("root", "node-a", "claim-a"));
    const oldLease = input("root", "node-a", "release-a", 1, first.claim!.fencing);
    assert.strictEqual((yield* claims.release(oldLease)).outcome, "released");
    const second = yield* claims.claim(input("root", "node-b", "claim-b"));
    assert.strictEqual(second.claim?.attempt, 2);
    assert.strictEqual(
      (yield* claims.renew({ ...oldLease, idempotencyKey: "renew-old" })).outcome,
      "stale",
    );
    assert.strictEqual(
      (yield* claims.release({ ...oldLease, idempotencyKey: "release-old" })).outcome,
      "stale",
    );
    assert.strictEqual(
      (yield* claims.renew(input("root", "node-b", "renew-b", 2, second.claim!.fencing))).outcome,
      "renewed",
    );
  }).pipe(Effect.provide(ledgerLayer)),
);

it.effect("到期后下一台机器获得递增 attempt", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    yield* claims.claim(input("root", "node-a", "claim-a"));
    yield* TestClock.adjust("91 seconds");
    const next = yield* claims.claim(input("root", "node-b", "claim-b"));
    assert.strictEqual(next.outcome, "claimed");
    assert.strictEqual(next.claim?.attempt, 2);
  }).pipe(Effect.provide(ledgerLayer)),
);
