import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Feishu from "./feishu.ts";
import * as Ref from "effect/Ref";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PullRequestAdditions, layer as budgetLayer } from "./budget.ts";
import { PipelineGitHubIssues, type PipelineIssue } from "./GitHubIssues.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
import {
  MergeGate,
  MergeGateReadError,
  MergeGateReader,
  MergeRequestError,
  PullRequestMerger,
  decideMerge,
  layer,
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
});

interface MergeCall {
  readonly number: number;
  readonly headSha: string;
}

const passing = (autoMerge: boolean): MergeGateFacts => ({
  headSha: HEAD,
  ci: { state: "success", sha: HEAD },
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
    facts: { ...passing(true), ci: { state: "failure", sha: HEAD } },
    decision: hold,
  },
  {
    name: "没有 CI 检查，不合",
    facts: { ...passing(true), ci: { state: "missing", sha: null } },
    decision: hold,
  },
  {
    name: "CI 成功但是另一个头，不合",
    facts: { ...passing(true), ci: { state: "success", sha: OLD_HEAD } },
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
    name: "diff 含 .github/workflows/，交人，不合",
    facts: { ...passing(true), paths: [".github/workflows/ci.yml"] },
    decision: { kind: "stuck", reason: "交人" },
  },
  {
    name: "都过且自动合关着，停在可合，不调合并",
    facts: passing(false),
    decision: { kind: "mergeable" },
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
      const pending: MergeGateFacts["ci"] = { state: "pending", sha: HEAD };
      assert.strictEqual(decideMerge({ ...passing(true), ci: pending }).kind, "hold");
      assert.strictEqual(decideMerge({ ...passing(true), coldVerify: pending }).kind, "hold");
    }),
  );
});

const gateLayer = (input: {
  readonly autoMerge: boolean;
  readonly observe: (headSha: string) => Effect.Effect<MergeGateObservation, MergeGateReadError>;
  readonly merge: (call: MergeCall) => Effect.Effect<void, MergeRequestError>;
  readonly calls: Ref.Ref<ReadonlyArray<MergeCall>>;
}) => {
  const settings = ServerSettings.layerTest({
    pipelineEnabled: true,
    pipelineAutoMerge: input.autoMerge,
  });
  const runs = runsLayer.pipe(
    Layer.provide(
      Layer.succeed(
        Feishu.PipelineFeishu,
        Feishu.PipelineFeishu.of({
          send: () => Effect.succeed({ delivered: false, note: "没送出：未配置" }),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(PipelineGitHubIssues, {
        listEligible: () => Effect.succeed([issue(9)]),
        read: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(Layer.succeed(PipelineUsage, { read: () => Effect.succeed([]) })),
    Layer.provide(settings),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const reader = Layer.succeed(MergeGateReader, {
    read: (entry) => input.observe(entry.headSha),
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
  ci: headSha === facts.headSha ? facts.ci.state : "missing",
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
        assert.deepStrictEqual(merged, [{ number: 18, headSha: HEAD }]);
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
        assert.deepStrictEqual(yield* Ref.get(calls), [{ number: 18, headSha: HEAD }]);
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
                ci: "success",
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
});
