import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { PipelineGitHubIssues, PipelineIssuesIncompleteError } from "./GitHubIssues.ts";
import {
  DailyBrief,
  DailyBriefSend,
  DailyBriefSource,
  DailyBriefUnread,
  layer,
  layerFeishu,
  type BriefStuckRun,
} from "./dailyBrief.ts";
import { FEISHU_WEBHOOK_VARIABLE } from "./feishu.ts";
import { layerPortsDefault } from "./intakeGates.ts";
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
              return { delivered: true as const };
            }),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
};

const pipelineLayer = <E, R>(brief: Layer.Layer<DailyBrief, E, R>) =>
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
          run: Ref.update(calls, (n) => n + 1).pipe(
            Effect.as({ key: DAY, sent: true, reason: null }),
          ),
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

const FAKE_WEBHOOK = "https://feishu.invalid/hook/brief";
const deliveryRequests: Array<{ readonly url: string; readonly body: string }> = [];

const deliveryLayer = (options: {
  readonly webhook: string | undefined;
  readonly status: number;
}) => {
  deliveryRequests.length = 0;
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        deliveryRequests.push({
          url: request.url,
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        return HttpClientResponse.fromWeb(request, new Response(null, { status: options.status }));
      }),
    ),
  );
  const env = Layer.succeed(
    HostProcess.Environment,
    options.webhook === undefined ? {} : { [FEISHU_WEBHOOK_VARIABLE]: options.webhook },
  );
  return layerFeishu.pipe(
    Layer.provide(http),
    Layer.provide(env),
    Layer.provide(SqlitePersistence.layerMemory),
  );
};

describe("daily brief delivery", () => {
  it.effect("没配 webhook 不占键，再跑还报没配", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(8, 30));
      const brief = yield* DailyBrief;
      const first = yield* brief.run;
      const second = yield* brief.run;
      // @effect-diagnostics-next-line globalConsoleInEffect:off -- acceptance output; the test logger swallows Effect.log.
      console.log(
        `没配 webhook：第一次 sent ${first.sent} key ${first.key} reason ${first.reason}；第二次 sent ${second.sent} key ${second.key} reason ${second.reason}；请求 ${deliveryRequests.length}`,
      );
      assert.strictEqual(deliveryRequests.length, 0);
      assert.strictEqual(first.sent, false);
      assert.strictEqual(first.key, null);
      assert.strictEqual(first.reason, `没送出：没配 \`${FEISHU_WEBHOOK_VARIABLE}\``);
      assert.strictEqual(second.sent, false);
      assert.strictEqual(second.key, null);
      assert.strictEqual(second.reason, first.reason);
    }).pipe(Effect.provide(deliveryLayer({ webhook: undefined, status: 200 }))),
  );

  it.effect("HTTP 500 不占键，再跑还请求一次", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(8, 30));
      const brief = yield* DailyBrief;
      const first = yield* brief.run;
      const second = yield* brief.run;
      // @effect-diagnostics-next-line globalConsoleInEffect:off -- acceptance output; the test logger swallows Effect.log.
      console.log(
        `HTTP 500：第一次 sent ${first.sent} key ${first.key} reason ${first.reason}；第二次 sent ${second.sent} key ${second.key}；请求 ${deliveryRequests.length}`,
      );
      assert.strictEqual(first.sent, false);
      assert.strictEqual(first.key, null);
      assert.strictEqual(first.reason, "没送出：HTTP 500");
      assert.strictEqual(second.sent, false);
      assert.strictEqual(second.key, null);
      assert.strictEqual(second.reason, first.reason);
      assert.strictEqual(deliveryRequests.length, 2);
    }).pipe(Effect.provide(deliveryLayer({ webhook: FAKE_WEBHOOK, status: 500 }))),
  );

  it.effect("送出后占键，同一天不再发第二条", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at(8, 30));
      const brief = yield* DailyBrief;
      const first = yield* brief.run;
      const second = yield* brief.run;
      // @effect-diagnostics-next-line globalConsoleInEffect:off -- acceptance output; the test logger swallows Effect.log.
      console.log(
        `送出：第一次 sent ${first.sent} key ${first.key}；第二次 sent ${second.sent} key ${second.key}；请求 ${deliveryRequests.length}`,
      );
      assert.strictEqual(first.sent, true);
      assert.strictEqual(first.key, DAY);
      assert.strictEqual(first.reason, null);
      assert.strictEqual(second.sent, false);
      assert.strictEqual(second.key, DAY);
      assert.strictEqual(second.reason, null);
      assert.strictEqual(deliveryRequests.length, 1);
    }).pipe(Effect.provide(deliveryLayer({ webhook: FAKE_WEBHOOK, status: 200 }))),
  );

  it.effect("HTTP 500 时后面的 tick 再请求一次", () =>
    Effect.gen(function* () {
      const runs = yield* PipelineRuns;
      yield* TestClock.setTime(at(8, 30));
      yield* runs.tick;
      yield* TestClock.setTime(at(9, 0));
      yield* runs.tick;
      // @effect-diagnostics-next-line globalConsoleInEffect:off -- acceptance output; the test logger swallows Effect.log.
      console.log(`HTTP 500 后再 tick：请求 ${deliveryRequests.length}`);
      assert.strictEqual(deliveryRequests.length, 2);
    }).pipe(Effect.provide(pipelineLayer(deliveryLayer({ webhook: FAKE_WEBHOOK, status: 500 })))),
  );
});

describe("daily brief tick retry", () => {
  it.effect("没送出时后面的 tick 再试", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const spy = Layer.succeed(
        DailyBrief,
        DailyBrief.of({
          run: Ref.update(calls, (n) => n + 1).pipe(
            Effect.as({ key: null, sent: false, reason: "没送出：HTTP 500" }),
          ),
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
        console.log(`没送出后再 tick：调用 ${count}`);
        assert.strictEqual(count, 2);
      }).pipe(Effect.provide(pipelineLayer(spy)));
    }),
  );
});
