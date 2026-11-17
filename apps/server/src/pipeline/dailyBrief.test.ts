import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { PipelineGitHubIssues, PipelineIssuesIncompleteError } from "./GitHubIssues.ts";
import {
  DailyBrief,
  DailyBriefSend,
  DailyBriefSource,
  DailyBriefUnread,
  layer,
  type BriefStuckRun,
} from "./dailyBrief.ts";
import { layerPortsDefault } from "./intakeGates.ts";
import * as ClaimLease from "./claimLease.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";

const DAY = "2026-11-17";

/** Beijing wall time on DAY, as epoch millis. */
const at = (hour: number, minute: number): number => Date.UTC(2026, 10, 17, hour - 8, minute, 0);

const sent: string[] = [];

const briefLayer = (stuck: Effect.Effect<ReadonlyArray<BriefStuckRun>, DailyBriefUnread>) => {
  sent.length = 0;
  return layer.pipe(
    Layer.provide(Layer.succeed(DailyBriefSource, DailyBriefSource.of({ stuck }))),
    Layer.provide(
      Layer.succeed(
        DailyBriefSend,
        DailyBriefSend.of({
          send: (text) =>
            Effect.sync(() => {
              sent.push(text);
            }),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
};

const pipelineLayer = (brief: Layer.Layer<DailyBrief>) =>
  runsLayer.pipe(
    Layer.provide(brief),
    Layer.provide(
      Layer.succeed(
        PipelineGitHubIssues,
        PipelineGitHubIssues.of({
          listEligible: () => Effect.succeed([]),
          read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(PipelineUsage, PipelineUsage.of({ read: () => Effect.succeed([]) })),
    ),
    Layer.provide(ServerSettings.layerTest({ pipelineEnabled: true })),
    Layer.provide(layerPortsDefault),
    Layer.provide(ClaimLease.layerPort({ repos: ["thoerwink8/fleet-ade"] })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const stuckRun = (issueNumber: number): BriefStuckRun => ({
  issueNumber,
  title: `卡住 ${issueNumber}`,
  reason: "检查红",
});

describe("daily brief", () => {
  it.effect("北京时间 08:30 发一条，键是当天日期，同一天再跑不发第二条", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(8, 30));
      const brief = yield* DailyBrief;
      const first = yield* brief.run;
      yield* brief.run;
      // @effect-diagnostics-next-line globalConsoleInEffect:off -- acceptance output; the test logger swallows Effect.log.
      console.log(`08:30：发送 ${sent.length}，键 ${first.key}`);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(first.key, DAY);
    }).pipe(Effect.provide(briefLayer(Effect.succeed([])))),
  );

  it.effect("00:01 和 08:29 不发也不占今天的键，09:00 没有键就发一条", () =>
    Effect.gen(function* () {
      const brief = yield* DailyBrief;
      yield* TestClock.setTime(at(0, 1));
      yield* brief.run;
      yield* TestClock.setTime(at(8, 29));
      yield* brief.run;
      const before = sent.length;
      yield* TestClock.setTime(at(9, 0));
      const sentAtNine = yield* brief.run;
      // @effect-diagnostics-next-line globalConsoleInEffect:off -- acceptance output; the test logger swallows Effect.log.
      console.log(
        `00:01 和 08:29：发送 ${before}；09:00：发送 ${sent.length}，键 ${sentAtNine.key}`,
      );
      assert.strictEqual(before, 0);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sentAtNine.key, DAY);
    }).pipe(Effect.provide(briefLayer(Effect.succeed([])))),
  );

  it.effect("卡住的运行超过 15 条时只列 15 条，并写另 1 条", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(8, 30));
      yield* (yield* DailyBrief).run;
      const body = sent[0] ?? "";
      const listed = body.split("\n").filter((line) => /^#\d+ /.test(line));
      // @effect-diagnostics-next-line globalConsoleInEffect:off -- acceptance output; the test logger swallows Effect.log.
      console.log(`16 条卡住：列出 ${listed.length}，另 1 条 ${body.includes("另 1 条")}`);
      assert.strictEqual(listed.length, 15);
      assert.strictEqual(body.includes("另 1 条"), true);
      assert.strictEqual(
        listed.some((line) => line.startsWith("#16 ")),
        false,
      );
    }).pipe(
      Effect.provide(
        briefLayer(Effect.succeed(Array.from({ length: 16 }, (_, i) => stuckRun(i + 1)))),
      ),
    ),
  );

  it.effect("运行记录读失败时正文写没查成，照样发", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(8, 30));
      yield* (yield* DailyBrief).run;
      const body = sent[0] ?? "";
      // @effect-diagnostics-next-line globalConsoleInEffect:off -- acceptance output; the test logger swallows Effect.log.
      console.log(`读失败：发送 ${sent.length}，正文含没查成 ${body.includes("没查成")}`);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(body.includes("没查成"), true);
    }).pipe(Effect.provide(briefLayer(Effect.fail(new DailyBriefUnread())))),
  );

  it.effect("流水线 tick：传入的时钟跨过北京时间 08:30 时调用一次", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const spy = Layer.succeed(
        DailyBrief,
        DailyBrief.of({
          run: Ref.update(calls, (n) => n + 1).pipe(Effect.as({ key: null, sent: false })),
        }),
      );
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        yield* TestClock.setTime(at(8, 29));
        yield* runs.tick;
        yield* TestClock.setTime(at(8, 30));
        yield* runs.tick;
        yield* TestClock.setTime(at(9, 0));
        yield* runs.tick;
        const count = yield* Ref.get(calls);
        // @effect-diagnostics-next-line globalConsoleInEffect:off -- acceptance output; the test logger swallows Effect.log.
        console.log(`跨过 08:30：调用 ${count}`);
        assert.strictEqual(count, 1);
      }).pipe(Effect.provide(pipelineLayer(spy)));
    }),
  );
});
