import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PullRequestAdditions, layer as budgetLayer, layerLive as budgetLive } from "./budget.ts";
import { PipelineGitHubIssues, type PipelineIssue } from "./GitHubIssues.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
import { layerPortsDefault } from "./intakeGates.ts";
import * as ClaimLease from "./claimLease.ts";
import {
  MergeGate,
  MergeGateReadError,
  MergeGateReader,
  MergeRequestError,
  PullRequestMerger,
  decideMerge,
  workflowChecks,
  layer,
  layerLive,
  type MergeGateDecision,
  type MergeGateFacts,
  type MergeGateObservation,
} from "./mergeGate.ts";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const issue = (number: number): PipelineIssue => ({
  number,
  title: `单 ${number}`,
  body: "## 怎么算做完\n- 跑通测试\n",
  labels: ["交给 ADE"],
  author: { login: "thoerwink8", id: 1, type: "User" },
});

interface MergeCall {
  readonly number: number;
  readonly headSha: string;
  readonly repository: string;
}

const passing = (autoMerge: boolean): MergeGateFacts => ({
  headSha: HEAD,
  checks: [{ name: "CI", state: "success", sha: HEAD }],
  coldVerify: { state: "success", sha: HEAD },
  paths: ["apps/server/src/pipeline/mergeGate.ts"],
  autoMerge,
});

const hold: MergeGateDecision = { kind: "hold" };

const cases: ReadonlyArray<{
  readonly name: string;
  readonly facts: MergeGateFacts;
  readonly decision: MergeGateDecision;
}> = [
  {
    name: "CI 不是成功，不合",
    facts: { ...passing(true), checks: [{ name: "CI", state: "failure", sha: HEAD }] },
    decision: hold,
  },
  {
    name: "没有 CI 检查，不合",
    facts: { ...passing(true), checks: [{ name: "CI", state: "missing", sha: null }] },
    decision: hold,
  },
  {
    name: "CI 成功但是另一个头，不合",
    facts: { ...passing(true), checks: [{ name: "CI", state: "success", sha: OLD_HEAD }] },
    decision: hold,
  },
  {
    name: "cold-verify 不是 success，不合",
    facts: { ...passing(true), coldVerify: { state: "failure", sha: HEAD } },
    decision: hold,
  },
  {
    name: "cold-verify 在旧头上，不合",
    facts: { ...passing(true), coldVerify: { state: "success", sha: OLD_HEAD } },
    decision: hold,
  },
  {
    name: "状态没写上，不合",
    facts: { ...passing(true), coldVerify: { state: "missing", sha: null } },
    decision: hold,
  },
  {
    name: "只改 .github/workflows/ci.yml 仍是交人",
    facts: { ...passing(true), paths: [".github/workflows/ci.yml"] },
    decision: { kind: "stuck", reason: "交人" },
  },
  {
    name: "当前头上有一项检查不叫 CI、状态不是 success，结果不可合",
    facts: {
      ...passing(true),
      checks: [
        { name: "CI", state: "success", sha: HEAD },
        { name: "lint", state: "failure", sha: HEAD },
      ],
    },
    decision: hold,
  },
  {
    name: "该项与名为 CI 的检查都是 success，且 cold-verify 为 success，结果可合",
    facts: {
      ...passing(false),
      checks: [
        { name: "CI", state: "success", sha: HEAD },
        { name: "lint", state: "success", sha: HEAD },
      ],
    },
    decision: { kind: "mergeable" },
  },
  {
    name: "diff 含 AGENTS.md 时结果是交人，不是可合",
    facts: { ...passing(true), paths: ["AGENTS.md"] },
    decision: { kind: "stuck", reason: "交人" },
  },
  {
    name: "diff 含 docs/internals/overview.md 时结果是交人，不是可合",
    facts: { ...passing(true), paths: ["docs/internals/overview.md"] },
    decision: { kind: "stuck", reason: "交人" },
  },
  {
    name: "改名前的名字落进清单，交人，不是可合",
    facts: { ...passing(true), paths: ["src/renamed.ts", "AGENTS.md"] },
    decision: { kind: "stuck", reason: "交人" },
  },
  {
    name: "只改 apps/web/src/components/ChatView.tsx 不因此交人",
    facts: { ...passing(false), paths: ["apps/web/src/components/ChatView.tsx"] },
    decision: { kind: "mergeable" },
  },
  {
    name: "都过且自动合关着，停在可合，不调合并",
    facts: passing(false),
    decision: { kind: "mergeable" },
  },
  {
    name: "受监督的运行没有当前头的接受结论时不可合",
    facts: {
      ...passing(false),
      supervised: true,
      controllerVerdict: null,
      acceptedHeadSha: null,
    },
    decision: hold,
  },
  {
    name: "受监督的运行接受的是别的头时不可合",
    facts: {
      ...passing(false),
      supervised: true,
      controllerVerdict: "accepted",
      acceptedHeadSha: OLD_HEAD,
    },
    decision: hold,
  },
  {
    name: "受监督的运行接受了当前头，自动合开着也只停在可合",
    facts: {
      ...passing(true),
      supervised: true,
      controllerVerdict: "accepted",
      acceptedHeadSha: HEAD,
    },
    decision: { kind: "mergeable" },
  },
  {
    name: "受监督的运行被拒绝时不可合",
    facts: {
      ...passing(true),
      supervised: true,
      controllerVerdict: "rejected",
      acceptedHeadSha: null,
    },
    decision: hold,
  },
];

describe("decideMerge", () => {
  it.effect.each(cases)("$name", (row) =>
    Effect.sync(() => {
      assert.deepStrictEqual(decideMerge(row.facts), row.decision);
    }),
  );

  it.effect("都过且自动合开着，调一次合并", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(decideMerge(passing(true)), { kind: "merge" });
    }),
  );

  it.effect("pending 不算通过", () =>
    Effect.sync(() => {
      const pending: MergeGateFacts["checks"][number] = {
        name: "CI",
        state: "pending",
        sha: HEAD,
      };
      assert.strictEqual(decideMerge({ ...passing(true), checks: [pending] }).kind, "hold");
      assert.strictEqual(
        decideMerge({ ...passing(true), coldVerify: { state: "pending", sha: HEAD } }).kind,
        "hold",
      );
    }),
  );

  it.effect("清单读不到时结果是没查成，不是可合", () =>
    Effect.sync(() => {
      const decision = decideMerge(
        { ...passing(true), paths: ["apps/web/src/components/ChatView.tsx"] },
        () => {
          throw new Error("ENOENT");
        },
      );
      assert.deepStrictEqual(decision, { kind: "unread", detail: "没查成" });
      assert.notStrictEqual(decision.kind, "merge");
      assert.notStrictEqual(decision.kind, "mergeable");
    }),
  );
});

const gateLayer = (input: {
  readonly autoMerge: boolean;
  readonly enabled?: boolean;
  readonly observe: (headSha: string) => Effect.Effect<MergeGateObservation, MergeGateReadError>;
  readonly merge: (call: MergeCall) => Effect.Effect<void, MergeRequestError>;
  readonly calls: Ref.Ref<ReadonlyArray<MergeCall>>;
  readonly read?: MergeGateReader["Service"]["read"];
}) => {
  const settings = ServerSettings.layerTest({
    pipelineEnabled: input.enabled ?? true,
    pipelineAutoMerge: input.autoMerge,
  });
  const runs = runsLayer.pipe(
    Layer.provide(
      Layer.succeed(PipelineGitHubIssues, {
        addLabel: () => Effect.die("unexpected label write"),
        listEligible: () => Effect.succeed([issue(9)]),
        read: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(Layer.succeed(PipelineUsage, { read: () => Effect.succeed([]) })),
    Layer.provide(settings),
    Layer.provide(layerPortsDefault),
    Layer.provide(ClaimLease.layerPort({ repos: ["thoerwink8/fleet-ade"] })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const reader = Layer.succeed(MergeGateReader, {
    read: input.read ?? ((entry) => input.observe(entry.headSha)),
  });
  const merger = Layer.succeed(PullRequestMerger, {
    merge: (entry) =>
      Ref.update(input.calls, (calls) => [...calls, entry]).pipe(
        Effect.flatMap(() => input.merge(entry)),
      ),
  });
  return layer.pipe(
    Layer.provide(budgetLayer),
    Layer.provide(Layer.succeed(PullRequestAdditions, { read: () => Effect.succeed(0) })),
    Layer.provide(reader),
    Layer.provide(merger),
    Layer.provide(settings),
    Layer.provideMerge(runs),
  );
};

const seen = (headSha: string, facts: MergeGateFacts): MergeGateObservation => ({
  checks:
    headSha === facts.headSha
      ? facts.checks.map((check) => ({ name: check.name, state: check.state }))
      : [{ name: "CI", state: "missing" }],
  coldVerify: headSha === facts.headSha ? facts.coldVerify.state : "missing",
  paths: facts.paths,
  merged: false,
});

describe("MergeGate", () => {
  it.effect("都过且自动合开着，调一次合并", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<MergeCall>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const gate = yield* MergeGate;
        yield* runs.tick;
        yield* runs.note(9, { status: "verify", prNumber: 18, headSha: HEAD });
        yield* gate.tick;
        const run = (yield* runs.list).runs.find((item) => item.issueNumber === 9);
        const merged = yield* Ref.get(calls);
        assert.strictEqual(run?.status, "merged");
        assert.deepStrictEqual(merged, [
          { number: 18, headSha: HEAD, repository: "thoerwink8/fleet-ade" },
        ]);
        assert.notStrictEqual(merged[0]?.headSha, OLD_HEAD);
        yield* gate.tick;
        assert.strictEqual((yield* Ref.get(calls)).length, 1);
      }).pipe(
        Effect.provide(
          gateLayer({
            autoMerge: true,
            observe: (headSha) => Effect.succeed(seen(headSha, passing(true))),
            merge: () => Effect.void,
            calls,
          }),
        ),
      );
    }),
  );
  it.effect("受监督且已接受的运行，自动合开着仍不调用合并", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<MergeCall>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const gate = yield* MergeGate;
        yield* runs.tick;
        yield* runs.note(9, {
          status: "verify",
          threadId: "pipeline-worker",
          prNumber: 18,
          headSha: HEAD,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE pipeline_runs SET
            controller_thread_id = 'legacy-controller',
            controller_verdict = 'accepted',
            accepted_head_sha = ${HEAD}
          WHERE issue_number = 9
        `;
        yield* gate.tick;
        const run = (yield* runs.list).runs.find((item) => item.issueNumber === 9);
        assert.strictEqual(run?.status, "mergeable");
        assert.strictEqual(run?.controllerVerdict, "accepted");
        assert.strictEqual(run?.acceptedHeadSha, HEAD);
        assert.deepStrictEqual(yield* Ref.get(calls), []);
      }).pipe(
        Effect.provide(
          gateLayer({
            autoMerge: true,
            observe: (headSha) => Effect.succeed(seen(headSha, passing(true))),
            merge: () => Effect.fail(new MergeRequestError()),
            calls,
          }),
        ),
      );
    }),
  );

  it.effect("开关关闭时回读受监督运行的已合并 PR，普通运行不推进且不调用合并", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<MergeCall>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const gate = yield* MergeGate;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO pipeline_runs (
            repository, issue_number, title, status, pr_number, head_sha, updated_at
          ) VALUES (
            'thoerwink8/fleet-ade', 9, '单 9', 'verify', 18, ${HEAD}, '2026-11-16T00:00:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO pipeline_runs (
            repository, issue_number, title, status, pr_number, head_sha, thread_id,
            controller_thread_id, controller_verdict, accepted_head_sha, updated_at
          ) VALUES (
            'thoerwink8/fleet-ade', 10, '已人工合并', 'verify', 19, ${HEAD},
            'thread:worker-10', 'thread:controller', 'accepted', ${HEAD}, '2026-11-16T00:00:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO pipeline_runs (
            repository, issue_number, title, status, pr_number, head_sha, thread_id,
            controller_thread_id, controller_verdict, accepted_head_sha, updated_at
          ) VALUES (
            'thoerwink8/fleet-ade', 11, '尚未合并', 'verify', 20, ${HEAD},
            'thread:worker-11', 'thread:controller', 'accepted', ${HEAD}, '2026-11-16T00:00:00.000Z'
          )
        `;
        yield* gate.tick;
        const listed = (yield* runs.list).runs;
        assert.strictEqual(listed.find((run) => run.issueNumber === 9)?.status, "verify");
        assert.strictEqual(listed.find((run) => run.issueNumber === 10)?.status, "merged");
        assert.strictEqual(listed.find((run) => run.issueNumber === 11)?.status, "mergeable");
        assert.deepStrictEqual(yield* Ref.get(calls), []);
      }).pipe(
        Effect.provide(
          gateLayer({
            autoMerge: true,
            enabled: false,
            observe: () => Effect.die("read override owns this test"),
            merge: () => Effect.die("supervised run must not auto-merge"),
            calls,
            read: (entry) => {
              if (entry.number === 18) {
                return Effect.die("ordinary run was read while pipeline is off");
              }
              return Effect.succeed({
                checks: [{ name: "CI", state: "success" as const }],
                coldVerify: "success" as const,
                paths: ["apps/server/src/pipeline/mergeGate.ts"],
                merged: entry.number === 19,
              });
            },
          }),
        ),
      );
    }),
  );

  it.effect("合并接口失败，不把运行标成已合", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<MergeCall>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const gate = yield* MergeGate;
        yield* runs.tick;
        yield* runs.note(9, { status: "mergeable", prNumber: 18, headSha: HEAD });
        yield* gate.tick;
        const first = (yield* runs.list).runs.find((item) => item.issueNumber === 9);
        assert.strictEqual(first?.status, "mergeable");
        assert.notStrictEqual(first?.status, "merged");
        assert.strictEqual(first?.detail, "没查成");
        assert.deepStrictEqual(yield* Ref.get(calls), [
          { number: 18, headSha: HEAD, repository: "thoerwink8/fleet-ade" },
        ]);
        yield* gate.tick;
        const second = (yield* runs.list).runs.find((item) => item.issueNumber === 9);
        const retried = yield* Ref.get(calls);
        assert.strictEqual(second?.status, "mergeable");
        assert.strictEqual(retried.length, 2);
        assert.strictEqual(retried[1]?.headSha, HEAD);
      }).pipe(
        Effect.provide(
          gateLayer({
            autoMerge: true,
            observe: (headSha) => Effect.succeed(seen(headSha, passing(true))),
            merge: () => Effect.fail(new MergeRequestError()),
            calls,
          }),
        ),
      );
    }),
  );

  it.effect("读到已经合上就不再调合并", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<MergeCall>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const gate = yield* MergeGate;
        yield* runs.tick;
        yield* runs.note(9, { status: "mergeable", prNumber: 18, headSha: HEAD });
        yield* gate.tick;
        const run = (yield* runs.list).runs.find((item) => item.issueNumber === 9);
        assert.strictEqual(run?.status, "merged");
        assert.strictEqual((yield* Ref.get(calls)).length, 0);
      }).pipe(
        Effect.provide(
          gateLayer({
            autoMerge: true,
            observe: () =>
              Effect.succeed({
                checks: [{ name: "CI", state: "success" }],
                coldVerify: "success",
                paths: ["apps/server/src/pipeline/mergeGate.ts"],
                merged: true,
              }),
            merge: () => Effect.die("already merged"),
            calls,
          }),
        ),
      );
    }),
  );

  it.effect("都过且自动合关着，停在可合，不调合并", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<MergeCall>>([]);
      yield* Effect.gen(function* () {
        assert.strictEqual(DEFAULT_SERVER_SETTINGS.pipelineAutoMerge, false);
        const runs = yield* PipelineRuns;
        const gate = yield* MergeGate;
        yield* runs.tick;
        yield* runs.note(9, {
          status: "checks",
          prNumber: 18,
          headSha: HEAD,
          detail: "CI 已绿、未验",
        });
        yield* gate.tick;
        const run = (yield* runs.list).runs.find((item) => item.issueNumber === 9);
        assert.strictEqual(run?.status, "mergeable");
        assert.strictEqual(run?.stuckReason, null);
        assert.strictEqual((yield* Ref.get(calls)).length, 0);
      }).pipe(
        Effect.provide(
          gateLayer({
            autoMerge: false,
            observe: (headSha) => Effect.succeed(seen(headSha, passing(false))),
            merge: () => Effect.die("auto merge is off"),
            calls,
          }),
        ),
      );
    }),
  );

  it.effect("diff 含工作流目录就交人，旧头上的成功不算这个头", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<MergeCall>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const gate = yield* MergeGate;
        yield* runs.tick;
        yield* runs.note(9, { status: "verify", prNumber: 18, headSha: HEAD });
        yield* gate.tick;
        const stuck = (yield* runs.list).runs.find((item) => item.issueNumber === 9);
        assert.strictEqual(stuck?.status, "stuck");
        assert.strictEqual(stuck?.stuckReason, "交人");
        yield* runs.note(9, { headSha: OLD_HEAD, status: "verify", stuckReason: null });
        yield* gate.tick;
        const old = (yield* runs.list).runs.find((item) => item.issueNumber === 9);
        assert.strictEqual(old?.status, "verify");
        assert.strictEqual(old?.headSha, OLD_HEAD);
        assert.strictEqual((yield* Ref.get(calls)).length, 0);
      }).pipe(
        Effect.provide(
          gateLayer({
            autoMerge: true,
            observe: (headSha) =>
              Effect.succeed(
                seen(headSha, {
                  ...passing(true),
                  paths:
                    headSha === HEAD
                      ? [".github/workflows/ci.yml"]
                      : ["apps/server/src/pipeline/mergeGate.ts"],
                }),
              ),
            merge: () => Effect.die("not mergeable"),
            calls,
          }),
        ),
      );
    }),
  );

  it.effect("同一单号同一 PR 号按仓库走不同的检查、文件和合并路径", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const rest = Layer.succeed(GitHubRest.GitHubRest, {
        rest: (request: { readonly method?: string; readonly path: string }) => {
          const method = request.method ?? "GET";
          const line = `${method} ${request.path}`;
          const additions = request.path.includes("thoerwink8/fleet-ade") ? 3001 : 0;
          const body = request.path.includes("/actions/runs")
            ? {
                total_count: 1,
                workflow_runs: [
                  {
                    id: 1,
                    name: "CI",
                    head_sha: HEAD,
                    status: "completed",
                    conclusion: "success",
                  },
                ],
              }
            : request.path.includes("/status")
              ? { sha: HEAD, statuses: [{ context: "cold-verify", state: "success" }] }
              : request.path.includes("/files")
                ? [{ filename: "apps/server/src/pipeline/mergeGate.ts" }]
                : request.path.includes("/pulls/")
                  ? { additions, merged: false, head: { sha: HEAD } }
                  : {};
          return Ref.update(calls, (items) => [...items, line]).pipe(
            Effect.as({
              status: 200,
              headers: {},
              body: JSON.stringify(body),
              truncated: false,
              invalidUtf8: false,
            }),
          );
        },
        credential: () => Effect.die("unused"),
        appCredential: () => Effect.die("unused"),
      } as GitHubRest.GitHubRest["Service"]);
      const settings = ServerSettings.layerTest({
        pipelineEnabled: true,
        pipelineAutoMerge: true,
      });
      const runs = runsLayer.pipe(
        Layer.provide(
          Layer.succeed(PipelineGitHubIssues, {
            addLabel: () => Effect.die("unexpected label write"),
            listEligible: () => Effect.succeed([issue(9)]),
            read: () => Effect.die("unused"),
          }),
        ),
        Layer.provide(Layer.succeed(PipelineUsage, { read: () => Effect.succeed([]) })),
        Layer.provide(settings),
        Layer.provide(layerPortsDefault),
        Layer.provide(ClaimLease.layerPort({ repos: ["thoerwink8/fleet-ade"] })),
        Layer.provideMerge(SqlitePersistence.layerMemory),
      );
      const live = layerLive.pipe(
        Layer.provide(budgetLive),
        Layer.provide(rest),
        Layer.provide(settings),
        Layer.provideMerge(runs),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const stored = yield* PipelineRuns;
        const gate = yield* MergeGate;
        yield* stored.tick;
        yield* stored.note(9, { status: "verify", prNumber: 18, headSha: HEAD });
        yield* sql`
          INSERT INTO pipeline_runs (
            repository, issue_number, title, status, pr_number, head_sha, updated_at
          ) VALUES (
            'acme/widgets', 9, '单 9', 'verify', 18, ${HEAD}, '2026-11-16T00:00:00.000Z'
          )
        `;
        yield* gate.tick;
        const listed = yield* stored.list;
        const homeRun = listed.runs.find((item) => item.repository === "thoerwink8/fleet-ade");
        assert.strictEqual(homeRun?.status, "stuck");
        assert.strictEqual(homeRun?.stuckReason, "超预算");
        assert.strictEqual(
          listed.runs.find((item) => item.repository === "acme/widgets")?.status,
          "merged",
        );
        const seen = yield* Ref.get(calls);
        const home = "repos/thoerwink8/fleet-ade";
        const away = "repos/acme/widgets";
        for (const path of [
          `GET ${home}/pulls/18`,
          `GET ${away}/pulls/18`,
          `GET ${away}/actions/runs?head_sha=${HEAD}&per_page=100`,
          `GET ${away}/commits/${HEAD}/status`,
          `GET ${away}/pulls/18/files?per_page=100`,
          `PUT ${away}/pulls/18/merge`,
        ]) {
          assert.ok(seen.includes(path), seen.join("\n"));
        }
        assert.ok(!seen.some((line) => line.startsWith("PUT ") && line.includes(home)));
        assert.ok(!seen.some((line) => line.includes(`${home}/actions/`)));
        assert.ok(!seen.some((line) => line.includes(`${home}/commits/`)));
        assert.ok(!seen.some((line) => line.includes(`${home}/pulls/18/files`)));
      }).pipe(Effect.provide(live));
    }),
  );
});

describe("workflowChecks", () => {
  it.effect("当前头上不叫 CI 的工作流不是 success，也算一项检查", () =>
    Effect.sync(() => {
      const checks = workflowChecks(
        {
          workflow_runs: [
            {
              id: 1,
              name: "CI",
              head_sha: HEAD,
              status: "completed",
              conclusion: "success",
            },
            {
              id: 2,
              name: "lint",
              head_sha: HEAD,
              status: "completed",
              conclusion: "failure",
            },
            {
              id: 3,
              name: "lint",
              head_sha: OLD_HEAD,
              status: "completed",
              conclusion: "success",
            },
          ],
        },
        HEAD,
      );
      assert.deepStrictEqual(checks, [
        { name: "CI", state: "success" },
        { name: "lint", state: "failure" },
      ]);
    }),
  );
});
