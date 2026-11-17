import { assert, describe, it } from "@effect/vitest";
import type { PipelineStuckReason } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

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

const layerFor = (
  issues: ReadonlyArray<PipelineIssue>,
  open: CommanderSessionOpener["Service"]["open"],
) => {
  const settings = ServerSettings.layerTest({ pipelineEnabled: true });
  const runs = runsLayer.pipe(
    Layer.provide(
      Layer.succeed(PipelineGitHubIssues, {
        listEligible: () => Effect.succeed(issues),
        read: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(Layer.succeed(PipelineUsage, { read: () => Effect.die("unused") })),
    Layer.provide(settings),
    Layer.provide(layerPortsDefault),
    Layer.provide(ClaimLease.layerPort({ repos: ["thoerwink8/fleet-ade"] })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return layer.pipe(
    Layer.provide(Layer.succeed(CommanderSessionOpener, { open })),
    Layer.provide(settings),
    Layer.provideMerge(runs),
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
      const opened = yield* Ref.make(0);
      const open: CommanderSessionOpener["Service"]["open"] = () =>
        Ref.update(opened, (count) => count + 1).pipe(
          Effect.as({
            started: true,
            verdict: { action: "继续", category: null },
          } satisfies CommanderSessionResult),
        );
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const triage = yield* ParkTriage;
        yield* stick([{ number: 4, reason: "超预算" }]);
        yield* TestClock.adjust(Duration.minutes(PARK_TRIAGE_AFTER_MINUTES));
        const missing = yield* triage.triage({ modelConfigured: false });
        yield* Effect.logInfo(missing.lines.join("\n"));
        see(missing.lines, "没配模型");
        see(missing.lines, "不算已处理");
        assert.strictEqual(missing.requests, 0);
        assert.strictEqual(yield* Ref.get(opened), 0);
        const held = (yield* runs.list).runs[0];
        assert.strictEqual(held?.status, "stuck");
        assert.strictEqual(held?.stuckReason, "超预算");
        assert.ok(held?.detail?.includes("没配模型"));

        const later = yield* triage.triage({ modelConfigured: true });
        yield* Effect.logInfo(later.lines.join("\n"));
        assert.strictEqual(later.requests, 1);
        assert.strictEqual(yield* Ref.get(opened), 1);
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
});
