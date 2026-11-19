import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as NodeClaims from "../ledger/nodeClaims.ts";
import * as NodeReads from "../ledger/nodeReads.ts";
import { EnvironmentId } from "@t3tools/contracts";
import * as FleetClaims from "../ledger/FleetClaims.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  PipelineIssuesIncompleteError,
  PipelineGitHubIssues,
  type PipelineIssue,
} from "./GitHubIssues.ts";
import {
  ClaimLeasePort,
  claimForRun,
  decodeLeaseToken,
  fleetPortLayer,
  layerPort,
  layerLive,
  registerRepos,
  releaseClaim,
  type ClaimAttempt,
  type ClaimWrite,
} from "./claimLease.ts";
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
  createdAt: "1970-01-01T00:00:00.000Z",
});

const pipelineLayer = <E, R>(claims: Layer.Layer<ClaimLeasePort, E, R>) =>
  runsLayer.pipe(
    Layer.provideMerge(claims),
    Layer.provide(
      Layer.mock(PipelineGitHubIssues)({
        listEligible: () => Effect.succeed([issue(7)]),
        read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
      }),
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

const testIdentity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(EnvironmentId.make("pipeline-env")),
});

const fleetLayer = fleetPortLayer.pipe(
  Layer.provideMerge(FleetClaims.layerShared),
  Layer.provide(testIdentity),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const runCount = Effect.gen(function* () {
  return (yield* (yield* PipelineRuns).list).runs.length;
});

const repoName = "thoerwink8/fleet-ade";

const durableLayer = <ClaimsE, E, R>(
  claims: Layer.Layer<ClaimLeasePort, ClaimsE, SqlClient.SqlClient>,
  sqlite: Layer.Layer<SqlClient.SqlClient, E, R>,
  enabled = true,
) =>
  runsLayer.pipe(
    Layer.provide(claims),
    Layer.provide(
      Layer.mock(PipelineGitHubIssues)({
        listEligible: () => Effect.succeed([issue(7)]),
        read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        PipelineUsage,
        PipelineUsage.of({ read: () => Effect.succeed([] as ReadonlyArray<UsageRecord>) }),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest({ pipelineEnabled: enabled })),
    Layer.provide(layerPortsDefault),
    Layer.provideMerge(sqlite),
  );

/** Test port. A token on the write is forwarded; finish can fail before the real writer runs. */
const recordingPort = (options: {
  readonly repos: ReadonlyArray<string>;
  readonly failFinish?: Ref.Ref<number>;
}) =>
  Layer.effect(
    ClaimLeasePort,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* NodeReads.migrate;
      for (const repo of options.repos) {
        const [owner, name] = repo.split("/");
        if (owner === undefined || name === undefined) continue;
        yield* sql`INSERT OR IGNORE INTO repos (owner, name) VALUES (${owner}, ${name})`;
      }
      const seen = yield* Ref.make<ReadonlyArray<ClaimAttempt>>([]);
      const apply = Effect.fn("claimLease.test.apply")(function* (write: ClaimWrite) {
        const failFinish = options.failFinish;
        if (
          write.action === "finish" &&
          failFinish !== undefined &&
          (yield* Ref.get(failFinish)) > 0
        ) {
          yield* Ref.update(failFinish, (count) => count - 1);
          const result = { status: 503, code: "local_claims_unreadable" } as const;
          yield* Ref.set(seen, [{ write, result }]);
          return result;
        }
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const claimedBy = "pipeline";
        const input: NodeClaims.ClaimInput =
          write.action === "claim"
            ? {
                action: "claim",
                repo: write.repo,
                issue: write.issue,
                title: write.title,
                claimedBy,
                leaseUntil: write.leaseUntil,
                token: write.token,
              }
            : write.action === "renew"
              ? {
                  action: "renew",
                  repo: write.repo,
                  issue: write.issue,
                  claimedBy,
                  leaseUntil: write.leaseUntil,
                }
              : {
                  action: "finish",
                  repo: write.repo,
                  issue: write.issue,
                  outcome: write.outcome,
                  reason: write.reason,
                  claimedBy,
                  token: write.token,
                };
        const result = yield* NodeClaims.apply(sql, input, nowMs).pipe(
          Effect.map((outcome) =>
            outcome.status === 200
              ? ({
                  status: 200,
                  code: "ok",
                  leaseUntil: outcome.leaseUntil,
                } as const)
              : outcome.code === "unknown_repo"
                ? ({ status: 404, code: "unknown_repo" } as const)
                : outcome.code === "not_claimed"
                  ? ({ status: 409, code: "not_claimed" } as const)
                  : ({ status: 409, code: "engine_has_it" } as const),
          ),
          Effect.catchCause(() =>
            Effect.succeed({ status: 503, code: "local_claims_unreadable" } as const),
          ),
        );
        yield* Ref.set(seen, [{ write, result }]);
        return result;
      });
      return ClaimLeasePort.of({
        apply,
        register: (repos) => registerRepos(sql, repos),
        attempts: Ref.get(seen),
      });
    }),
  );

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
    const claimed = first[0]?.write;
    assert.strictEqual(claimed?.action, "claim");
    if (claimed?.action === "claim") {
      assert.strictEqual(held[0]?.lease_until, claimed.leaseUntil);
    }
    const again = yield* claimForRun(port, {
      repo: "thoerwink8/fleet-ade",
      issue: 7,
      title: "单 7",
    });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(again.code, "engine_has_it");
    assert.strictEqual(yield* runCount, 1);
    const attempts = yield* port.attempts;
    assert.strictEqual(attempts.length, 1);
    assert.strictEqual(attempts[0]?.result.status, 409);
    assert.strictEqual((yield* sql`SELECT issue FROM node_claims`).length, 1);
  }).pipe(Effect.provide(pipelineLayer(layerPort()))),
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
  }).pipe(Effect.provide(pipelineLayer(layerPort()))),
);

it.effect("认领中的非 SQL 缺陷继续抛出，不转成 503", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const port = yield* ClaimLeasePort;
    const defect = new Error("claim transaction defect");
    using _transaction = vi
      .spyOn(sql, "withTransaction")
      .mockImplementation(() => Effect.die(defect));
    const result = yield* Effect.exit(
      claimForRun(port, { repo: repoName, issue: 7, title: "单 7" }),
    );
    assert(Exit.isFailure(result));
    assert.strictEqual(Cause.squash(result.cause), defect);
  }).pipe(Effect.provide(pipelineLayer(layerPort()))),
);

it.effect("生产认领走机群租约，令牌绑定租约后精确释放并可重领", () =>
  Effect.gen(function* () {
    const port = yield* ClaimLeasePort;
    yield* port.register(["example/one"]);
    const first = yield* claimForRun(port, { repo: "example/one", issue: 7, title: "单 7" });
    if (first.status !== 200) throw new Error(`first claim rejected: ${first.code}`);
    const held = decodeLeaseToken(first.token);
    assert.strictEqual(held.attempt, 1);
    assert.strictEqual(held.holderEnvironment, "pipeline-env");
    const contested = yield* claimForRun(port, { repo: "example/one", issue: 7, title: "单 7" });
    assert.strictEqual(contested.status, 409);
    const released = yield* releaseClaim(port, {
      repo: "example/one",
      issue: 7,
      token: first.token,
    });
    assert.strictEqual(released.status, 200);
    const repeated = yield* releaseClaim(port, {
      repo: "example/one",
      issue: 7,
      token: first.token,
    });
    assert.strictEqual(repeated.status, 409);
    const second = yield* claimForRun(port, { repo: "example/one", issue: 7, title: "单 7" });
    if (second.status !== 200) throw new Error(`second claim rejected: ${second.code}`);
    const reclaimed = decodeLeaseToken(second.token);
    assert.strictEqual(reclaimed.attempt, 2);
    const claims = yield* FleetClaims.FleetClaims;
    const heartbeat = yield* claims.heartbeat("pipeline-env", {
      sequence: 1,
      leases: [
        {
          repo: "example/one",
          issue: 7,
          taskId: "root",
          attempt: 2,
          fencing: reclaimed.fencing,
        },
      ],
    });
    assert.strictEqual(heartbeat.results[0]?.outcome, "renewed");
  }).pipe(Effect.provide(fleetLayer)),
);

it.effect("生产层按白名单登记仓：repos 空时监控启动认领成功", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const started = yield* runs.startSupervised({
          issueNumber: 7,
          repository: "thoerwink8/fleet-ade",
          controllerThreadId: "controller-a",
        });
        assert.strictEqual(started.status, "started");
        const ledger = NodeSqliteClient.layer({
          filename: path.join(config.stateDir, "ledger.sqlite"),
        });
        const repos = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly owner: string; readonly name: string }>`
            SELECT owner, name FROM repos
          `;
        }).pipe(Effect.provide(ledger));
        assert.deepEqual(repos, [{ owner: "thoerwink8", name: "fleet-ade" }]);
      }).pipe(Effect.provide(pipelineLayer(layerLive).pipe(Layer.provide(testIdentity))));
    }).pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("登记只跟白名单走：白名单外的仓认领仍是 unknown_repo", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const layer = pipelineLayer(layerLive).pipe(
      Layer.provide(testIdentity),
      Layer.provide(ServerConfig.layerTest(directory, directory)),
    );
    yield* Effect.gen(function* () {
      const port = yield* ClaimLeasePort;
      yield* (yield* PipelineRuns).tick;
      const other = yield* claimForRun(port, { repo: "acme/widgets", issue: 9, title: "单 9" });
      assert.strictEqual(other.status, 404);
      assert.strictEqual(other.code, "unknown_repo");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("监控启动把认领回来的 404 如实报成 unknown_repo", () =>
  Effect.gen(function* () {
    const started = yield* (yield* PipelineRuns).startSupervised({
      issueNumber: 7,
      repository: "thoerwink8/fleet-ade",
      controllerThreadId: "controller-a",
    });
    assert.deepStrictEqual(started, { status: "rejected", code: "unknown_repo" });
  }).pipe(
    Effect.provide(
      pipelineLayer(
        Layer.succeed(
          ClaimLeasePort,
          ClaimLeasePort.of({
            apply: () => Effect.succeed({ status: 404, code: "unknown_repo" } as const),
            register: () => Effect.void,
            attempts: Effect.succeed([]),
          }),
        ),
      ),
    ),
  ),
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
    if (write?.action === "claim") {
      assert.strictEqual(write.leaseUntil, "1970-01-01T02:00:00.000Z");
    }
    const listed = (yield* runs.list).runs[0];
    assert.notStrictEqual(listed, undefined);
    assert.strictEqual(Object.hasOwn(listed ?? {}, "leaseUntil"), false);
    const rows = yield* sql<Record<string, unknown>>`SELECT * FROM pipeline_runs`;
    const columns = Object.keys(rows[0] ?? {});
    assert.strictEqual(columns.includes("lease_until"), false);
    assert.strictEqual(columns.includes("leaseUntil"), false);
  }).pipe(Effect.provide(pipelineLayer(layerPort()))),
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
      }).pipe(Effect.provide(pipelineLayer(layerLive).pipe(Layer.provide(testIdentity))));
    }).pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("两小时后另一执行方重新认领，旧运行结束不删新租约", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    const port = yield* ClaimLeasePort;
    const sql = yield* SqlClient.SqlClient;
    yield* runs.tick;
    assert.strictEqual(yield* runCount, 1);
    const owned = yield* sql<{ readonly fencing: string | null }>`
      SELECT fencing FROM node_claims WHERE issue = 7
    `;
    const token = owned[0]?.fencing;
    yield* TestClock.adjust(Duration.millis(2 * 60 * 60_000 + 1));
    yield* sql`
      UPDATE node_claims SET claimed_by = 'other-node', lease_until = '9999-01-01T00:00:00.000Z'
      WHERE issue = 7
    `;
    yield* runs.note(7, { status: "merged" });
    const held = yield* sql<{ readonly claimed_by: string; readonly lease_until: string }>`
      SELECT claimed_by, lease_until FROM node_claims WHERE issue = 7
    `;
    assert.deepEqual(held, [{ claimed_by: "other-node", lease_until: "9999-01-01T00:00:00.000Z" }]);
    const released = (yield* port.attempts).at(-1);
    assert.strictEqual(released?.write.action, "finish");
    if (released?.write.action === "finish") {
      assert.strictEqual(released.write.outcome, "released");
      assert.strictEqual(released.write.token, token);
      assert.strictEqual(Object.hasOwn(released.write, "leaseUntil"), false);
    }
  }).pipe(Effect.provide(pipelineLayer(layerPort()).pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect("释放 503 后下一 tick 即使管道关掉也放掉原租约", () =>
  Effect.gen(function* () {
    const failFinish = yield* Ref.make(1);
    yield* Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* runs.tick;
      yield* runs.note(7, { status: "merged" });
      assert.strictEqual((yield* sql`SELECT issue FROM node_claims`).length, 1);
      yield* settings.updateSettings({ pipelineEnabled: false });
      yield* runs.tick;
      assert.deepEqual(yield* sql`SELECT issue FROM node_claims`, []);
    }).pipe(
      Effect.provide(
        durableLayer(
          recordingPort({ repos: [repoName], failFinish }),
          SqlitePersistence.layerMemory,
        ),
      ),
    );
  }),
);

it.effect("认领后重启再记终态仍释放；取消遇 503 后关管道也能放掉", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const sqlite = SqlitePersistence.layerFromPath(path.join(directory, "pipeline.sqlite"));
    const claims = recordingPort({ repos: [repoName] });
    yield* Effect.gen(function* () {
      yield* (yield* PipelineRuns).tick;
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual((yield* sql`SELECT fencing FROM node_claims WHERE issue = 7`).length, 1);
    }).pipe(Effect.provide(durableLayer(claims, sqlite)));
    yield* Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      const sql = yield* SqlClient.SqlClient;
      yield* runs.note(7, { status: "merged" });
      assert.deepEqual(yield* sql`SELECT issue FROM node_claims`, []);
    }).pipe(Effect.provide(durableLayer(claims, sqlite)));
    const failFinish = yield* Ref.make(1);
    yield* Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      const sql = yield* SqlClient.SqlClient;
      yield* runs.tick;
      yield* runs.note(7, { status: "stuck", stuckReason: "取消" });
      assert.strictEqual((yield* sql`SELECT issue FROM node_claims`).length, 1);
    }).pipe(Effect.provide(durableLayer(recordingPort({ repos: [repoName], failFinish }), sqlite)));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* PipelineRuns).tick;
      assert.deepEqual(yield* sql`SELECT issue FROM node_claims`, []);
    }).pipe(Effect.provide(durableLayer(recordingPort({ repos: [repoName] }), sqlite, false)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("同持有者换 token 时不删新租约，之后 tick 也不删", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    const port = yield* ClaimLeasePort;
    const sql = yield* SqlClient.SqlClient;
    yield* runs.tick;
    yield* sql`UPDATE node_claims SET fencing = 'other-token' WHERE issue = 7`;
    yield* runs.note(7, { status: "merged" });
    const held = yield* sql<{ readonly claimed_by: string; readonly fencing: string | null }>`
      SELECT claimed_by, fencing FROM node_claims WHERE issue = 7
    `;
    assert.deepEqual(held, [{ claimed_by: "pipeline", fencing: "other-token" }]);
    const released = (yield* port.attempts).at(-1);
    assert.strictEqual(released?.write.action, "finish");
    assert.strictEqual(released?.result.status, 409);
    assert.strictEqual(released?.result.code, "not_claimed");
    yield* runs.tick;
    assert.deepEqual(yield* sql`SELECT claimed_by, fencing FROM node_claims WHERE issue = 7`, [
      { claimed_by: "pipeline", fencing: "other-token" },
    ]);
  }).pipe(Effect.provide(pipelineLayer(layerPort()))),
);

it.effect("新持有者时结束运行返回 not_claimed，之后 tick 也不删", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    const port = yield* ClaimLeasePort;
    const sql = yield* SqlClient.SqlClient;
    yield* runs.tick;
    yield* sql`
      UPDATE node_claims
      SET claimed_by = 'other-node', fencing = 'other-token', lease_until = '9999-01-01T00:00:00.000Z'
      WHERE issue = 7
    `;
    yield* runs.note(7, { status: "merged" });
    const held = yield* sql<{
      readonly claimed_by: string;
      readonly fencing: string | null;
      readonly lease_until: string;
    }>`
      SELECT claimed_by, fencing, lease_until FROM node_claims WHERE issue = 7
    `;
    assert.deepEqual(held, [
      { claimed_by: "other-node", fencing: "other-token", lease_until: "9999-01-01T00:00:00.000Z" },
    ]);
    const released = (yield* port.attempts).at(-1);
    assert.strictEqual(released?.result.status, 409);
    assert.strictEqual(released?.result.code, "not_claimed");
    yield* runs.tick;
    assert.deepEqual(
      yield* sql`SELECT claimed_by, fencing, lease_until FROM node_claims WHERE issue = 7`,
      [
        {
          claimed_by: "other-node",
          fencing: "other-token",
          lease_until: "9999-01-01T00:00:00.000Z",
        },
      ],
    );
  }).pipe(Effect.provide(pipelineLayer(layerPort()))),
);

it.effect("认领写进运行失败时放掉刚拿的租约", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TRIGGER pipeline_runs_insert_fails
      BEFORE INSERT ON pipeline_runs
      BEGIN
        SELECT RAISE(ABORT, 'insert failed');
      END
    `;
    yield* Effect.exit((yield* PipelineRuns).tick);
    assert.deepEqual(yield* sql`SELECT issue FROM node_claims`, []);
  }).pipe(Effect.provide(pipelineLayer(layerPort()))),
);
