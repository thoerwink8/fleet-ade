import { PIPELINE_METRIC_UNREAD, type PipelineRun } from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PIPELINE_HOST } from "./GitHubIssues.ts";
import { PipelineRuns, type PipelineRunNote } from "./PipelineRuns.ts";
import { parseRepo } from "./repoAllowlist.ts";

const TICK_INTERVAL = Duration.minutes(5);
const CI_WORKFLOW = "CI";

/** A number was read, the read failed, or the workflow has not reached a job start yet. */
export type MetricRead = "pending" | typeof PIPELINE_METRIC_UNREAD | number;

const PullCommits = Schema.Struct({
  commits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const WorkflowRun = Schema.Struct({
  id: Schema.Int,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
});
const WorkflowRunsPage = Schema.Struct({
  total_count: Schema.optional(Schema.Int),
  workflow_runs: Schema.Array(WorkflowRun),
});
const JobsPage = Schema.Struct({
  total_count: Schema.optional(Schema.Int),
  jobs: Schema.Array(
    Schema.Struct({
      started_at: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const decodePull = Schema.decodeUnknownEffect(Schema.fromJsonString(PullCommits));
const decodeRuns = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRunsPage));
const decodeJobs = Schema.decodeUnknownEffect(Schema.fromJsonString(JobsPage));

export interface QueueInput {
  readonly createdAt: string | null;
  readonly runCompleted: boolean;
  readonly jobs: ReadonlyArray<{ readonly startedAt: string | null }>;
  readonly jobsTruncated: boolean;
}

/**
 * Milliseconds from workflow creation to the first job start.
 * A clock that runs backwards is unreadable. A job that has not started is not zero.
 */
export function queueMillis(input: QueueInput): MetricRead {
  if (input.jobsTruncated) return PIPELINE_METRIC_UNREAD;
  const started: number[] = [];
  for (const job of input.jobs) {
    if (job.startedAt === null) continue;
    const at = Date.parse(job.startedAt);
    if (!Number.isFinite(at)) return PIPELINE_METRIC_UNREAD;
    started.push(at);
  }
  if (started.length === 0) {
    return input.runCompleted ? PIPELINE_METRIC_UNREAD : "pending";
  }
  const created = input.createdAt === null ? Number.NaN : Date.parse(input.createdAt);
  if (!Number.isFinite(created)) return PIPELINE_METRIC_UNREAD;
  const earliest = Math.min(...started);
  if (earliest < created) return PIPELINE_METRIC_UNREAD;
  return earliest - created;
}

const isFillTarget = (run: PipelineRun): boolean =>
  run.status !== "merged" && !(run.status === "stuck" && run.stuckReason === "取消");

interface RunMetricsShape {
  readonly tick: Effect.Effect<void, never>;
}

export class RunMetrics extends Context.Service<RunMetrics, RunMetricsShape>()(
  "t3/pipeline/runMetrics",
) {}

const make = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;
  const runs = yield* PipelineRuns;
  const settings = yield* ServerSettings.ServerSettingsService;
  const slugFor = (repository: string): string | undefined => {
    const parsed = parseRepo(repository);
    if (parsed === undefined) return undefined;
    return `${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
  };

  const fetchJson = (operation: string, path: string) =>
    rest
      .rest({ host: PIPELINE_HOST, operation, path })
      .pipe(
        Effect.map((response) =>
          response.status >= 200 && response.status < 300 && !response.truncated
            ? response.body
            : undefined,
        ),
      );

  const readCommits = Effect.fn("RunMetrics.readCommits")(function* (
    repository: string,
    prNumber: number,
  ) {
    const slug = slugFor(repository);
    if (slug === undefined) return PIPELINE_METRIC_UNREAD;
    const body = yield* fetchJson("pipelineCommitCount", `repos/${slug}/pulls/${prNumber}`).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (body === undefined) return PIPELINE_METRIC_UNREAD;
    const decoded = yield* decodePull(body).pipe(Effect.option);
    return decoded._tag === "Some" ? decoded.value.commits : PIPELINE_METRIC_UNREAD;
  });

  const readQueue = Effect.fn("RunMetrics.readQueue")(function* (
    repository: string,
    headSha: string,
    waitingForCheck: boolean,
  ) {
    const slug = slugFor(repository);
    if (slug === undefined) return PIPELINE_METRIC_UNREAD;
    const body = yield* fetchJson(
      "pipelineCiQueueRuns",
      `repos/${slug}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (body === undefined) return PIPELINE_METRIC_UNREAD;
    const decoded = yield* decodeRuns(body).pipe(Effect.option);
    if (decoded._tag === "None") return PIPELINE_METRIC_UNREAD;
    const page = decoded.value;
    const named = page.workflow_runs.filter((run) => run.name === CI_WORKFLOW);
    if (named.length === 0) {
      const cutOff =
        page.workflow_runs.length === 100 &&
        (page.total_count === undefined || page.total_count > page.workflow_runs.length);
      // Still waiting for the first CI run is not a failed read and not a zero queue.
      return cutOff ? PIPELINE_METRIC_UNREAD : waitingForCheck ? "pending" : PIPELINE_METRIC_UNREAD;
    }
    const latest = named.reduce((best, run) => (run.id > best.id ? run : best));
    const jobsBody = yield* fetchJson(
      "pipelineCiQueueJobs",
      `repos/${slug}/actions/runs/${latest.id}/jobs?per_page=100`,
    ).pipe(Effect.orElseSucceed(() => undefined));
    if (jobsBody === undefined) return PIPELINE_METRIC_UNREAD;
    const jobs = yield* decodeJobs(jobsBody).pipe(Effect.option);
    if (jobs._tag === "None") return PIPELINE_METRIC_UNREAD;
    const truncated =
      jobs.value.jobs.length === 100 &&
      (jobs.value.total_count === undefined || jobs.value.total_count > jobs.value.jobs.length);
    return queueMillis({
      createdAt: latest.created_at ?? null,
      runCompleted: latest.status === "completed",
      jobs: jobs.value.jobs.map((job) => ({ startedAt: job.started_at ?? null })),
      jobsTruncated: truncated,
    });
  });

  const tick = Effect.gen(function* () {
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((value) => value.pipelineEnabled),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return;
    const listed = yield* runs.list.pipe(Effect.orElseSucceed(() => undefined));
    if (listed === undefined) return;
    const targets = new Map<string, PipelineRun>();
    for (const run of listed.runs) {
      if (run.prNumber === null) continue;
      const key = `${run.repository}#${run.issueNumber}`;
      const known = targets.get(key);
      if (known === undefined || (isFillTarget(run) && !isFillTarget(known))) {
        targets.set(key, run);
      }
    }
    for (const run of targets.values()) {
      const commitSettled = run.commitCount !== null || run.commitNote !== null;
      const queueSettled = run.ciQueueMs !== null || run.ciQueueNote !== null;
      if (commitSettled && queueSettled) continue;
      const prNumber = run.prNumber;
      if (prNumber === null) continue;
      const commit = commitSettled
        ? ("pending" as const)
        : yield* readCommits(run.repository, prNumber);
      const queue =
        queueSettled || run.headSha === null
          ? ("pending" as const)
          : yield* readQueue(
              run.repository,
              run.headSha,
              run.status === "pr-open" || run.status === "checks",
            );
      const patch: PipelineRunNote = {
        ...(typeof commit === "number" ? { commitCount: commit } : {}),
        ...(commit === PIPELINE_METRIC_UNREAD ? { commitNote: PIPELINE_METRIC_UNREAD } : {}),
        ...(typeof queue === "number" ? { ciQueueMs: queue } : {}),
        ...(queue === PIPELINE_METRIC_UNREAD ? { ciQueueNote: PIPELINE_METRIC_UNREAD } : {}),
      };
      if (
        patch.commitCount === undefined &&
        patch.commitNote === undefined &&
        patch.ciQueueMs === undefined &&
        patch.ciQueueNote === undefined
      ) {
        continue;
      }
      yield* runs.note(run.issueNumber, patch, run.repository).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pipeline.run-metrics.note-failed", {
            issueNumber: run.issueNumber,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  }).pipe(Effect.withSpan("RunMetrics.tick"));

  return RunMetrics.of({ tick });
});

export const layer = Layer.effect(RunMetrics, make);

export const layerLive = layer.pipe(Layer.provide(GitHubRest.layerWithDependencies));

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const metrics = yield* RunMetrics;
    yield* forkParked(
      metrics.tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pipeline.run-metrics.tick-failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
      ),
    );
  }),
);
