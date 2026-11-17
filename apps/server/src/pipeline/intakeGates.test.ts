import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  PipelineGitHubIssues,
  PipelineIssuesIncompleteError,
  type PipelineIssue,
} from "./GitHubIssues.ts";
import {
  IntakeWhitelistUnread,
  PipelineIntakePorts,
  decideIntake,
  defaultWhitelist,
  layerPortsDefault,
  type IntakeCandidate,
  type PrerequisiteState,
} from "./intakeGates.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
import * as ClaimLease from "./claimLease.ts";

const OPENED_AT = "2020-01-01T00:00:00.000Z";
const OLD = "2019-06-01T00:00:00.000Z";
const NEW = "2021-06-01T00:00:00.000Z";
const OWNER = { login: "thoerwink8", id: 1, type: "User" };
const OUTSIDER = { login: "stranger", id: 2, type: "User" };

const done = (item: string) => `## 怎么算做完
- ${item}
`;

const paths = (count: number) =>
  `${done("跑通测试")}
## 已知的模块
${Array.from({ length: count }, (_, index) => `- \`apps/mod/file${index}.ts\``).join("\n")}
`;

const issue = (
  number: number,
  body: string,
  labels: ReadonlyArray<string>,
  createdAt: string,
  author: PipelineIssue["author"] = OWNER,
): PipelineIssue => ({
  number,
  title: `单 ${number}`,
  body,
  labels: [...labels],
  author,
  createdAt,
});

const base = done("跑通测试");

const cases: ReadonlyArray<PipelineIssue> = [
  issue(1, base, ["交给 ADE"], OLD),
  issue(2, `${base}\n.github/workflows/ci.yml\n`, ["交给 ADE"], OLD, OUTSIDER),
  issue(3, base, ["本机做", "交给 ADE"], OLD),
  issue(5, `前置：#60\n\n${base}`, ["交给 ADE"], OLD),
  issue(6, `前置：2099-01-01\n\n${base}`, ["交给 ADE"], OLD),
  issue(7, `前置：#61\n\n${base}`, ["交给 ADE"], OLD),
  issue(8, `前置：#62\n\n${base}`, ["交给 ADE"], OLD),
  issue(9, done("截图给创始人看"), ["交给 ADE"], OLD),
  issue(10, done("去现场看一眼"), ["交给 ADE"], OLD),
  issue(11, done("看日志确认"), ["交给 ADE"], OLD),
  issue(12, done("线上行为由测试断言"), ["交给 ADE"], OLD),
  issue(13, paths(50), ["交给 ADE"], OLD),
  issue(14, paths(51), ["交给 ADE"], OLD),
  issue(15, base, [], OLD),
  issue(16, base, ["整理过"], OLD),
  issue(18, base, ["待补", "交给 ADE"], OLD),
  issue(19, base, ["要人拍", "整理过"], OLD),
  issue(20, base, [], NEW),
];

const stateOf = (number: number): PrerequisiteState =>
  number === 60 ? "open" : number === 62 ? "closed" : "unread";

const candidate = (item: PipelineIssue): IntakeCandidate => ({
  number: item.number,
  title: item.title,
  body: item.body,
  labels: item.labels,
  author: item.author ?? null,
  createdAt: item.createdAt ?? null,
});

const facts = {
  whitelist: defaultWhitelist(),
  openedAt: OPENED_AT,
  now: DateTime.makeUnsafe("2026-06-01T00:00:00.000Z"),
  prerequisiteState: stateOf,
};

const gateLayer = (
  listed: ReadonlyArray<PipelineIssue>,
  ports: Layer.Layer<PipelineIntakePorts> = layerPortsDefault,
) =>
  runsLayer.pipe(
    Layer.provide(
      Layer.succeed(PipelineGitHubIssues, {
        addLabel: () => Effect.die("unexpected label write"),
        listEligible: () => Effect.succeed(listed),
        read: (number: number) => {
          const state = stateOf(number);
          if (state === "unread") {
            return Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" }));
          }
          return Effect.succeed({ ...issue(number, "", [], OLD, null), state });
        },
      }),
    ),
    Layer.provide(Layer.succeed(PipelineUsage, { read: () => Effect.succeed([]) })),
    Layer.provide(ports),
    Layer.provide(
      ServerSettings.layerTest({ pipelineEnabled: true, pipelineEnabledAt: OPENED_AT }),
    ),
    Layer.provide(ClaimLease.layerPort({ repos: ["thoerwink8/fleet-ade"] })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const pulled = (listed: ReadonlyArray<PipelineIssue>, ports?: Layer.Layer<PipelineIntakePorts>) =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    yield* runs.tick;
    return yield* runs.list;
  }).pipe(Effect.provide(gateLayer(listed, ports)));

const hasRun = (
  listed: { readonly runs: ReadonlyArray<{ readonly issueNumber: number }> },
  number: number,
) => listed.runs.some((run) => run.issueNumber === number);

const word = (present: boolean) => (present ? "有运行" : "没有运行");

describe("intake gates", () => {
  it.effect("六道门：该拉的有运行，不该拉的没有运行", () =>
    Effect.gen(function* () {
      const listed = yield* pulled(cases);
      const blocked = yield* pulled(
        [issue(99, base, ["交给 ADE"], OLD)],
        Layer.succeed(PipelineIntakePorts, {
          readWhitelist: Effect.fail(new IntakeWhitelistUnread({ detail: "白名单读不到" })),
        }),
      );
      const reason = (number: number) => {
        const found = cases.find((item) => item.number === number);
        if (found === undefined) return "";
        const decision = decideIntake(candidate(found), facts);
        return decision.pull ? "" : decision.reason;
      };
      const trusted = hasRun(listed, 1);
      const outsider = hasRun(listed, 2);
      const unread = hasRun(blocked, 99);
      const both = hasRun(listed, 3);
      const adeOnly = hasRun(listed, 1);
      const waitingIssue = hasRun(listed, 5);
      const waitingDate = hasRun(listed, 6);
      const waitingUnread = hasRun(listed, 7);
      const prereqClosed = hasRun(listed, 8);
      const screenshot = hasRun(listed, 9);
      const scene = hasRun(listed, 10);
      const logs = hasRun(listed, 11);
      const online = hasRun(listed, 12);
      const fifty = hasRun(listed, 13);
      const fiftyOne = hasRun(listed, 14);
      const ungroomed = hasRun(listed, 15);
      const groomed = hasRun(listed, 16);
      const pending = hasRun(listed, 18);
      const human = hasRun(listed, 19);
      const fresh = hasRun(listed, 20);
      const lines = [
        `门1 白名单：在名单里${word(trusted)}；不在名单里${word(outsider)}；读不到${word(unread)}`,
        `门2 本机做：和「交给 ADE」一起贴${word(both)}；只贴「交给 ADE」${word(adeOnly)}`,
        `门3 前置：${reason(5)} ${word(waitingIssue)}；${reason(6)} ${word(waitingDate)}；${reason(7)} ${word(waitingUnread)}；前置已关${word(prereqClosed)}`,
        `门4 diff外：截图${word(screenshot)}；现场${word(scene)}；看日志${word(logs)}；线上写了测试${word(online)}`,
        `门5 路径：50 个${word(fifty)}；51 个${word(fiftyOne)}`,
        `门6 老单：没整理过${word(ungroomed)}；整理过${word(groomed)}；交给 ADE ${word(trusted)}；待补${word(pending)}；要人拍${word(human)}；打开之后的新单${word(fresh)}`,
      ];
      // @effect-diagnostics-next-line globalConsoleInEffect:off -- these lines are the acceptance output; the test logger swallows Effect.log.
      for (const line of lines) console.log(line);
      assert.deepStrictEqual(
        [trusted, adeOnly, prereqClosed, online, fifty, groomed, fresh],
        [true, true, true, true, true, true, true],
      );
      assert.deepStrictEqual(
        [
          outsider,
          unread,
          both,
          waitingIssue,
          waitingDate,
          waitingUnread,
          screenshot,
          scene,
          logs,
          fiftyOne,
          ungroomed,
          pending,
          human,
        ],
        [false, false, false, false, false, false, false, false, false, false, false, false, false],
      );
      assert.strictEqual(reason(5), "等前置 #60");
      assert.strictEqual(reason(6), "等到 2099-01-01");
      assert.ok(reason(7).includes("等前置"));
      assert.ok(reason(7).includes("没查成"));
      assert.strictEqual(blocked.lastTick?.outcome, "failed");
      assert.ok(blocked.lastTick?.detail?.includes("白名单"));
      assert.strictEqual(
        listed.runs.find((run) => run.issueNumber === 2),
        undefined,
      );
    }),
  );
});
