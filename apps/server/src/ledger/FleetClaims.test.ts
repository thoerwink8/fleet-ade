import { assert, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as FleetClaims from "./FleetClaims.ts";

const ledgerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one'), ('other', 'repo')`;
  }),
).pipe(Layer.provideMerge(FleetClaims.layerForTest));

const withLedger = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(ledgerLayer));

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
    const a = yield* claims.claim(input("root", "node-a", "key-a"));
    const b = yield* claims.claim(input("root", "node-b", "key-b"));
    assert.strictEqual(a.outcome, "claimed");
    assert.strictEqual(b.outcome, "already-held");
  }).pipe(withLedger),
);

it.effect("不同仓和不同 taskId 可同时成功", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const a = yield* claims.claim({ ...input("root", "node-a", "key-a"), repo: "other/repo" });
    const b = yield* claims.claim(input("sub-task-1", "node-b", "key-b"));
    assert.strictEqual(a.outcome, "claimed");
    assert.strictEqual(b.outcome, "claimed");
  }).pipe(withLedger),
);

it.effect("旧 attempt 的 renew/release 不能修改新 attempt", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const first = yield* claims.claim(input("root", "node-a", "key-a"));
    assert.strictEqual(first.outcome, "claimed");
    const staleRenew = yield* claims.renew(input("root", "node-a", "key-a", 0, "wrong-fence"));
    assert.strictEqual(staleRenew.outcome, "stale");
    const staleRelease = yield* claims.release(input("root", "node-a", "key-a", 0, "wrong-fence"));
    assert.strictEqual(staleRelease.outcome, "stale");
    const validRelease = yield* claims.release(
      input("root", "node-a", "key-a", 1, first.claim!.fencing),
    );
    assert.strictEqual(validRelease.outcome, "released");
  }).pipe(withLedger),
);

it.effect("release 后另一台可领", () =>
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const a = yield* claims.claim(input("root", "node-a", "key-a"));
    yield* claims.release(input("root", "node-a", "key-a", 1, a.claim!.fencing));
    const b = yield* claims.claim(input("root", "node-b", "key-b"));
    assert.strictEqual(b.outcome, "claimed");
    assert.strictEqual(b.claim!.holder, "node-b");
  }).pipe(withLedger),
);
