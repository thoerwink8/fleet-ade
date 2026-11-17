import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as NodeReads from "../ledger/nodeReads.ts";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  PipelineIssuesIncompleteError,
  PipelineGitHubIssues,
  type PipelineIssue,
} from "./GitHubIssues.ts";
import { ClaimLeasePort, claimForRun, layerPort, layerLive } from "./claimLease.ts";
import {
  PipelineRuns,
  PipelineUsage,
  layer as runsLayer,
  type UsageRecord,
} from "./PipelineRuns.ts";
import { layerPortsDefault } from "./intakeGates.ts";

const acceptance = `## 怎么算做完
- 跑通测试
`;

const issue = (number: number, title = `单 ${number}`): PipelineIssue => ({
  number,
  title,
  body: acceptance,
  labels: ["交给 ADE"],
  author: { login: "thoerwink8", id: 1, type: "User" },
});

const pipelineLayer = <E, R>(claims: Layer.Layer<ClaimLeasePort, E, R>) =>
  runsLayer.pipe(
    Layer.provideMerge(claims),
    Layer.provide(
      Layer.succeed(
        PipelineGitHubIssues,
        PipelineGitHubIssues.of({
          listEligible: () => Effect.succeed([issue(7)]),
          read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        PipelineUsage,
        PipelineUsage.of({ read: () => Effect.succeed([] as ReadonlyArray<UsageRecord>) }),
      ),
    ),
    Layer.provide(ServerSettings.layerTest({ pipelineEnabled: true })),
    Layer.provide(layerPortsDefault),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const runCount = Effect.gen(function* () {
  return (yield* (yield* PipelineRuns).list).runs.length;
});

it.effect("第一次认领成功才有一条运行；同一仓同一单第二次是 409，运行仍是一条", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    const port = yield* ClaimLeasePort;
    const sql = yield* SqlClient.SqlClient;
    yield* runs.tick;
    assert.strictEqual(yield* runCount, 1);
    const first = yield* port.attempts;
    const held = yield* sql<{
      readonly repo: string;
      readonly issue: number;
      readonly lease_until: string;
    }>`SELECT repo, issue, lease_until FROM node_claims`;
    assert.strictEqual(held.length, 1);
    assert.strictEqual(held[0]?.repo, "thoerwink8/fleet-ade");
    assert.strictEqual(held[0]?.issue, 7);
    assert.strictEqual(held[0]?.lease_until, first[0]?.write.leaseUntil);
    const again = yield* claimForRun(port, {
      repo: "thoerwink8/fleet-ade",
      issue: 7,
      title: "单 7",
    });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.code, "engine_has_it");
    assert.strictEqual(yield* runCount, 1);
    const attempts = yield* port.attempts;
    assert.strictEqual(attempts[0]?.result.status, 200);
    assert.strictEqual(attempts[1]?.result.status, 409);
    assert.strictEqual((yield* sql`SELECT issue FROM node_claims`).length, 1);
  }).pipe(Effect.provide(pipelineLayer(layerPort({ repos: ["thoerwink8/fleet-ade"] })))),
);

it.effect("端口回 503 时不建运行", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    const port = yield* ClaimLeasePort;
    yield* runs.tick;
    const attempts = yield* port.attempts;
    assert.strictEqual(attempts[0]?.result.status, 503);
    assert.strictEqual(attempts[0]?.result.code, "local_claims_not_wired");
    assert.strictEqual(yield* runCount, 0);
  }).pipe(Effect.provide(pipelineLayer(layerPort({ wired: false })))),
);

it.effect("账本租约读失败回 503，不建运行也不覆盖原租约", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE node_claims`;
    yield* (yield* PipelineRuns).tick;
    const attempts = yield* (yield* ClaimLeasePort).attempts;
    assert.strictEqual(attempts[0]?.result.status, 503);
    assert.strictEqual(attempts[0]?.result.code, "local_claims_unreadable");
    assert.strictEqual(yield* runCount, 0);
  }).pipe(Effect.provide(pipelineLayer(layerPort({ repos: ["thoerwink8/fleet-ade"] })))),
);

it.effect("未登记仓回 404 时不建运行", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    const port = yield* ClaimLeasePort;
    yield* runs.tick;
    const attempts = yield* port.attempts;
    assert.strictEqual(attempts[0]?.result.status, 404);
    assert.strictEqual(attempts[0]?.result.code, "unknown_repo");
    assert.strictEqual(yield* runCount, 0);
  }).pipe(Effect.provide(pipelineLayer(layerPort({ repos: [] })))),
);

it.effect("leaseUntil 只出现在 claims 端口的写入参数里，不写进运行记录的字段", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    const port = yield* ClaimLeasePort;
    const sql = yield* SqlClient.SqlClient;
    yield* runs.tick;
    const attempts = yield* port.attempts;
    const write = attempts[0]?.write;
    assert.strictEqual(write?.action, "claim");
    assert.strictEqual(write?.repo, "thoerwink8/fleet-ade");
    assert.strictEqual(write?.issue, 7);
    assert.strictEqual(write?.leaseUntil, "1970-01-01T02:00:00.000Z");
    const listed = (yield* runs.list).runs[0];
    assert.notStrictEqual(listed, undefined);
    assert.strictEqual(Object.hasOwn(listed ?? {}, "leaseUntil"), false);
    const rows = yield* sql<Record<string, unknown>>`SELECT * FROM pipeline_runs`;
    const columns = Object.keys(rows[0] ?? {});
    assert.strictEqual(columns.includes("lease_until"), false);
    assert.strictEqual(columns.includes("leaseUntil"), false);
  }).pipe(Effect.provide(pipelineLayer(layerPort({ repos: ["thoerwink8/fleet-ade"] })))),
);

it.effect("账本已有租约阻止建运行，成功认领对独立账本连接可见，主库不建租约表", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const ledger = NodeSqliteClient.layer({
        filename: path.join(config.stateDir, "ledger.sqlite"),
      });
      yield* Effect.gen(function* () {
        yield* NodeReads.migrate;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO repos (owner, name) VALUES ('thoerwink8', 'fleet-ade')`;
        yield* sql`INSERT INTO node_claims (repo, issue, claimed_by, lease_until)
          VALUES ('thoerwink8/fleet-ade', 7, 'other-node', '9999-01-01T00:00:00.000Z')`;
      }).pipe(Effect.provide(ledger));
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        yield* runs.tick;
        assert.strictEqual(yield* runCount, 0);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM node_claims`;
        }).pipe(Effect.provide(ledger));
        yield* runs.tick;
        assert.strictEqual(yield* runCount, 1);
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT name FROM sqlite_master WHERE name = 'node_claims'`, []);
        const held = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT issue, lease_until FROM node_claims`;
        }).pipe(Effect.provide(ledger));
        assert.deepEqual(held, [{ issue: 7, lease_until: "1970-01-01T02:00:00.000Z" }]);
      }).pipe(Effect.provide(pipelineLayer(layerLive)));
    }).pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
