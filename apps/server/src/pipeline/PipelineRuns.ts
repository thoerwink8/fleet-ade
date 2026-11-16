import {
  PIPELINE_COST_LABEL,
  PIPELINE_RUN_STATUSES,
  PIPELINE_STUCK_REASONS,
  PIPELINE_USAGE_UNREADABLE,
  PipelineRunList,
  PipelineRunsError,
  type PipelineRun,
  type PipelineRunStatus,
  type PipelineStuckReason,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  REPOSITORY,
  PipelineGitHubIssues,
  layer as gitHubIssuesLayer,
  type PipelineIssue,
} from "./GitHubIssues.ts";

/** How often a tick runs. One place. */
const TICK_INTERVAL = Duration.minutes(5);

/** Runs that have started a session and not ended. One place. */
export const MAX_OPEN_SESSIONS = 1;

/** Summary window for the read API. The page shows this many. */
const RECENT_RUNS = 20;

/** JSON file of usage records. Unset means the export cannot be read. */
export const USAGE_EXPORT_VARIABLE = "PIPELINE_USAGE_EXPORT";

const REPOSITORY_NAME = `${REPOSITORY.owner}/${REPOSITORY.name}`;

const WORKFLOWS_PATH = ".github/workflows/";

const TERMINAL_CANCEL: PipelineStuckReason = "取消";

const RunRow = Schema.Struct({
  id: Schema.Int,
  repository: Schema.String,
  issueNumber: Schema.Int,
  title: Schema.String,
  status: Schema.Literals(PIPELINE_RUN_STATUSES),
  stuckReason: Schema.NullOr(Schema.Literals(PIPELINE_STUCK_REASONS)),
  threadId: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(Schema.Int),
  headSha: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  sessionStartedAt: Schema.NullOr(Schema.String),
  sessionEndedAt: Schema.NullOr(Schema.String),
  modelAccount: Schema.NullOr(Schema.String),
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  cacheTokens: Schema.NullOr(Schema.Int),
  convertedCost: Schema.NullOr(Schema.Number),
  usageNote: Schema.NullOr(Schema.Literal(PIPELINE_USAGE_UNREADABLE)),
  commitCount: Schema.NullOr(Schema.Int),
  ciQueueMs: Schema.NullOr(Schema.Int),
  detail: Schema.NullOr(Schema.String),
});
type RunRow = typeof RunRow.Type;

const TickRow = Schema.Struct({
  at: Schema.String,
  outcome: Schema.Literals(["ok", "failed"]),
  detail: Schema.NullOr(Schema.String),
});

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const UsageRecordSchema = Schema.Struct({
  at: Schema.String,
  account: Schema.String.check(Schema.isMinLength(1)),
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheTokens: NonNegativeInt,
  convertedCost: NonNegative,
});

export interface UsageRecord {
  readonly at: string;
  readonly account: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly convertedCost: number;
}

export interface UsageSlice {
  readonly modelAccount: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly convertedCost: number;
}

export class PipelineUsageUnreadable extends Schema.TaggedError<PipelineUsageUnreadable>()(
  "PipelineUsageUnreadable",
  {},
) {
  override get message(): string {
    return PIPELINE_USAGE_UNREADABLE;
  }
}

export class PipelineUsage extends Context.Service<
  PipelineUsage,
  {
    readonly read: () => Effect.Effect<ReadonlyArray<UsageRecord>, PipelineUsageUnreadable>;
  }
>()("t3/pipeline/PipelineRuns/PipelineUsage") {}

export interface PipelineRunNote {
  readonly status?: PipelineRunStatus;
  readonly stuckReason?: PipelineStuckReason | null;
  readonly threadId?: string | null;
  readonly prNumber?: number | null;
  readonly headSha?: string | null;
  readonly sessionStartedAt?: string | null;
  readonly sessionEndedAt?: string | null;
  readonly commitCount?: number | null;
  readonly ciQueueMs?: number | null;
  /** Why this run stopped moving. Not the global tick row. */
  readonly detail?: string | null;
}

interface PipelineRunsShape {
  readonly tick: Effect.Effect<void, PipelineRunsError>;
  readonly list: Effect.Effect<PipelineRunList, PipelineRunsError>;
  readonly note: (
    issueNumber: number,
    patch: PipelineRunNote,
  ) => Effect.Effect<void, PipelineRunsError>;
}

export class PipelineRuns extends Context.Service<PipelineRuns, PipelineRunsShape>()(
  "t3/pipeline/PipelineRuns",
) {}

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(RunRow));
const decodeTick = Schema.decodeUnknownEffect(Schema.NullOr(TickRow));
const decodeList = Schema.decodeUnknownEffect(PipelineRunList);
const decodeUsageFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(UsageRecordSchema)),
);

const sqlFailure = (cause: unknown) => new PipelineRunsError({ cause });

/** Merged, and stuck after a person cancels, no longer block another run. */
const isActiveRun = (run: Pick<RunRow, "status" | "stuckReason">): boolean =>
  run.status !== "merged" && !(run.status === "stuck" && run.stuckReason === TERMINAL_CANCEL);

/** List items under a 怎么算做完 heading. A heading with none does not qualify. */
const acceptanceItemCount = (body: string): number => {
  let inSection = false;
  let count = 0;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(\S.*?)\s*$/.exec(line);
    if (heading !== null) {
      if (inSection) break;
      inSection = heading[2] === "怎么算做完";
      continue;
    }
    if (!inSection) continue;
    if (/^\s*(?:[-*]|\d+[.)])\s+\S/.test(line)) count += 1;
  }
  return count;
};

/** Sum records whose time falls inside the session window, inclusive. */
const sliceUsage = (
  records: ReadonlyArray<UsageRecord>,
  start: string,
  end: string,
): UsageSlice | undefined => {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  const inWindow = records.filter((record) => {
    const at = Date.parse(record.at);
    return Number.isFinite(at) && at >= startMs && at <= endMs;
  });
  const accounts = [...new Set(inWindow.map((record) => record.account))].sort();
  return {
    modelAccount: accounts.length === 0 ? null : accounts.join(","),
    inputTokens: inWindow.reduce((sum, record) => sum + record.inputTokens, 0),
    outputTokens: inWindow.reduce((sum, record) => sum + record.outputTokens, 0),
    cacheTokens: inWindow.reduce((sum, record) => sum + record.cacheTokens, 0),
    convertedCost: inWindow.reduce((sum, record) => sum + record.convertedCost, 0),
  };
};

const summarize = (runs: ReadonlyArray<PipelineRun>) => {
  const recent = runs.slice(0, RECENT_RUNS);
  const withCommits = recent.filter((run) => run.commitCount !== null);
  const durations = recent.flatMap((run) => {
    if (run.sessionStartedAt === null || run.sessionEndedAt === null) return [];
    const ms = Date.parse(run.sessionEndedAt) - Date.parse(run.sessionStartedAt);
    return Number.isFinite(ms) && ms >= 0 ? [ms] : [];
  });
  const costs = recent.flatMap((run) =>
    run.usageNote === null && run.convertedCost !== null ? [run.convertedCost] : [],
  );
  return {
    recent: recent.length,
    reworkRate:
      withCommits.length === 0
        ? null
        : withCommits.filter((run) => (run.commitCount ?? 0) > 2).length / withCommits.length,
    averageDurationMs:
      durations.length === 0
        ? null
        : durations.reduce((sum, value) => sum + value, 0) / durations.length,
    averageConvertedCost:
      costs.length === 0 ? null : costs.reduce((sum, value) => sum + value, 0) / costs.length,
    costLabel: PIPELINE_COST_LABEL,
  };
};

const failureTag = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    const value: unknown = failure.value;
    if (typeof value === "object" && value !== null && "_tag" in value) {
      const tag = value._tag;
      if (typeof tag === "string" && tag.length > 0) return tag;
    }
  }
  return "failed";
};

const SELECT_RUNS = `
  SELECT
    id,
    repository,
    issue_number AS issueNumber,
    title,
    status,
    stuck_reason AS stuckReason,
    thread_id AS threadId,
    pr_number AS prNumber,
    head_sha AS headSha,
    updated_at AS updatedAt,
    session_started_at AS sessionStartedAt,
    session_ended_at AS sessionEndedAt,
    model_account AS modelAccount,
    input_tokens AS inputTokens,
    output_tokens AS outputTokens,
    cache_tokens AS cacheTokens,
    converted_cost AS convertedCost,
    usage_note AS usageNote,
    commit_count AS commitCount,
    ci_queue_ms AS ciQueueMs,
    detail
  FROM pipeline_runs
  ORDER BY updated_at DESC, id DESC
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* PipelineGitHubIssues;
  const settings = yield* ServerSettings.ServerSettingsService;
  const usage = yield* PipelineUsage;

  const nowIso = Effect.fn("PipelineRuns.now")(function* () {
    return DateTime.formatIso(yield* DateTime.now);
  });

  const loadRows = Effect.fn("PipelineRuns.loadRows")(function* () {
    const rows = yield* sql.unsafe(SELECT_RUNS);
    return yield* decodeRows(rows);
  }, Effect.mapError(sqlFailure));

  const loadTick = Effect.fn("PipelineRuns.loadTick")(function* () {
    const rows = yield* sql<{ at: string; outcome: string; detail: string | null }>`
       SELECT at, outcome, detail FROM pipeline_tick WHERE id = 1
     `;
    const decoded = yield* decodeTick(rows[0] ?? null);
    return decoded;
  }, Effect.mapError(sqlFailure));

  const noteTick = Effect.fn("PipelineRuns.noteTick")(function* (
    outcome: "ok" | "failed",
    detail: string | null,
  ) {
    const at = yield* nowIso();
    yield* sql`
      INSERT INTO pipeline_tick (id, at, outcome, detail)
      VALUES (1, ${at}, ${outcome}, ${detail})
      ON CONFLICT (id) DO UPDATE SET
        at = excluded.at,
        outcome = excluded.outcome,
        detail = excluded.detail
    `.pipe(Effect.mapError(sqlFailure));
  });

  const insertRun = Effect.fn("PipelineRuns.insertRun")(function* (input: {
    readonly issue: PipelineIssue;
    readonly status: "claimed" | "stuck";
    readonly stuckReason: PipelineStuckReason | null;
  }) {
    const at = yield* nowIso();
    const inserted = yield* sql<{ readonly id: number }>`
      INSERT INTO pipeline_runs (
        repository, issue_number, title, status, stuck_reason, updated_at
      )
      VALUES (
        ${REPOSITORY_NAME},
        ${input.issue.number},
        ${input.issue.title},
        ${input.status},
        ${input.stuckReason},
        ${at}
      )
      RETURNING id
    `.pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "UniqueViolation",
        () => Effect.succeed([] as ReadonlyArray<{ readonly id: number }>),
      ),
      Effect.mapError(sqlFailure),
    );
    return inserted[0]?.id;
  });

  const writeUsage = Effect.fn("PipelineRuns.writeUsage")(function* (
    id: number,
    patch: {
      readonly modelAccount: string | null;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly cacheTokens: number | null;
      readonly convertedCost: number | null;
      readonly usageNote: typeof PIPELINE_USAGE_UNREADABLE | null;
    },
  ) {
    const at = yield* nowIso();
    yield* sql`
      UPDATE pipeline_runs SET
        model_account = ${patch.modelAccount},
        input_tokens = ${patch.inputTokens},
        output_tokens = ${patch.outputTokens},
        cache_tokens = ${patch.cacheTokens},
        converted_cost = ${patch.convertedCost},
        usage_note = ${patch.usageNote},
        updated_at = ${at}
      WHERE id = ${id}
    `.pipe(Effect.mapError(sqlFailure));
  });

  const refreshUsage = Effect.fn("PipelineRuns.refreshUsage")(function* () {
    const rows = yield* loadRows();
    const closed = rows.filter(
      (row) => row.sessionStartedAt !== null && row.sessionEndedAt !== null,
    );
    if (closed.length === 0) return;
    const read = yield* Effect.exit(usage.read());
    if (Exit.isFailure(read)) {
      for (const row of closed) {
        if (row.inputTokens !== null || row.usageNote !== null) continue;
        yield* writeUsage(row.id, {
          modelAccount: null,
          inputTokens: null,
          outputTokens: null,
          cacheTokens: null,
          convertedCost: null,
          usageNote: PIPELINE_USAGE_UNREADABLE,
        });
      }
      return;
    }
    for (const row of closed) {
      const start = row.sessionStartedAt;
      const end = row.sessionEndedAt;
      if (start === null || end === null) continue;
      const sliced = sliceUsage(read.value, start, end);
      if (sliced === undefined) {
        if (row.inputTokens !== null) continue;
        yield* writeUsage(row.id, {
          modelAccount: null,
          inputTokens: null,
          outputTokens: null,
          cacheTokens: null,
          convertedCost: null,
          usageNote: PIPELINE_USAGE_UNREADABLE,
        });
        continue;
      }
      if (
        row.usageNote === null &&
        row.modelAccount === sliced.modelAccount &&
        row.inputTokens === sliced.inputTokens &&
        row.outputTokens === sliced.outputTokens &&
        row.cacheTokens === sliced.cacheTokens &&
        row.convertedCost === sliced.convertedCost
      ) {
        continue;
      }
      yield* writeUsage(row.id, { ...sliced, usageNote: null });
    }
  });

  const tick: PipelineRunsShape["tick"] = Effect.gen(function* () {
    if (!(yield* settings.getSettings.pipe(Effect.mapError(sqlFailure))).pipelineEnabled) return;
    yield* refreshUsage();
    const listed = yield* Effect.exit(issues.listEligible());
    if (Exit.isFailure(listed)) {
      yield* noteTick("failed", failureTag(listed.cause));
      return;
    }
    const existing = yield* loadRows();
    const activeIssues = new Set(existing.filter(isActiveRun).map((run) => run.issueNumber));
    const openSessions = existing.filter((run) => run.status === "session").length;
    const ordered = [...listed.value].sort((left, right) => left.number - right.number);
    for (const issue of ordered) {
      if (issue.body.includes(WORKFLOWS_PATH)) {
        if (!activeIssues.has(issue.number)) {
          yield* insertRun({ issue, status: "stuck", stuckReason: "交人" });
          activeIssues.add(issue.number);
        }
        continue;
      }
      if (acceptanceItemCount(issue.body) < 1) continue;
      if (activeIssues.has(issue.number)) continue;
      if (openSessions >= MAX_OPEN_SESSIONS) continue;
      yield* insertRun({ issue, status: "claimed", stuckReason: null });
      activeIssues.add(issue.number);
    }
    yield* noteTick("ok", null);
  }).pipe(Effect.withSpan("PipelineRuns.tick"));

  const list: PipelineRunsShape["list"] = Effect.gen(function* () {
    const runs = (yield* loadRows()).map((row): PipelineRun => ({
      ...row,
      costLabel: PIPELINE_COST_LABEL,
    }));
    return yield* decodeList({
      runs,
      summary: summarize(runs),
      lastTick: yield* loadTick(),
      costLabel: PIPELINE_COST_LABEL,
    }).pipe(Effect.mapError(sqlFailure));
  }).pipe(Effect.withSpan("PipelineRuns.list"));

  const note: PipelineRunsShape["note"] = Effect.fn("PipelineRuns.note")(function* (
    issueNumber: number,
    patch: PipelineRunNote,
  ) {
    const rows = (yield* loadRows()).filter(
      (row) => row.repository === REPOSITORY_NAME && row.issueNumber === issueNumber,
    );
    const target = rows.find(isActiveRun) ?? rows[0];
    if (target === undefined) {
      return yield* new PipelineRunsError({ cause: `no run for issue ${issueNumber}` });
    }
    const nextStatus = patch.status ?? target.status;
    const nextReason = patch.stuckReason === undefined ? target.stuckReason : patch.stuckReason;
    if (nextStatus === "stuck" ? nextReason === null : nextReason !== null) {
      return yield* new PipelineRunsError({
        cause: `stuck reason does not match status ${nextStatus}`,
      });
    }
    if (nextStatus === "session" && target.status !== "session") {
      const open = (yield* loadRows()).filter(
        (row) => row.status === "session" && row.id !== target.id,
      );
      if (open.length >= MAX_OPEN_SESSIONS) {
        return yield* new PipelineRunsError({
          cause: "an open session is already running",
        });
      }
    }
    const at = yield* nowIso();
    yield* sql`
      UPDATE pipeline_runs SET
        status = ${nextStatus},
        stuck_reason = ${nextReason},
        thread_id = ${patch.threadId === undefined ? target.threadId : patch.threadId},
        pr_number = ${patch.prNumber === undefined ? target.prNumber : patch.prNumber},
        head_sha = ${patch.headSha === undefined ? target.headSha : patch.headSha},
        session_started_at = ${
          patch.sessionStartedAt === undefined ? target.sessionStartedAt : patch.sessionStartedAt
        },
        session_ended_at = ${
          patch.sessionEndedAt === undefined ? target.sessionEndedAt : patch.sessionEndedAt
        },
        commit_count = ${patch.commitCount === undefined ? target.commitCount : patch.commitCount},
        ci_queue_ms = ${patch.ciQueueMs === undefined ? target.ciQueueMs : patch.ciQueueMs},
        detail = ${patch.detail === undefined ? target.detail : patch.detail},
        updated_at = ${at}
      WHERE id = ${target.id}
    `.pipe(Effect.mapError(sqlFailure));
    yield* refreshUsage();
  });

  return PipelineRuns.of({ tick, list, note });
});

export const layer = Layer.effect(PipelineRuns, make);

const readExport = Effect.gen(function* () {
  const filesystem = yield* FileSystem.FileSystem;
  const read = Effect.fn("PipelineUsage.read")(function* () {
    const path = (yield* HostProcess.Environment)[USAGE_EXPORT_VARIABLE]?.trim() ?? "";
    if (path.length === 0) return yield* new PipelineUsageUnreadable();
    const text = yield* filesystem
      .readFileString(path)
      .pipe(Effect.mapError(() => new PipelineUsageUnreadable()));
    return yield* decodeUsageFile(text).pipe(Effect.mapError(() => new PipelineUsageUnreadable()));
  });
  return PipelineUsage.of({ read });
});

export const layerUsage = Layer.effect(PipelineUsage, readExport);

export const layerLive = layer.pipe(
  Layer.provide(layerUsage),
  Layer.provideMerge(gitHubIssuesLayer.pipe(Layer.provide(GitHubRest.layerWithDependencies))),
);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    yield* forkParked(
      runs.tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pipeline.runs.tick-failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
      ),
    );
  }),
);
