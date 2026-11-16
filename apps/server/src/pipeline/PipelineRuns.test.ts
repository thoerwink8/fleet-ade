import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PIPELINE_COST_LABEL, PIPELINE_USAGE_UNREADABLE } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  PipelineIssuesIncompleteError,
  PipelineGitHubIssues,
  type PipelineIssue,
} from "./GitHubIssues.ts";
import {
  PipelineRuns,
  PipelineUsage,
  PipelineUsageUnreadable,
  USAGE_EXPORT_VARIABLE,
  layer as runsLayer,
  layerUsage,
  type UsageRecord,
} from "./PipelineRuns.ts";

const acceptance = `## 怎么算做完
- 跑通测试
`;

const issue = (number: number, body = acceptance, title = `单 ${number}`): PipelineIssue => ({
  number,
  title,
  body,
  labels: ["交给 ADE"],
});

const record = (
  at: string,
  account: string,
  inputTokens: number,
  convertedCost: number,
): UsageRecord => ({
  at,
  account,
  inputTokens,
  outputTokens: inputTokens,
  cacheTokens: 0,
  convertedCost,
});

const pipelineLayer = (options: {
  readonly issues: Effect.Effect<ReadonlyArray<PipelineIssue>, PipelineIssuesIncompleteError>;
  readonly usage: Effect.Effect<ReadonlyArray<UsageRecord>, PipelineUsageUnreadable>;
  readonly enabled?: boolean;
}) =>
  runsLayer.pipe(
    Layer.provide(
      Layer.succeed(
        PipelineGitHubIssues,
        PipelineGitHubIssues.of({
          listEligible: () => options.issues,
          read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        PipelineUsage,
        PipelineUsage.of({
          read: () => options.usage,
        }),
      ),
    ),
    Layer.provide(ServerSettings.layerTest({ pipelineEnabled: options.enabled ?? true })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const readable = (records: ReadonlyArray<UsageRecord> = []) => Effect.succeed(records);

describe("PipelineRuns", () => {
  it.effect("同一张单两个 tick 只一条运行", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      const open = issue(7);
      yield* runs.tick;
      yield* runs.tick;
      const listed = yield* runs.list;
      assert.strictEqual(listed.runs.length, 1);
      assert.strictEqual(listed.runs[0]?.issueNumber, open.number);
      assert.strictEqual(listed.runs[0]?.status, "claimed");
      assert.strictEqual(listed.runs[0]?.repository, "thoerwink8/fleet-ade");
      assert.strictEqual(listed.lastTick?.outcome, "ok");
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: Effect.succeed([issue(7)]),
          usage: readable(),
        }),
      ),
    ),
  );

  it.effect("库拒绝同一张单的第二条活跃运行", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      const sql = yield* SqlClient.SqlClient;
      yield* runs.tick;
      const inserted = yield* Effect.exit(sql`
        INSERT INTO pipeline_runs (repository, issue_number, title, status, updated_at)
        VALUES ('thoerwink8/fleet-ade', 7, '单 7', 'claimed', '2026-01-01T00:00:00.000Z')
      `);
      assert.strictEqual(Exit.isFailure(inserted), true);
      assert.strictEqual((yield* runs.list).runs.length, 1);
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: Effect.succeed([issue(7)]),
          usage: readable(),
        }),
      ),
    ),
  );

  it.effect("开关关着不建运行", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      const listed = yield* runs.list;
      assert.strictEqual(listed.runs.length, 0);
      assert.strictEqual(listed.lastTick, null);
      assert.strictEqual(listed.costLabel, PIPELINE_COST_LABEL);
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: Effect.succeed([issue(7)]),
          usage: readable(),
          enabled: false,
        }),
      ),
    ),
  );

  it.effect("读单失败不建运行", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      const listed = yield* runs.list;
      assert.strictEqual(listed.runs.length, 0);
      assert.strictEqual(listed.lastTick?.outcome, "failed");
      assert.strictEqual(listed.lastTick?.detail, "PipelineIssuesIncompleteError");
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
          usage: readable(),
        }),
      ),
    ),
  );

  it.effect("没有怎么算做完的单不建运行", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      assert.strictEqual((yield* runs.list).runs.length, 0);
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: Effect.succeed([issue(7, "先做完再说")]),
          usage: readable(),
        }),
      ),
    ),
  );

  it.effect("提到工作流目录的单卡住且交人", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      const listed = yield* runs.list;
      assert.strictEqual(listed.runs.length, 1);
      assert.strictEqual(listed.runs[0]?.status, "stuck");
      assert.strictEqual(listed.runs[0]?.stuckReason, "交人");
      assert.notStrictEqual(listed.runs[0]?.status, "session");
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: Effect.succeed([issue(7, `${acceptance}\n改 .github/workflows/ci.yml\n`)]),
          usage: readable(),
        }),
      ),
    ),
  );

  it.effect("已开会话时多出来的合格单留着不认领", () =>
    Effect.gen(function* () {
      const visible = yield* Ref.make<ReadonlyArray<PipelineIssue>>([issue(1), issue(2)]);
      return yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        yield* runs.tick;
        yield* runs.note(1, { status: "session" });
        assert.strictEqual((yield* runs.list).runs.length, 2);
        yield* Ref.set(visible, [issue(1), issue(2), issue(3)]);
        yield* runs.tick;
        const listed = yield* runs.list;
        assert.strictEqual(
          listed.runs.some((run) => run.issueNumber === 3),
          false,
        );
        const secondSession = yield* Effect.exit(runs.note(2, { status: "session" }));
        assert.strictEqual(Exit.isFailure(secondSession), true);
      }).pipe(
        Effect.provide(
          pipelineLayer({
            issues: Ref.get(visible),
            usage: readable(),
          }),
        ),
      );
    }),
  );

  it.effect("合并或人取消之后可以再跑一条", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      yield* runs.note(7, { status: "merged" });
      yield* runs.tick;
      const merged = yield* runs.list;
      assert.strictEqual(merged.runs.filter((run) => run.issueNumber === 7).length, 2);
      yield* runs.note(8, { status: "stuck", stuckReason: "取消" });
      yield* runs.tick;
      const cancelled = yield* runs.list;
      assert.strictEqual(cancelled.runs.filter((run) => run.issueNumber === 8).length, 2);
      const handed = cancelled.runs.filter((run) => run.issueNumber === 9);
      assert.strictEqual(handed.length, 1);
      assert.strictEqual(handed[0]?.stuckReason, "交人");
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: Effect.succeed([
            issue(7),
            issue(8),
            issue(9, `${acceptance}\n.github/workflows/\n`),
          ]),
          usage: readable(),
        }),
      ),
    ),
  );

  it.effect("按会话起止切用量，读不到不填 0", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      yield* runs.note(7, {
        sessionStartedAt: "2026-01-01T00:10:00.000Z",
        sessionEndedAt: "2026-01-01T00:20:00.000Z",
        prNumber: 12,
        commitCount: 4,
        ciQueueMs: 90_000,
        threadId: "thread-7",
        headSha: "abc123",
      });
      const read = yield* runs.list;
      const run = read.runs.find((item) => item.issueNumber === 7);
      assert.strictEqual(run?.modelAccount, "alpha");
      assert.strictEqual(run?.inputTokens, 11);
      assert.strictEqual(run?.outputTokens, 11);
      assert.strictEqual(run?.cacheTokens, 0);
      assert.strictEqual(run?.convertedCost, 2);
      assert.strictEqual(run?.usageNote, null);
      assert.strictEqual(run?.costLabel, PIPELINE_COST_LABEL);
      assert.strictEqual(run?.prNumber, 12);
      assert.strictEqual(run?.commitCount, 4);
      assert.strictEqual(run?.ciQueueMs, 90_000);
      assert.strictEqual(read.summary.averageConvertedCost, 2);

      yield* runs.note(8, {
        sessionStartedAt: "not-a-time",
        sessionEndedAt: "also-not",
      });
      const unread = (yield* runs.list).runs.find((item) => item.issueNumber === 8);
      assert.strictEqual(unread?.usageNote, PIPELINE_USAGE_UNREADABLE);
      assert.strictEqual(unread?.inputTokens, null);
      assert.strictEqual(unread?.outputTokens, null);
      assert.strictEqual(unread?.cacheTokens, null);
      assert.strictEqual(unread?.convertedCost, null);
      assert.strictEqual(unread?.modelAccount, null);
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: Effect.succeed([issue(7), issue(8)]),
          usage: readable([
            record("2026-01-01T00:00:00.000Z", "beta", 5, 9),
            record("2026-01-01T00:10:00.000Z", "alpha", 10, 1.5),
            record("2026-01-01T00:20:00.000Z", "alpha", 1, 0.5),
            record("2026-01-01T00:40:00.000Z", "gamma", 100, 100),
          ]),
        }),
      ),
    ),
  );

  it.effect("用量文件缺失时记读不到", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      yield* runs.note(7, {
        sessionStartedAt: "2026-01-01T00:00:00.000Z",
        sessionEndedAt: "2026-01-01T01:00:00.000Z",
      });
      const run = (yield* runs.list).runs[0];
      assert.strictEqual(run?.usageNote, PIPELINE_USAGE_UNREADABLE);
      assert.strictEqual(run?.inputTokens, null);
      assert.strictEqual(run?.convertedCost, null);
    }).pipe(
      Effect.provide(
        runsLayer.pipe(
          Layer.provide(
            Layer.succeed(
              PipelineGitHubIssues,
              PipelineGitHubIssues.of({
                listEligible: () => Effect.succeed([issue(7)]),
                read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
              }),
            ),
          ),
          Layer.provide(layerUsage),
          Layer.provide(ServerSettings.layerTest({ pipelineEnabled: true })),
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
      Effect.provideService(HostProcess.Environment, {
        [USAGE_EXPORT_VARIABLE]: "missing-usage-export.json",
      }),
      Effect.provide(NodeServices.layer),
    ),
  );
  it.effect("用量文件按窗口切开", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = path.join(directory, "usage.json");
      yield* fs.writeFileString(
        file,
        JSON.stringify([
          record("2026-01-01T00:00:00.000Z", "beta", 5, 9),
          record("2026-01-01T00:10:00.000Z", "alpha", 10, 1.5),
          record("2026-01-01T00:20:00.000Z", "alpha", 1, 0.5),
        ]),
      );
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        yield* runs.tick;
        yield* runs.note(7, {
          sessionStartedAt: "2026-01-01T00:10:00.000Z",
          sessionEndedAt: "2026-01-01T00:20:00.000Z",
        });
        const run = (yield* runs.list).runs[0];
        assert.strictEqual(run?.modelAccount, "alpha");
        assert.strictEqual(run?.inputTokens, 11);
        assert.strictEqual(run?.convertedCost, 2);
        assert.strictEqual(run?.usageNote, null);
      }).pipe(
        Effect.provide(
          runsLayer.pipe(
            Layer.provide(
              Layer.succeed(
                PipelineGitHubIssues,
                PipelineGitHubIssues.of({
                  listEligible: () => Effect.succeed([issue(7)]),
                  read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
                }),
              ),
            ),
            Layer.provide(layerUsage),
            Layer.provide(ServerSettings.layerTest({ pipelineEnabled: true })),
            Layer.provideMerge(SqlitePersistence.layerMemory),
          ),
        ),
        Effect.provideService(HostProcess.Environment, { [USAGE_EXPORT_VARIABLE]: file }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("窗口里没有用量记录时是 0 而不是读不到", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      yield* runs.note(7, {
        sessionStartedAt: "2026-01-02T00:00:00.000Z",
        sessionEndedAt: "2026-01-02T01:00:00.000Z",
      });
      const run = (yield* runs.list).runs[0];
      assert.strictEqual(run?.usageNote, null);
      assert.strictEqual(run?.inputTokens, 0);
      assert.strictEqual(run?.outputTokens, 0);
      assert.strictEqual(run?.cacheTokens, 0);
      assert.strictEqual(run?.convertedCost, 0);
      assert.strictEqual(run?.modelAccount, null);
      assert.strictEqual(run?.costLabel, PIPELINE_COST_LABEL);
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: Effect.succeed([issue(7)]),
          usage: readable([record("2026-01-01T00:00:00.000Z", "alpha", 10, 1)]),
        }),
      ),
    ),
  );

  it.effect("读用量失败不覆盖已经记下的数字", () =>
    Effect.gen(function* () {
      const fail = yield* Ref.make(false);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        yield* runs.tick;
        yield* runs.note(7, {
          sessionStartedAt: "2026-01-01T00:00:00.000Z",
          sessionEndedAt: "2026-01-01T01:00:00.000Z",
        });
        const filled = (yield* runs.list).runs[0];
        assert.strictEqual(filled?.inputTokens, 10);
        assert.strictEqual(filled?.usageNote, null);
        yield* Ref.set(fail, true);
        yield* runs.tick;
        const kept = (yield* runs.list).runs[0];
        assert.strictEqual(kept?.inputTokens, 10);
        assert.strictEqual(kept?.outputTokens, 10);
        assert.strictEqual(kept?.convertedCost, 1);
        assert.strictEqual(kept?.modelAccount, "alpha");
        assert.strictEqual(kept?.usageNote, null);
      }).pipe(
        Effect.provide(
          pipelineLayer({
            issues: Effect.succeed([issue(7)]),
            usage: Ref.get(fail).pipe(
              Effect.flatMap((failed) =>
                failed
                  ? Effect.fail(new PipelineUsageUnreadable())
                  : readable([record("2026-01-01T00:30:00.000Z", "alpha", 10, 1)]),
              ),
            ),
          }),
        ),
      );
    }),
  );

  it.effect("最近二十条汇总返工率、耗时和折算费用", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* runs.tick;
      yield* runs.note(1, { commitCount: 9 });
      yield* runs.note(2, {
        commitCount: 3,
        sessionStartedAt: "2026-01-01T00:00:00.000Z",
        sessionEndedAt: "2026-01-01T00:00:10.000Z",
      });
      yield* runs.note(3, {
        commitCount: 1,
        sessionStartedAt: "not-a-time",
        sessionEndedAt: "also-not",
      });
      const listed = yield* runs.list;
      assert.strictEqual(listed.summary.recent, 20);
      assert.strictEqual(listed.summary.reworkRate, 0.5);
      assert.strictEqual(listed.summary.averageDurationMs, 10_000);
      assert.strictEqual(listed.summary.averageConvertedCost, 4);
      assert.strictEqual(listed.summary.costLabel, PIPELINE_COST_LABEL);
      assert.strictEqual(
        listed.runs.some((run) => run.issueNumber === 1),
        true,
      );
    }).pipe(
      Effect.provide(
        pipelineLayer({
          issues: Effect.succeed(Array.from({ length: 21 }, (_, index) => issue(index + 1))),
          usage: readable([record("2026-01-01T00:00:05.000Z", "alpha", 8, 4)]),
        }),
      ),
    ),
  );

  it.effect("重启后运行还在", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const database = path.join(directory, "state.sqlite");
      const boot = runsLayer.pipe(
        Layer.provide(
          Layer.succeed(
            PipelineGitHubIssues,
            PipelineGitHubIssues.of({
              listEligible: () => Effect.succeed([issue(4)]),
              read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
            }),
          ),
        ),
        Layer.provide(Layer.succeed(PipelineUsage, PipelineUsage.of({ read: () => readable() }))),
        Layer.provide(ServerSettings.layerTest({ pipelineEnabled: true })),
        Layer.provide(SqlitePersistence.layerFromPath(database)),
        Layer.provideMerge(NodeServices.layer),
      );
      const first = yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        yield* runs.tick;
        yield* runs.note(4, { prNumber: 9, commitCount: 3, ciQueueMs: 1200, headSha: "abc" });
        return yield* runs.list;
      }).pipe(Effect.provide(boot));
      const second = yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        return yield* runs.list;
      }).pipe(Effect.provide(Layer.fresh(boot)));
      assert.deepStrictEqual(second.runs, first.runs);
      assert.strictEqual(second.runs[0]?.prNumber, 9);
      assert.strictEqual(second.runs[0]?.commitCount, 3);
      assert.strictEqual(second.lastTick?.outcome, "ok");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
