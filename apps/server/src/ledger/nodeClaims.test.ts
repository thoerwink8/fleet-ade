import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeClaims from "./nodeClaims.ts";
import * as NodeReads from "./nodeReads.ts";

const repo = "thoerwink8/fleet-ade";
const leaseUntil = "1970-01-01T02:00:00.000Z";

const withLedger = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* NodeReads.migrate;
  yield* sql`INSERT INTO repos (owner, name) VALUES ('thoerwink8', 'fleet-ade')`;
  return sql;
});

it.effect("claim 把 token 写进 fencing；不带 token 则 fencing 为空", () =>
  Effect.gen(function* () {
    const sql = yield* seed;
    const claimed = yield* NodeClaims.apply(
      sql,
      {
        action: "claim",
        repo,
        issue: 7,
        title: "单 7",
        claimedBy: "pipeline",
        leaseUntil,
        token: "token-a",
      } as NodeClaims.ClaimInput,
      0,
    );
    assert.strictEqual(claimed.status, 200);
    assert.deepEqual(yield* sql`SELECT fencing FROM node_claims WHERE issue = 7`, [
      { fencing: "token-a" },
    ]);
    const plain = yield* NodeClaims.apply(
      sql,
      {
        action: "claim",
        repo,
        issue: 8,
        title: "单 8",
        claimedBy: "node-a",
        leaseUntil,
      },
      0,
    );
    assert.strictEqual(plain.status, 200);
    assert.deepEqual(yield* sql`SELECT fencing FROM node_claims WHERE issue = 8`, [
      { fencing: null },
    ]);
  }).pipe(withLedger),
);

it.effect("finish 的 token 不匹配则 409，再试一次也不删；对上才删", () =>
  Effect.gen(function* () {
    const sql = yield* seed;
    yield* sql`
      INSERT INTO node_claims (repo, issue, claimed_by, lease_until, executor, state, fencing)
      VALUES (${repo}, 7, 'pipeline', ${leaseUntil}, 'local', 'running', 'token-a')
    `;
    const denied = yield* NodeClaims.apply(
      sql,
      {
        action: "finish",
        repo,
        issue: 7,
        outcome: "released",
        claimedBy: "pipeline",
        token: "token-b",
      } as NodeClaims.ClaimInput,
      0,
    );
    assert.strictEqual(denied.status, 409);
    assert.strictEqual(denied.code, "not_claimed");
    const again = yield* NodeClaims.apply(
      sql,
      {
        action: "finish",
        repo,
        issue: 7,
        outcome: "released",
        claimedBy: "pipeline",
        token: "token-b",
      } as NodeClaims.ClaimInput,
      0,
    );
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.code, "not_claimed");
    assert.deepEqual(yield* sql`SELECT claimed_by, fencing FROM node_claims WHERE issue = 7`, [
      { claimed_by: "pipeline", fencing: "token-a" },
    ]);
    const released = yield* NodeClaims.apply(
      sql,
      {
        action: "finish",
        repo,
        issue: 7,
        outcome: "released",
        claimedBy: "pipeline",
        token: "token-a",
      } as NodeClaims.ClaimInput,
      0,
    );
    assert.strictEqual(released.status, 200);
    assert.deepEqual(yield* sql`SELECT issue FROM node_claims WHERE issue = 7`, []);
  }).pipe(withLedger),
);

it.effect("新持有者即使 fencing 相同也不删；不带 token 的 finish 仍按持有者删除", () =>
  Effect.gen(function* () {
    const sql = yield* seed;
    yield* sql`
      INSERT INTO node_claims (repo, issue, claimed_by, lease_until, executor, state, fencing)
      VALUES
        (${repo}, 7, 'other-node', ${leaseUntil}, 'local', 'running', 'token-a'),
        (${repo}, 8, 'node-a', ${leaseUntil}, 'local', 'running', 'kept')
    `;
    const denied = yield* NodeClaims.apply(
      sql,
      {
        action: "finish",
        repo,
        issue: 7,
        outcome: "released",
        claimedBy: "pipeline",
        token: "token-a",
      } as NodeClaims.ClaimInput,
      0,
    );
    assert.strictEqual(denied.status, 409);
    assert.strictEqual(denied.code, "not_claimed");
    assert.deepEqual(yield* sql`SELECT claimed_by FROM node_claims WHERE issue = 7`, [
      { claimed_by: "other-node" },
    ]);
    const httpFinish = yield* NodeClaims.apply(
      sql,
      {
        action: "finish",
        repo,
        issue: 8,
        outcome: "done",
        claimedBy: "node-a",
      },
      0,
    );
    assert.strictEqual(httpFinish.status, 200);
    assert.deepEqual(yield* sql`SELECT issue FROM node_claims WHERE issue = 8`, []);
    assert.deepEqual(yield* sql`SELECT issue FROM node_claims WHERE issue = 7`, [{ issue: 7 }]);
  }).pipe(withLedger),
);
