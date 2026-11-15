import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, PipelineRunReadError } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubIssues from "./GitHubIssues.ts";
import * as PipelineRuns from "./PipelineRuns.ts";

const ACCEPTANCE = "怎么算做完\n- 过";
const WINDOW_START = "1970-01-01T00:00:00.000Z";
const WINDOW_END = "1970-01-01T00:01:00.000Z";

const issue = (number: number, body = ACCEPTANCE): GitHubIssues.PipelineIssue => ({
  number,
  title: `单 ${number}`,
  body,
  labels: [],
});

const USAGE_CSV = [
  "plugin: host skipped",
  "time,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,cost_usd,provider_account",
  "1970-01-01T00:00:30.000Z,10,2,1,4,0.5,acct-a",
  '1970-01-01T00:00:40.000Z,1,1,0,0,0.25,"acct,a"',
  "1970-01-01T00:02:00.000Z,100,7,0,0,9,acct-b",
].join("\n");

interface LayerOptions {
  readonly issues: () => Effect.Effect<
    ReadonlyArray<GitHubIssues.PipelineIssue>,
    GitHubIssues.PipelineIssuesIncompleteError
  >;
  readonly enabled?: boolean;
  readonly readCsv?: (started: string) => Effect.Effect<string, PipelineRunReadError>;
}

const openOn = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, options: LayerOptions) =>
  PipelineRuns.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        database,
        ServerSettings.layerTest({ pipelineEnabled: options.enabled ?? true }),
        Layer.succeed(
          GitHubIssues.PipelineGitHubIssues,
          GitHubIssues.PipelineGitHubIssues.of({
            listEligible: () => options.issues(),
            read: () =>
              Effect.fail(new GitHubIssues.PipelineIssuesIncompleteError({ reason: "truncated" })),
          }),
        ),
        Layer.succeed(
          PipelineRuns.PipelineMagpieUsage,
          PipelineRuns.PipelineMagpieUsage.of({
            readCsv:
              options.readCsv ??
              (() => Effect.fail(new PipelineRunReadError({ message: "读不到" }))),
          }),
        ),
      ),
    ),
  );

const layerFor = (options: LayerOptions) => openOn(SqlitePersistence.layerMemory, options);

it("cuts magpie usage to the session window and refuses a bad figure", () => {
  assert.strictEqual(
    PipelineRuns.magpieLastArgument("1970-01-01T00:00:00.000Z", 90 * 60_000),
    "91m",
  );
  assert.strictEqual(PipelineRuns.magpieLastArgument("1970-01-01T00:02:00.000Z", 0), null);
  assert.deepStrictEqual(PipelineRuns.sliceMagpieUsageCsv(USAGE_CSV, WINDOW_START, WINDOW_END), {
    read: true,
    magpieAccount: "acct,a、acct-a",
    inputTokens: 11,
    outputTokens: 3,
    cacheTokens: 5,
    convertedCost: "0.75",
  });
  assert.deepStrictEqual(
    PipelineRuns.sliceMagpieUsageCsv(
      "time,cost_usd\n1970-01-01T00:00:30.000Z,1",
      WINDOW_START,
      WINDOW_END,
    ),
    { read: false },
  );
  assert.deepStrictEqual(
    PipelineRuns.sliceMagpieUsageCsv(
      [
        "time,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,cost_usd,provider_account",
        "1970-01-01T00:00:30.000Z,1,1,0,0,n/a,acct-a",
      ].join("\n"),
      WINDOW_START,
      WINDOW_END,
    ),
    { read: false },
  );
  assert.deepStrictEqual(PipelineRuns.sliceMagpieUsageCsv("", WINDOW_START, WINDOW_END), {
    read: false,
  });
});

it("defaults the pipeline switch to off", () => {
  assert.strictEqual(DEFAULT_SERVER_SETTINGS.pipelineEnabled, false);
});

it.effect("two ticks of one issue keep a single run", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns.PipelineRuns;
    assert.strictEqual((yield* runs.tick()).outcome, "ok");
    assert.strictEqual((yield* runs.tick()).outcome, "ok");
    const listed = yield* runs.list();
    assert.strictEqual(listed.runs.length, 1);
    assert.strictEqual(listed.runs[0]?.issueNumber, 4);
    assert.strictEqual(listed.runs[0]?.status, "claimed");
    assert.strictEqual(listed.lastTick?.outcome, "ok");
  }).pipe(Effect.provide(layerFor({ issues: () => Effect.succeed([issue(4)]) }))),
);

it.effect("does not read or write while the switch is off", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns.PipelineRuns;
    assert.strictEqual((yield* runs.tick()).outcome, "disabled");
    const listed = yield* runs.list();
    assert.strictEqual(listed.runs.length, 0);
    assert.strictEqual(listed.lastTick, null);
  }).pipe(
    Effect.provide(
      layerFor({
        enabled: false,
        issues: () => Effect.die("the switch is off, so the tick must not read issues"),
      }),
    ),
  ),
);

it.effect("records a failed issue read and keeps runs it already had", () => {
  const fail = { current: false };
  return Effect.gen(function* () {
    const runs = yield* PipelineRuns.PipelineRuns;
    assert.strictEqual((yield* runs.tick()).outcome, "ok");
    fail.current = true;
    assert.strictEqual((yield* runs.tick()).outcome, "read-failed");
    const listed = yield* runs.list();
    assert.strictEqual(listed.runs.map((run) => run.issueNumber).join(","), "5");
    assert.strictEqual(listed.lastTick?.outcome, "read-failed");
    assert.strictEqual(listed.lastTick?.detail, "PipelineIssuesIncompleteError:truncated");
  }).pipe(
    Effect.provide(
      layerFor({
        issues: () =>
          fail.current
            ? Effect.fail(new GitHubIssues.PipelineIssuesIncompleteError({ reason: "truncated" }))
            : Effect.succeed([issue(5), issue(6, "没有验收")]),
      }),
    ),
  );
});

it.effect("sticks a workflow issue for a person and does not open a session", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns.PipelineRuns;
    assert.strictEqual((yield* runs.tick()).outcome, "ok");
    assert.strictEqual((yield* runs.tick()).outcome, "ok");
    const listed = yield* runs.list();
    assert.strictEqual(listed.runs.length, 1);
    assert.strictEqual(listed.runs[0]?.status, "stuck");
    assert.strictEqual(listed.runs[0]?.stuckReason, "交人");
    assert.strictEqual(listed.runs[0]?.threadId, null);
    assert.strictEqual(listed.runs[0]?.prNumber, null);
  }).pipe(
    Effect.provide(
      layerFor({
        issues: () =>
          Effect.succeed([issue(8, `${ACCEPTANCE}\n改 \`.github/workflows/\` 里的文件`)]),
      }),
    ),
  ),
);

it.effect("claims again after a run is merged or canceled", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns.PipelineRuns;
    yield* runs.tick();
    yield* runs.note(1, { status: "stuck", stuckReason: "取消" });
    yield* runs.note(2, { status: "merged" });
    yield* runs.tick();
    const listed = yield* runs.list();
    const counts = new Map<number, number>();
    for (const run of listed.runs) {
      counts.set(run.issueNumber, (counts.get(run.issueNumber) ?? 0) + 1);
    }
    assert.strictEqual(counts.get(1), 2);
    assert.strictEqual(counts.get(2), 2);
    assert.strictEqual(
      listed.runs
        .filter((run) => run.status === "claimed")
        .map((run) => run.issueNumber)
        .sort()
        .join(","),
      "1,2",
    );
  }).pipe(Effect.provide(layerFor({ issues: () => Effect.succeed([issue(1), issue(2)]) }))),
);

it.effect("does not claim another issue while a session is open", () => {
  const listed = [issue(1)];
  return Effect.gen(function* () {
    const runs = yield* PipelineRuns.PipelineRuns;
    yield* runs.tick();
    yield* runs.note(1, { status: "session", threadId: "thread-1" });
    listed.push(issue(2));
    listed.push(issue(3, `${ACCEPTANCE}\n.github/workflows/ci.yml`));
    yield* runs.tick();
    const result = yield* runs.list();
    assert.strictEqual(
      result.runs
        .map((run) => `${run.issueNumber}:${run.status}`)
        .sort()
        .join(","),
      "1:session,3:stuck",
    );
  }).pipe(Effect.provide(layerFor({ issues: () => Effect.succeed(listed) })));
});

it.effect("writes 读不到 instead of zeroes when usage cannot be read", () =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns.PipelineRuns;
    yield* runs.tick();
    yield* runs.note(9, {
      sessionStartedAt: WINDOW_START,
      sessionEndedAt: WINDOW_END,
      prNumber: 12,
      commitCount: 1,
      ciQueueMs: 120_000,
    });
    yield* runs.tick();
    const listed = yield* runs.list();
    const run = listed.runs[0];
    assert.strictEqual(run?.usageState, "unread");
    assert.strictEqual(run?.usageNote, "读不到");
    assert.strictEqual(run?.inputTokens, null);
    assert.strictEqual(run?.outputTokens, null);
    assert.strictEqual(run?.cacheTokens, null);
    assert.strictEqual(run?.convertedCost, null);
    assert.strictEqual(run?.costLabel, "折算");
    assert.strictEqual(run?.prNumber, 12);
    assert.strictEqual(run?.ciQueueMs, 120_000);
    assert.strictEqual(listed.summary.averageConvertedCost, null);
    assert.strictEqual(listed.summary.costLabel, "折算");
  }).pipe(Effect.provide(layerFor({ issues: () => Effect.succeed([issue(9)]) }))),
);

it.effect("fills the session window from magpie usage and summarizes the latest 20", () => {
  let reads = 0;
  return Effect.gen(function* () {
    const runs = yield* PipelineRuns.PipelineRuns;
    const sql = yield* SqlClient.SqlClient;
    yield* runs.tick();
    yield* sql`UPDATE pipeline_runs SET commit_count = 9 WHERE issue_number = 1`;
    yield* runs.note(2, { commitCount: 1 });
    yield* runs.note(21, {
      commitCount: 3,
      sessionStartedAt: WINDOW_START,
      sessionEndedAt: WINDOW_END,
      headSha: "abc",
      threadId: "thread-21",
    });
    yield* runs.tick();
    yield* runs.tick();
    const listed = yield* runs.list();
    assert.strictEqual(listed.runs.length, 21);
    assert.strictEqual(listed.recent.length, 20);
    assert.strictEqual(
      listed.recent.some((run) => run.issueNumber === 1),
      false,
    );
    const filled = listed.runs.find((run) => run.issueNumber === 21);
    assert.strictEqual(filled?.magpieAccount, "acct,a、acct-a");
    assert.strictEqual(filled?.inputTokens, 11);
    assert.strictEqual(filled?.outputTokens, 3);
    assert.strictEqual(filled?.cacheTokens, 5);
    assert.strictEqual(filled?.convertedCost, "0.75");
    assert.strictEqual(filled?.costLabel, "折算");
    assert.strictEqual(filled?.usageNote, null);
    assert.strictEqual(filled?.headSha, "abc");
    assert.strictEqual(listed.summary.reworkRate, 0.5);
    assert.strictEqual(listed.summary.averageDurationMs, 60_000);
    assert.strictEqual(listed.summary.averageConvertedCost, "0.75");
    assert.strictEqual(listed.summary.costLabel, "折算");
    assert.strictEqual(reads, 1);
  }).pipe(
    Effect.provide(
      layerFor({
        issues: () => Effect.succeed(Array.from({ length: 21 }, (_, index) => issue(index + 1))),
        readCsv: () =>
          Effect.sync(() => {
            reads += 1;
            return USAGE_CSV;
          }),
      }),
    ),
  );
});

it.effect("keeps runs after the database is reopened", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pipeline-runs-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"));
    const open = openOn(database, {
      issues: () => Effect.succeed([issue(7)]),
    });
    yield* Effect.gen(function* () {
      const runs = yield* PipelineRuns.PipelineRuns;
      assert.strictEqual((yield* runs.tick()).outcome, "ok");
    }).pipe(Effect.provide(open));
    const listed = yield* Effect.gen(function* () {
      const runs = yield* PipelineRuns.PipelineRuns;
      return yield* runs.list();
    }).pipe(Effect.provide(open));
    assert.strictEqual(listed.runs.length, 1);
    assert.strictEqual(listed.runs[0]?.issueNumber, 7);
    assert.strictEqual(listed.runs[0]?.title, "单 7");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
