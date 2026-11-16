import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type PipelineStuckReason } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  PipelineBudget,
  PullRequestAdditions,
  PullRequestAdditionsUnreadable,
  layer as budgetLayer,
} from "./budget.ts";
import { PipelineGitHubIssues, type PipelineIssue } from "./GitHubIssues.ts";
import {
  PipelineRuns,
  PipelineUsage,
  PipelineUsageUnreadable,
  layer as runsLayer,
  type UsageRecord,
} from "./PipelineRuns.ts";

const START = "2026-11-16T00:00:00.000Z";
const END = "2026-11-16T01:00:00.000Z";
const AT = "2026-11-16T00:30:00.000Z";

const acceptance = `## 怎么算做完
- 跑通测试
`;

const issue = (number: number): PipelineIssue => ({
  number,
  title: `单 ${number}`,
  body: acceptance,
  labels: ["交给 ADE"],
});

const usageOf = (inputTokens: number, outputTokens = 0): UsageRecord => ({
  at: AT,
  account: "acct",
  inputTokens,
  outputTokens,
  cacheTokens: 0,
  convertedCost: 1,
});

const layerFor = (input: {
  readonly issues: ReadonlyArray<PipelineIssue>;
  readonly usage: Effect.Effect<ReadonlyArray<UsageRecord>, PipelineUsageUnreadable>;
  readonly additions: Effect.Effect<number, PullRequestAdditionsUnreadable>;
}) => {
  const settings = ServerSettings.layerTest({ pipelineEnabled: true });
  const runs = runsLayer.pipe(
    Layer.provide(
      Layer.succeed(PipelineGitHubIssues, {
        listEligible: () => Effect.succeed(input.issues),
        read: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(Layer.succeed(PipelineUsage, { read: () => input.usage })),
    Layer.provide(settings),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return budgetLayer.pipe(
    Layer.provide(Layer.succeed(PullRequestAdditions, { read: () => input.additions })),
    Layer.provide(settings),
    Layer.provideMerge(runs),
  );
};

const run = <A, E, R>(
  issues: ReadonlyArray<PipelineIssue>,
  usage: Effect.Effect<ReadonlyArray<UsageRecord>, PipelineUsageUnreadable>,
  additions: Effect.Effect<number, PullRequestAdditionsUnreadable>,
  body: Effect.Effect<A, E, R>,
) => body.pipe(Effect.provide(layerFor({ issues, usage, additions })));

const closeSession = (number: number) =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    yield* runs.tick;
    yield* runs.note(number, {
      status: "session",
      threadId: `thread-${number}`,
      sessionStartedAt: START,
      sessionEndedAt: END,
      headSha: "abc",
    });
  });

describe("PipelineBudget", () => {
  it.effect("默认预算是 700 万输入 token 和 3000 行，两个开关仍关着", () =>
    Effect.sync(() => {
      assert.strictEqual(DEFAULT_SERVER_SETTINGS.pipelineTokenInputEquivalent, 7_000_000);
      assert.strictEqual(DEFAULT_SERVER_SETTINGS.pipelinePullRequestAddedLines, 3_000);
      assert.strictEqual(DEFAULT_SERVER_SETTINGS.pipelineEnabled, false);
      assert.strictEqual(DEFAULT_SERVER_SETTINGS.pipelineAutoMerge, false);
    }),
  );

  it.effect("输入 token 超了卡住，刚好到顶不卡，输出 token 不另算", () =>
    run(
      [issue(7)],
      Effect.succeed([usageOf(7_000_001, 1)]),
      Effect.succeed(0),
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const budget = yield* PipelineBudget;
        yield* closeSession(7);
        yield* budget.tick;
        const over = (yield* runs.list).runs[0];
        assert.strictEqual(over?.status, "stuck");
        assert.strictEqual(over?.stuckReason, "超预算");
        assert.strictEqual(over?.renewedOnce, false);
      }),
    ).pipe(
      Effect.andThen(
        run(
          [issue(8)],
          Effect.succeed([usageOf(7_000_000, 9_000_000)]),
          Effect.succeed(0),
          Effect.gen(function* () {
            const budget = yield* PipelineBudget;
            yield* closeSession(8);
            yield* budget.tick;
            const under = (yield* (yield* PipelineRuns).list).runs[0];
            assert.strictEqual(under?.status, "session");
            assert.strictEqual(under?.stuckReason, null);
            assert.strictEqual(under?.inputTokens, 7_000_000);
          }),
        ),
      ),
    ),
  );

  it.effect("新增行超了卡住，读不到行数不放行也不标超预算", () =>
    run(
      [issue(7), issue(8)],
      Effect.succeed([]),
      Effect.succeed(3_001),
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const budget = yield* PipelineBudget;
        yield* runs.tick;
        yield* runs.note(7, { status: "checks", prNumber: 70, headSha: "abc" });
        yield* budget.tick;
        const over = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(over?.status, "stuck");
        assert.strictEqual(over?.stuckReason, "超预算");
      }),
    ).pipe(
      Effect.andThen(
        run(
          [issue(8)],
          Effect.succeed([]),
          Effect.fail(new PullRequestAdditionsUnreadable()),
          Effect.gen(function* () {
            const runs = yield* PipelineRuns;
            const budget = yield* PipelineBudget;
            yield* runs.tick;
            yield* runs.note(8, { status: "mergeable", prNumber: 80, headSha: "abc" });
            yield* budget.tick;
            const unread = (yield* runs.list).runs[0];
            assert.strictEqual(unread?.status, "mergeable");
            assert.strictEqual(unread?.stuckReason, null);
            assert.strictEqual(unread?.detail, "没查成");
          }),
        ),
      ),
    ),
  );

  it.effect("读不到用量不放行，也不标超预算", () =>
    run(
      [issue(7)],
      Effect.fail(new PipelineUsageUnreadable()),
      Effect.succeed(0),
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const budget = yield* PipelineBudget;
        yield* closeSession(7);
        yield* budget.tick;
        const unread = (yield* runs.list).runs[0];
        assert.strictEqual(unread?.status, "session");
        assert.strictEqual(unread?.stuckReason, null);
        assert.strictEqual(unread?.detail, "没查成");
        assert.strictEqual(unread?.usageNote, "读不到");
        assert.strictEqual(unread?.inputTokens, null);
        assert.strictEqual(unread?.prNumber, null);
      }),
    ),
  );

  it.effect("会话失败、超时、检查红各续一次，第二次保持原原因", () => {
    const reasons = [
      ["会话失败", "原终态 failed"],
      ["超时", "超时"],
      ["检查红", null],
    ] as const satisfies ReadonlyArray<readonly [PipelineStuckReason, string | null]>;
    return run(
      reasons.map((_, index) => issue(index + 1)),
      Effect.succeed([]),
      Effect.succeed(0),
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const budget = yield* PipelineBudget;
        yield* runs.tick;
        const before = yield* runs.list;
        assert.strictEqual(before.runs.length, reasons.length);
        for (const [index, [reason, detail]] of reasons.entries()) {
          yield* runs.note(index + 1, { status: "stuck", stuckReason: reason, detail });
        }
        yield* budget.tick;
        yield* runs.tick;
        const renewed = yield* runs.list;
        assert.strictEqual(renewed.runs.length, reasons.length);
        for (const run of renewed.runs) {
          assert.strictEqual(run.status, "claimed");
          assert.strictEqual(run.stuckReason, null);
          assert.strictEqual(run.detail, "已续一次");
          assert.strictEqual(run.renewedOnce, true);
          assert.strictEqual(run.threadId, null);
          assert.strictEqual(
            run.id === before.runs.find((item) => item.issueNumber === run.issueNumber)?.id,
            true,
          );
        }
        for (const [index, [reason, detail]] of reasons.entries()) {
          yield* runs.note(index + 1, { status: "stuck", stuckReason: reason, detail });
        }
        yield* budget.tick;
        const stuck = yield* runs.list;
        assert.strictEqual(stuck.runs.length, reasons.length);
        for (const [index, [reason, detail]] of reasons.entries()) {
          const run = stuck.runs.find((item) => item.issueNumber === index + 1);
          assert.strictEqual(run?.status, "stuck");
          assert.strictEqual(run?.stuckReason, reason);
          assert.strictEqual(run?.detail, detail);
          assert.strictEqual(run?.renewedOnce, true);
        }
      }),
    );
  });

  it.effect("取消和冷验收不过不续，超预算的失败也不续", () =>
    run(
      [issue(7), issue(8), issue(9)],
      Effect.succeed([usageOf(7_000_001)]),
      Effect.succeed(0),
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const budget = yield* PipelineBudget;
        yield* runs.tick;
        yield* runs.note(7, { status: "stuck", stuckReason: "取消", detail: "原终态 取消" });
        yield* runs.note(8, { status: "stuck", stuckReason: "冷验收不过", detail: "不过" });
        yield* runs.note(9, {
          status: "session",
          threadId: "thread-9",
          sessionStartedAt: START,
          sessionEndedAt: END,
        });
        yield* runs.note(9, { status: "stuck", stuckReason: "会话失败", detail: "原终态 failed" });
        yield* budget.tick;
        const listed = yield* runs.list;
        assert.strictEqual(listed.runs.length, 3);
        const cancelled = listed.runs.find((item) => item.issueNumber === 7);
        const cold = listed.runs.find((item) => item.issueNumber === 8);
        const over = listed.runs.find((item) => item.issueNumber === 9);
        assert.strictEqual(cancelled?.status, "stuck");
        assert.strictEqual(cancelled?.stuckReason, "取消");
        assert.strictEqual(cancelled?.renewedOnce, false);
        assert.strictEqual(cold?.status, "stuck");
        assert.strictEqual(cold?.stuckReason, "冷验收不过");
        assert.strictEqual(cold?.renewedOnce, false);
        assert.strictEqual(over?.status, "stuck");
        assert.strictEqual(over?.stuckReason, "超预算");
        assert.strictEqual(over?.renewedOnce, false);
      }),
    ),
  );
});
