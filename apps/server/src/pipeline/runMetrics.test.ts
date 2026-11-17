import { assert, describe, it } from "@effect/vitest";
import { PIPELINE_METRIC_UNREAD } from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  PipelineGitHubIssues,
  PipelineIssuesIncompleteError,
  type PipelineIssue,
} from "./GitHubIssues.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
import { layerPortsDefault } from "./intakeGates.ts";
import { RunMetrics, layer, queueMillis } from "./runMetrics.ts";
import * as ClaimLease from "./claimLease.ts";

const SHA = "abc123";
const CREATED = "2026-01-01T00:00:00.000Z";

const issue = (number: number): PipelineIssue => ({
  number,
  title: `单 ${number}`,
  body: "## 怎么算做完\n- 跑通测试\n",
  labels: ["交给 ADE"],
  author: { login: "thoerwink8", id: 1, type: "User" },
});

const json = (status: number, body: unknown, truncated = false): GitHubRest.GitHubRestResponse => ({
  status,
  headers: {},
  body: typeof body === "string" ? body : JSON.stringify(body),
  truncated,
  invalidUtf8: false,
});

const pull = (commits: number) => json(200, { commits });

const ciRuns = (
  runs: ReadonlyArray<{ readonly id: number; readonly name: string; readonly status: string }>,
  total = runs.length,
) =>
  json(200, {
    total_count: total,
    workflow_runs: runs.map((run) => ({ ...run, created_at: CREATED })),
  });

const jobs = (startedAt: Array<string | null>, total = startedAt.length) =>
  json(200, {
    total_count: total,
    jobs: startedAt.map((started_at) => ({ started_at })),
  });

const stack = (input: {
  readonly calls: Ref.Ref<ReadonlyArray<string>>;
  readonly route: (path: string) => GitHubRest.GitHubRestResponse;
  readonly enabled?: boolean;
}) => {
  const rest = Layer.succeed(GitHubRest.GitHubRest, {
    rest: (request: { readonly path: string }) =>
      Ref.update(input.calls, (paths) => [...paths, request.path]).pipe(
        Effect.as(input.route(request.path)),
      ),
    credential: () => Effect.die("unused"),
    appCredential: () => Effect.die("unused"),
  } as GitHubRest.GitHubRest["Service"]);
  const runs = runsLayer.pipe(
    Layer.provide(
      Layer.succeed(PipelineGitHubIssues, {
        addLabel: () => Effect.die("unexpected label write"),
        listEligible: () => Effect.succeed([issue(7)]),
        read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
      }),
    ),
    Layer.provide(Layer.succeed(PipelineUsage, { read: () => Effect.succeed([]) })),
    Layer.provide(ServerSettings.layerTest({ pipelineEnabled: true })),
    Layer.provide(layerPortsDefault),
    Layer.provide(ClaimLease.layerPort({ repos: ["thoerwink8/fleet-ade"] })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return layer.pipe(
    Layer.provide(rest),
    Layer.provide(ServerSettings.layerTest({ pipelineEnabled: input.enabled ?? true })),
    Layer.provideMerge(runs),
  );
};

const runFor = (status: "checks" | "verify") =>
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    yield* runs.tick;
    yield* runs.note(7, { status, prNumber: 12, headSha: SHA });
    return runs;
  });

describe("queueMillis", () => {
  it("keeps a backwards clock or a cut-off job list unreadable", () => {
    assert.strictEqual(
      queueMillis({
        createdAt: "2026-01-01T00:01:00.000Z",
        runCompleted: true,
        jobs: [{ startedAt: CREATED }],
        jobsTruncated: false,
      }),
      PIPELINE_METRIC_UNREAD,
    );
    assert.strictEqual(
      queueMillis({
        createdAt: CREATED,
        runCompleted: true,
        jobs: [{ startedAt: "not-a-time" }],
        jobsTruncated: false,
      }),
      PIPELINE_METRIC_UNREAD,
    );
    assert.strictEqual(
      queueMillis({
        createdAt: CREATED,
        runCompleted: false,
        jobs: [{ startedAt: null }],
        jobsTruncated: true,
      }),
      PIPELINE_METRIC_UNREAD,
    );
  });

  it("does not treat a job that has not started as zero", () => {
    assert.strictEqual(
      queueMillis({
        createdAt: CREATED,
        runCompleted: false,
        jobs: [{ startedAt: null }],
        jobsTruncated: false,
      }),
      "pending",
    );
    assert.strictEqual(
      queueMillis({
        createdAt: CREATED,
        runCompleted: true,
        jobs: [{ startedAt: null }],
        jobsTruncated: false,
      }),
      PIPELINE_METRIC_UNREAD,
    );
    assert.strictEqual(
      queueMillis({
        createdAt: CREATED,
        runCompleted: true,
        jobs: [{ startedAt: "2026-01-01T00:01:30.000Z" }],
        jobsTruncated: false,
      }),
      90_000,
    );
  });
});

describe("RunMetrics", () => {
  it.effect("a failed read is 没查成 and a later tick does not replace it with zero", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      let failing = true;
      const route = (path: string) => {
        if (failing) return json(500, "");
        if (path.includes("/pulls/")) return pull(0);
        if (path.endsWith("/jobs?per_page=100")) return jobs([CREATED]);
        return ciRuns([{ id: 9, name: "CI", status: "completed" }]);
      };
      yield* Effect.gen(function* () {
        const runs = yield* runFor("checks");
        const metrics = yield* RunMetrics;
        yield* metrics.tick;
        const failed = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(failed?.commitCount, null);
        assert.strictEqual(failed?.commitNote, PIPELINE_METRIC_UNREAD);
        assert.strictEqual(failed?.ciQueueMs, null);
        assert.strictEqual(failed?.ciQueueNote, PIPELINE_METRIC_UNREAD);
        failing = false;
        yield* metrics.tick;
        const again = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(again?.commitCount, null);
        assert.strictEqual(again?.commitNote, PIPELINE_METRIC_UNREAD);
        assert.strictEqual(again?.ciQueueNote, PIPELINE_METRIC_UNREAD);
        assert.strictEqual((yield* Ref.get(calls)).length, 2);
      }).pipe(Effect.provide(stack({ calls, route })));
    }),
  );

  it.effect("stores a real zero and leaves a queued run unread", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      let started: string | null = CREATED;
      let runStatus = "completed";
      const route = (path: string) => {
        if (path.includes("/pulls/")) return pull(0);
        if (path.endsWith("/jobs?per_page=100")) return jobs([started]);
        return ciRuns([{ id: 9, name: "CI", status: runStatus }]);
      };
      yield* Effect.gen(function* () {
        const runs = yield* runFor("checks");
        const metrics = yield* RunMetrics;
        yield* metrics.tick;
        const zero = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(zero?.commitCount, 0);
        assert.strictEqual(zero?.commitNote, null);
        assert.strictEqual(zero?.ciQueueMs, 0);
        assert.strictEqual(zero?.ciQueueNote, null);

        yield* runs.note(7, { commitCount: null, ciQueueMs: null });
        started = null;
        runStatus = "in_progress";
        yield* metrics.tick;
        const queued = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(queued?.commitCount, 0);
        assert.strictEqual(queued?.ciQueueMs, null);
        assert.strictEqual(queued?.ciQueueNote, null);
      }).pipe(Effect.provide(stack({ calls, route })));
    }),
  );

  it.effect("a missing CI run is pending while checks are open and 没查成 after that", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const route = (path: string) => (path.includes("/pulls/") ? pull(3) : ciRuns([], 0));
      yield* Effect.gen(function* () {
        const runs = yield* runFor("checks");
        const metrics = yield* RunMetrics;
        yield* metrics.tick;
        const waiting = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(waiting?.commitCount, 3);
        assert.strictEqual(waiting?.ciQueueMs, null);
        assert.strictEqual(waiting?.ciQueueNote, null);

        yield* runs.note(7, { status: "verify" });
        yield* metrics.tick;
        const left = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(left?.ciQueueMs, null);
        assert.strictEqual(left?.ciQueueNote, PIPELINE_METRIC_UNREAD);
      }).pipe(Effect.provide(stack({ calls, route })));
    }),
  );

  it.effect("a cut-off page, a bad body, or a non-integer count is 没查成", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      let mode: "jobs" | "list" | "body" | "fraction" = "jobs";
      const route = (path: string) => {
        if (path.includes("/pulls/")) {
          if (mode === "body") return json(200, "not-json");
          if (mode === "fraction") return json(200, { commits: 1.5 });
          return pull(1);
        }
        if (path.endsWith("/jobs?per_page=100")) {
          return jobs(
            Array.from({ length: 100 }, () => CREATED),
            150,
          );
        }
        if (mode === "list") {
          return ciRuns(
            Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              name: "Lint",
              status: "completed",
            })),
            150,
          );
        }
        return ciRuns([{ id: 9, name: "CI", status: "completed" }]);
      };
      yield* Effect.gen(function* () {
        const runs = yield* runFor("checks");
        const metrics = yield* RunMetrics;
        yield* metrics.tick;
        const cutJobs = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(cutJobs?.commitCount, 1);
        assert.strictEqual(cutJobs?.ciQueueNote, PIPELINE_METRIC_UNREAD);

        yield* runs.note(7, { ciQueueNote: null });
        mode = "list";
        yield* metrics.tick;
        const cutList = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(cutList?.ciQueueNote, PIPELINE_METRIC_UNREAD);

        yield* runs.note(7, { commitNote: null, commitCount: null, ciQueueNote: null });
        mode = "body";
        yield* metrics.tick;
        const bad = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(bad?.commitCount, null);
        assert.strictEqual(bad?.commitNote, PIPELINE_METRIC_UNREAD);

        yield* runs.note(7, { commitNote: null });
        mode = "fraction";
        yield* metrics.tick;
        const fraction = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(fraction?.commitCount, null);
        assert.strictEqual(fraction?.commitNote, PIPELINE_METRIC_UNREAD);
      }).pipe(Effect.provide(stack({ calls, route })));
    }),
  );

  it.effect("does not read while the pipeline is off", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* runFor("checks");
        yield* (yield* RunMetrics).tick;
        const run = (yield* runs.list).runs.find((item) => item.issueNumber === 7);
        assert.strictEqual(run?.commitCount, null);
        assert.strictEqual(run?.commitNote, null);
        assert.strictEqual((yield* Ref.get(calls)).length, 0);
      }).pipe(Effect.provide(stack({ calls, route: () => json(500, ""), enabled: false })));
    }),
  );

  it.effect("same issue in two repositories is read and noted separately", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* PipelineRuns;
        yield* sql`
          INSERT INTO pipeline_runs (
            repository, issue_number, title, status, pr_number, head_sha, updated_at
          ) VALUES
            ('thoerwink8/fleet-ade', 7, '单 7', 'checks', 70, ${SHA}, '2026-11-16T00:00:00.000Z'),
            ('acme/widgets', 7, '单 7', 'checks', 71, ${SHA}, '2026-11-16T00:00:00.000Z')
        `;
        yield* (yield* RunMetrics).tick;
        const listed = yield* runs.list;
        assert.strictEqual(
          listed.runs.find((item) => item.repository === "thoerwink8/fleet-ade")?.commitCount,
          2,
        );
        assert.strictEqual(
          listed.runs.find((item) => item.repository === "acme/widgets")?.commitCount,
          5,
        );
        const paths = yield* Ref.get(calls);
        assert.ok(paths.some((path) => path.includes("repos/thoerwink8/fleet-ade/pulls/70")));
        assert.ok(paths.some((path) => path.includes("repos/acme/widgets/pulls/71")));
      }).pipe(
        Effect.provide(
          stack({
            calls,
            route: (path) => pull(path.includes("acme/widgets") ? 5 : 2),
          }),
        ),
      );
    }),
  );
});
