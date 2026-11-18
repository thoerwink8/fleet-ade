import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ModelSelection,
  type PipelineStuckReason,
} from "@t3tools/contracts";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PipelineGitHubIssues, type PipelineIssue } from "./GitHubIssues.ts";
import { layerPortsDefault } from "./intakeGates.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
import * as ClaimLease from "./claimLease.ts";
import {
  CommanderSessionOpener,
  PARK_TRIAGE_AFTER_MINUTES,
  ParkTriage,
  RENEW_ONCE_REASONS,
  layer,
  scanParkedRuns,
  layerWorker,
  type CommanderRequest,
  type CommanderSessionResult,
} from "./parkTriage.ts";

const acceptance = `## 怎么算做完
- 跑通测试
`;

const issue = (number: number): PipelineIssue => ({
  number,
  title: `单 ${number}`,
  body: acceptance,
  labels: ["交给 ADE"],
  author: { login: "thoerwink8", id: 1, type: "User" },
});

const FIRST: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude-code"),
  model: "claude-sonnet",
};
const SECOND: ModelSelection = {
  instanceId: ProviderInstanceId.make("grok"),
  model: "grok-code",
};

const layerFor = (
  issues: ReadonlyArray<PipelineIssue>,
  open: CommanderSessionOpener["Service"]["open"],
  models?: {
    readonly author?: ReadonlyArray<ModelSelection>;
    readonly verifier?: ReadonlyArray<ModelSelection>;
  },
  addLabel: PipelineGitHubIssues["Service"]["addLabel"] = () => Effect.void,
) => {
  const settings = ServerSettings.layerTest({
    pipelineEnabled: true,
    ...(models?.author === undefined ? {} : { pipelineAuthorModel: [...models.author] }),
    ...(models?.verifier === undefined ? {} : { pipelineVerifierModel: [...models.verifier] }),
  });
  const github = Layer.succeed(PipelineGitHubIssues, {
    listEligible: () => Effect.succeed(issues),
    read: () => Effect.die("unused"),
    addLabel,
  });
  const runs = runsLayer.pipe(
    Layer.provide(github),
    Layer.provide(Layer.succeed(PipelineUsage, { read: () => Effect.die("unused") })),
    Layer.provide(settings),
    Layer.provide(layerPortsDefault),
    Layer.provide(ClaimLease.layerPort()),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return Layer.mergeAll(
    layer.pipe(
      Layer.provide(Layer.succeed(CommanderSessionOpener, { open })),
      Layer.provide(github),
      Layer.provide(settings),
      Layer.provideMerge(runs),
    ),
    settings,
  );
};

const see = (lines: ReadonlyArray<string>, phrase: string) => {
  assert.ok(
    lines.some((line) => line.includes(phrase)),
    `${phrase}\n${lines.join("\n")}`,
  );
};

const stick = (
  specs: ReadonlyArray<{
    readonly number: number;
    readonly reason: PipelineStuckReason;
    readonly renewedOnce?: boolean;
  }>,
) =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    yield* runs.tick;
    for (const spec of specs) {
      yield* runs.note(spec.number, {
        status: "stuck",
        stuckReason: spec.reason,
        ...(spec.renewedOnce === true ? { renewedOnce: true } : {}),
      });
    }
  });

describe("parkTriage", () => {
  it.effect(
    "停下未满 15 分钟不产生裁决请求。已满 15 分钟、且不在续一次集合里，产生一次裁决请求",
    () =>
      Effect.gen(function* () {
        const opened = yield* Ref.make<ReadonlyArray<number>>([]);
        const open: CommanderSessionOpener["Service"]["open"] = (input) =>
          Ref.update(opened, (items) => [...items, input.issueNumber]).pipe(
            Effect.as({
              started: true,
              verdict: { action: "继续", category: null },
            } satisfies CommanderSessionResult),
          );
        const program = Effect.gen(function* () {
          const runs = yield* PipelineRuns;
          const triage = yield* ParkTriage;
          yield* stick([
            { number: 1, reason: "超预算" },
            { number: 2, reason: "会话失败" },
            { number: 3, reason: "会话失败", renewedOnce: true },
          ]);
          yield* TestClock.adjust(Duration.millis(PARK_TRIAGE_AFTER_MINUTES * 60_000 - 1));
          const early = yield* triage.triage({ modelConfigured: true });
          yield* Effect.logInfo(early.lines.join("\n"));
          assert.strictEqual(early.requests, 0);
          see(early.lines, "停下未满 15 分钟不产生裁决请求");
          assert.strictEqual((yield* Ref.get(opened)).length, 0);

          yield* TestClock.adjust(Duration.millis(1));
          yield* triage.triage({ modelConfigured: false });
          assert.strictEqual(
            (yield* runs.list).runs.find((run) => run.issueNumber === 2)?.stuckReason,
            "会话失败",
          );
          const due = yield* triage.triage({ modelConfigured: true });
          yield* Effect.logInfo(due.lines.join("\n"));
          assert.deepStrictEqual([...(yield* Ref.get(opened))].sort(), [1, 3]);
          assert.strictEqual(due.requests, 2);
          see(due.lines, "已满 15 分钟、且不在续一次集合里，产生一次裁决请求");
          see(due.lines, "还在续一次集合里，不产生裁决请求");
          see(due.lines, "续一次没解开，产生一次裁决请求");
          const listed = (yield* runs.list).runs;
          assert.strictEqual(listed.length, 3);
          const kept = listed.find((run) => run.issueNumber === 2);
          assert.strictEqual(kept?.status, "stuck");
          assert.strictEqual(kept?.renewedOnce, false);
          const released = listed.find((run) => run.issueNumber === 3);
          assert.strictEqual(released?.renewedOnce, true);
          assert.deepStrictEqual([...RENEW_ONCE_REASONS], ["会话失败", "检查红", "超时"]);
        });
        yield* program.pipe(Effect.provide(layerFor([issue(1), issue(2), issue(3)], open)));
      }),
  );

  it.effect("裁决是继续时，该运行回到可派，运行条数仍是 1", () =>
    Effect.gen(function* () {
      const open: CommanderSessionOpener["Service"]["open"] = () =>
        Effect.succeed({
          started: true,
          verdict: { action: "继续", category: null },
        });
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const triage = yield* ParkTriage;
        yield* stick([{ number: 7, reason: "超预算" }]);
        yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
        const report = yield* triage.triage({ modelConfigured: true });
        yield* Effect.logInfo(report.lines.join("\n"));
        see(report.lines, "运行回到可派");
        see(report.lines, "运行条数仍是 1");
        const listed = (yield* runs.list).runs;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.status, "claimed");
        assert.strictEqual(listed[0]?.stuckReason, null);
        assert.strictEqual(listed[0]?.renewedOnce, false);
        assert.strictEqual(report.requests, 1);
        assert.strictEqual(report.labelActions.length, 0);
      }).pipe(Effect.provide(layerFor([issue(7)], open)));
    }),
  );

  it.effect("裁决是贴本机做时，结果里有这个标签动作，且不再派", () =>
    Effect.gen(function* () {
      const open: CommanderSessionOpener["Service"]["open"] = () =>
        Effect.succeed({
          started: true,
          verdict: { action: "贴本机做", category: null },
        });
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const triage = yield* ParkTriage;
        yield* stick([{ number: 8, reason: "超预算" }]);
        yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
        const report = yield* triage.triage({ modelConfigured: true });
        yield* Effect.logInfo(report.lines.join("\n"));
        see(report.lines, "贴本机做");
        see(report.lines, "不再派");
        assert.deepStrictEqual(report.labelActions, [{ issueNumber: 8, label: "本机做" }]);
        const listed = (yield* runs.list).runs;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.status, "stuck");
        assert.notStrictEqual(listed[0]?.status, "claimed");
        assert.notStrictEqual(listed[0]?.status, "session");
      }).pipe(Effect.provide(layerFor([issue(8)], open)));
    }),
  );

  it.effect(
    "裁决是交人且类别是要掏新钱、删了找不回又没备份、改标准时，运行保持 stuck，原因交人",
    () =>
      Effect.gen(function* () {
        const categories = ["要掏新钱", "删了找不回又没备份", "改标准"] as const;
        const open: CommanderSessionOpener["Service"]["open"] = (input) =>
          Effect.succeed({
            started: true,
            verdict: {
              action: "交人",
              category: categories[input.issueNumber - 21] ?? null,
            },
          });
        yield* Effect.gen(function* () {
          const runs = yield* PipelineRuns;
          const triage = yield* ParkTriage;
          yield* stick([
            { number: 21, reason: "超预算" },
            { number: 22, reason: "冷验收不过" },
            { number: 23, reason: "检查红", renewedOnce: true },
          ]);
          yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
          const report = yield* triage.triage({ modelConfigured: true });
          yield* Effect.logInfo(report.lines.join("\n"));
          for (const category of categories) see(report.lines, category);
          see(report.lines, "原因交人");
          const listed = (yield* runs.list).runs;
          assert.strictEqual(listed.length, 3);
          for (const run of listed) {
            assert.strictEqual(run.status, "stuck");
            assert.strictEqual(run.stuckReason, "交人");
          }
          assert.strictEqual(report.labelActions.length, 0);
        }).pipe(Effect.provide(layerFor([issue(21), issue(22), issue(23)], open)));
      }),
  );

  it.effect(
    "动作不在继续、交人、贴本机做里，或交人的类别不是那三类，都不执行该动作，改为默认动作 stuck 原因交人",
    () =>
      Effect.gen(function* () {
        const open: CommanderSessionOpener["Service"]["open"] = (input) =>
          Effect.succeed({
            started: true,
            verdict:
              input.issueNumber === 31
                ? { action: "重做", category: null }
                : { action: "交人", category: "其它" },
          });
        yield* Effect.gen(function* () {
          const runs = yield* PipelineRuns;
          const triage = yield* ParkTriage;
          yield* stick([
            { number: 31, reason: "超预算" },
            { number: 32, reason: "超预算" },
          ]);
          yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
          const report = yield* triage.triage({ modelConfigured: true });
          yield* Effect.logInfo(report.lines.join("\n"));
          see(report.lines, "不执行该动作");
          see(report.lines, "改为默认动作");
          see(report.lines, "原因交人");
          const listed = (yield* runs.list).runs;
          assert.strictEqual(listed.length, 2);
          for (const run of listed) {
            assert.strictEqual(run.status, "stuck");
            assert.strictEqual(run.stuckReason, "交人");
            assert.strictEqual(run.renewedOnce, false);
          }
          assert.strictEqual(report.labelActions.length, 0);
          assert.strictEqual(report.requests, 2);
        }).pipe(Effect.provide(layerFor([issue(31), issue(32)], open)));
      }),
  );

  it.effect("没配指挥官模型时结果写没配模型，且不算已处理", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<CommanderRequest>>([]);
      const open: CommanderSessionOpener["Service"]["open"] = (input) =>
        Ref.update(opened, (items) => [...items, input]).pipe(
          Effect.as({
            started: true,
            verdict: { action: "继续", category: null },
          } satisfies CommanderSessionResult),
        );
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const triage = yield* ParkTriage;
        yield* stick([{ number: 4, reason: "超预算" }]);
        yield* runs.note(4, { detail: "预算已花完，需要裁决" });
        yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
        const missing = yield* triage.triage({ modelConfigured: false });
        yield* Effect.logInfo(missing.lines.join("\n"));
        see(missing.lines, "没配模型");
        see(missing.lines, "不算已处理");
        assert.strictEqual(missing.requests, 0);
        assert.strictEqual((yield* Ref.get(opened)).length, 0);
        const held = (yield* runs.list).runs[0];
        assert.strictEqual(held?.status, "stuck");
        assert.strictEqual(held?.stuckReason, "没配模型");
        assert.ok(held?.detail?.includes("没配模型"));
        yield* triage.triage({ modelConfigured: false });
        assert.deepStrictEqual((yield* runs.list).runs[0], held);

        const later = yield* triage.triage({ modelConfigured: true });
        yield* Effect.logInfo(later.lines.join("\n"));
        assert.strictEqual(later.requests, 1);
        const requests = yield* Ref.get(opened);
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0]?.stuckReason, "超预算");
        assert.strictEqual(requests[0]?.detail, "预算已花完，需要裁决");
      }).pipe(Effect.provide(layerFor([issue(4)], open)));
    }),
  );

  it.effect(
    "同一次停下前两次会话没起成仍不算已处理；第三次没起成执行默认动作，且不再请求会话",
    () =>
      Effect.gen(function* () {
        const opened = yield* Ref.make(0);
        const open: CommanderSessionOpener["Service"]["open"] = () =>
          Ref.update(opened, (count) => count + 1).pipe(
            Effect.as({ started: false } satisfies CommanderSessionResult),
          );
        yield* Effect.gen(function* () {
          const runs = yield* PipelineRuns;
          const triage = yield* ParkTriage;
          yield* stick([{ number: 9, reason: "超预算" }]);
          yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
          const first = yield* triage.triage({ modelConfigured: true });
          yield* Effect.logInfo(first.lines.join("\n"));
          see(first.lines, "不算已处理");
          assert.strictEqual(first.requests, 1);
          assert.strictEqual((yield* runs.list).runs[0]?.stuckReason, "超预算");
          yield* triage.triage({ modelConfigured: false });
          assert.strictEqual((yield* runs.list).runs[0]?.stuckReason, "没配模型");

          const second = yield* triage.triage({ modelConfigured: true });
          yield* Effect.logInfo(second.lines.join("\n"));
          see(second.lines, "不算已处理");
          assert.strictEqual(second.requests, 1);
          assert.strictEqual(yield* Ref.get(opened), 2);
          assert.strictEqual((yield* runs.list).runs[0]?.stuckReason, "超预算");

          const third = yield* triage.triage({ modelConfigured: true });
          yield* Effect.logInfo(third.lines.join("\n"));
          see(third.lines, "第三次没起成执行默认动作");
          see(third.lines, "不再请求会话");
          assert.strictEqual(third.requests, 0);
          assert.strictEqual(yield* Ref.get(opened), 2);
          const parked = (yield* runs.list).runs[0];
          assert.strictEqual(parked?.status, "stuck");
          assert.strictEqual(parked?.stuckReason, "交人");
          assert.strictEqual((yield* runs.list).runs.length, 1);

          const again = yield* triage.triage({ modelConfigured: true });
          assert.strictEqual(again.requests, 0);
          assert.strictEqual(yield* Ref.get(opened), 2);
        }).pipe(Effect.provide(layerFor([issue(9)], open)));
      }),
  );

  it.effect("同一单号的两个仓库都裁决，标签和续派不写串", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
      const labels = yield* Ref.make<
        ReadonlyArray<{ readonly number: number; readonly repo: string | undefined }>
      >([]);
      const open: CommanderSessionOpener["Service"]["open"] = (input) =>
        Ref.update(opened, (items) => [...items, input.repository]).pipe(
          Effect.as({
            started: true,
            verdict: { action: "贴本机做", category: null },
          } satisfies CommanderSessionResult),
        );
      const addLabel: PipelineGitHubIssues["Service"]["addLabel"] = (number, _label, repo) =>
        Ref.update(labels, (items) => [
          ...items,
          { number, repo: repo === undefined ? undefined : `${repo.owner}/${repo.name}` },
        ]);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* PipelineRuns;
        yield* stick([{ number: 7, reason: "超预算" }]);
        yield* sql`
          INSERT INTO pipeline_runs (
            repository, issue_number, title, status, stuck_reason, updated_at
          ) VALUES (
            'acme/widgets', 7, '单 7', 'stuck', '超预算', '1970-01-01T00:00:00.000Z'
          )
        `;
        yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
        const report = yield* (yield* ParkTriage).triage({ modelConfigured: true });
        assert.strictEqual(report.requests, 2);
        assert.deepStrictEqual([...(yield* Ref.get(opened))].sort(), [
          "acme/widgets",
          "thoerwink8/fleet-ade",
        ]);
        assert.deepStrictEqual(
          (yield* Ref.get(labels)).map((item) => `${item.repo}#${item.number}`).sort(),
          ["acme/widgets#7", "thoerwink8/fleet-ade#7"],
        );
        const listed = yield* runs.list;
        for (const repository of ["thoerwink8/fleet-ade", "acme/widgets"]) {
          const run = listed.runs.find((item) => item.repository === repository);
          assert.strictEqual(run?.status, "stuck");
          assert.strictEqual(run?.stuckReason, "超预算");
          assert.ok(run?.detail?.includes("本机做"), run?.detail ?? "");
        }
      }).pipe(Effect.provide(layerFor([issue(7)], open, undefined, addLabel)));
    }),
  );
});

const openedModels = () => Ref.make<ReadonlyArray<ModelSelection | null>>([]);

const recordOpen =
  (
    opened: Ref.Ref<ReadonlyArray<ModelSelection | null>>,
    verdict: CommanderSessionResult,
  ): CommanderSessionOpener["Service"]["open"] =>
  (input) =>
    Ref.update(opened, (models) => [...models, input.model]).pipe(Effect.as(verdict));

describe("park triage timer", () => {
  it.effect("定时扫满 15 分钟的运行，裁决为继续，模型是候选串里第一个能用的", () =>
    Effect.gen(function* () {
      const opened = yield* openedModels();
      const open = recordOpen(opened, {
        started: true,
        verdict: { action: "继续", category: null },
      });
      yield* Effect.gen(function* () {
        yield* stick([{ number: 7, reason: "超预算" }]);
        const early = yield* scanParkedRuns();
        assert.strictEqual(early.requests, 0);
        assert.deepStrictEqual(yield* Ref.get(opened), []);

        yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
        const report = yield* scanParkedRuns();
        see(report.lines, "运行回到可派");
        const listed = (yield* (yield* PipelineRuns).list).runs;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.status, "claimed");
        assert.strictEqual(listed[0]?.stuckReason, null);
        assert.deepStrictEqual(yield* Ref.get(opened), [FIRST]);
      }).pipe(
        Effect.provide(layerFor([issue(7)], open, { author: [FIRST, SECOND], verifier: [SECOND] })),
      );
    }),
  );

  it.effect("裁决为交人时运行保持 stuck，原因交人，模型取验单串里第一个能用的", () =>
    Effect.gen(function* () {
      const opened = yield* openedModels();
      const open = recordOpen(opened, {
        started: true,
        verdict: { action: "交人", category: "要掏新钱" },
      });
      yield* Effect.gen(function* () {
        yield* stick([{ number: 21, reason: "超预算" }]);
        yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
        const report = yield* scanParkedRuns();
        see(report.lines, "原因交人");
        const listed = (yield* (yield* PipelineRuns).list).runs;
        assert.strictEqual(listed[0]?.status, "stuck");
        assert.strictEqual(listed[0]?.stuckReason, "交人");
        assert.deepStrictEqual(yield* Ref.get(opened), [SECOND]);
      }).pipe(Effect.provide(layerFor([issue(21)], open, { author: [], verifier: [SECOND] })));
    }),
  );

  it.effect("生产扫描贴标签成功后才完成，失败后仅重试标签且不重开裁决会话", () =>
    Effect.gen(function* () {
      const opened = yield* openedModels();
      const writes = yield* Ref.make(0);
      const writeLabel: PipelineGitHubIssues["Service"]["addLabel"] = (number, label) =>
        Effect.gen(function* () {
          assert.strictEqual(number, 8);
          assert.strictEqual(label, "本机做");
          const attempt = yield* Ref.updateAndGet(writes, (count) => count + 1);
          if (attempt === 1) {
            return yield* new GitHubRequestPolicy.GitHubApiRequestError({
              host: "github.com",
              operation: "setLabels",
              cause: new Error("offline"),
            });
          }
        });
      const open = recordOpen(opened, {
        started: true,
        verdict: { action: "贴本机做", category: null },
      });
      yield* Effect.gen(function* () {
        yield* stick([{ number: 8, reason: "超预算" }]);
        yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
        const failed = yield* scanParkedRuns();
        assert.deepStrictEqual(failed.labelActions, []);
        assert.ok(!(yield* (yield* PipelineRuns).list).runs[0]?.detail?.startsWith("已交指挥官"));
        assert.ok(!failed.lines.some((line) => line.includes("不再派")));
        const report = yield* (yield* ParkTriage).triage({ modelConfigured: false });
        see(report.lines, "不再派");
        assert.deepStrictEqual(report.labelActions, [{ issueNumber: 8, label: "本机做" }]);
        yield* scanParkedRuns();
        assert.strictEqual(yield* Ref.get(writes), 2);
        const listed = (yield* (yield* PipelineRuns).list).runs;
        assert.strictEqual(listed[0]?.status, "stuck");
        assert.ok(listed[0]?.detail?.startsWith("已交指挥官·贴本机做"));
        assert.notStrictEqual(listed[0]?.status, "claimed");
        assert.deepStrictEqual(yield* Ref.get(opened), [FIRST]);
      }).pipe(Effect.provide(layerFor([issue(8)], open, { author: [FIRST] }, writeLabel)));
    }),
  );

  it.effect("服务器 worker 真正调用标签服务，写成功后不重复写", () =>
    Effect.gen(function* () {
      const writes = yield* Ref.make(0);
      const open: CommanderSessionOpener["Service"]["open"] = () =>
        Effect.succeed({ started: true, verdict: { action: "贴本机做", category: null } });
      yield* Effect.gen(function* () {
        yield* stick([{ number: 8, reason: "超预算" }]);
        yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
        yield* Layer.build(layerWorker);
        yield* TestClock.adjust(Duration.minutes(5));
        const run = (yield* (yield* PipelineRuns).list).runs[0];
        assert.ok(run?.detail?.startsWith("已交指挥官·贴本机做"));
        assert.strictEqual(yield* Ref.get(writes), 1);
        yield* TestClock.adjust(Duration.minutes(5));
        assert.strictEqual(yield* Ref.get(writes), 1);
      }).pipe(
        Effect.provide(
          layerFor([issue(8)], open, { author: [FIRST] }, () =>
            Ref.update(writes, (count) => count + 1),
          ),
        ),
        Effect.scoped,
      );
    }),
  );

  it.effect("没配模型时保持 stuck、原因没配模型，不报错也不重复开会话", () =>
    Effect.gen(function* () {
      const opened = yield* openedModels();
      const open = recordOpen(opened, {
        started: true,
        verdict: { action: "继续", category: null },
      });
      yield* Effect.gen(function* () {
        yield* stick([{ number: 4, reason: "超预算" }]);
        yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
        const missing = yield* scanParkedRuns();
        see(missing.lines, "没配模型");
        assert.strictEqual(missing.requests, 0);
        const held = (yield* (yield* PipelineRuns).list).runs[0];
        assert.strictEqual(held?.status, "stuck");
        assert.strictEqual(held?.stuckReason, "没配模型");
        const again = yield* scanParkedRuns();
        assert.strictEqual(again.requests, 0);
        assert.deepStrictEqual(yield* Ref.get(opened), []);
        assert.strictEqual((yield* (yield* PipelineRuns).list).runs[0]?.stuckReason, "没配模型");
      }).pipe(Effect.provide(layerFor([issue(4)], open, { author: [], verifier: [] })));
    }),
  );
});
