import {
  PIPELINE_COST_LABEL,
  PIPELINE_RUN_STATUSES,
  PIPELINE_STUCK_REASONS,
  PIPELINE_METRIC_UNREAD,
  PIPELINE_USAGE_UNREADABLE,
  PipelineRunList,
  PipelineRunsError,
  type PipelineRun,
  type PipelineRunStatus,
  type PipelineStuckReason,
} from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeOS from "node:os";
import * as Path from "effect/Path";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  PipelineGitHubIssues,
  REPOSITORY,
  layer as gitHubIssuesLayer,
  type PipelineIssue,
} from "./GitHubIssues.ts";
import { isDefaultRepo, LOCAL_LABEL, parseRepo } from "./repoAllowlist.ts";
import {
  PipelineIntakePorts,
  decideIntake,
  layerPortsDefault,
  prerequisiteIssueNumbers,
  type PrerequisiteState,
} from "./intakeGates.ts";
import { PipelineFeishu, layer as feishuLayer, type StuckMessage } from "./feishu.ts";
import * as ClaimLease from "./claimLease.ts";
import { DailyBrief, beijingBriefSlot, layerLive as dailyBriefLive } from "./dailyBrief.ts";

/** How often a tick runs. One place. */
const TICK_INTERVAL = Duration.minutes(5);

/** Runs that have started a session and not ended. One place. */
export const MAX_OPEN_SESSIONS = 1;

/** Summary window for the read API. The page shows this many. */
const RECENT_RUNS = 20;

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
  notifiedReason: Schema.NullOr(Schema.String),
  notifyNote: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  controllerThreadId: Schema.NullOr(Schema.String),
  acceptedHeadSha: Schema.NullOr(Schema.String),
  controllerVerdict: Schema.NullOr(Schema.Literals(["accepted", "rejected"])),
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
  commitNote: Schema.NullOr(Schema.Literal(PIPELINE_METRIC_UNREAD)),
  ciQueueMs: Schema.NullOr(Schema.Int),
  ciQueueNote: Schema.NullOr(Schema.Literal(PIPELINE_METRIC_UNREAD)),
  detail: Schema.NullOr(Schema.String),
  renewedOnce: Schema.Literals([0, 1]),
});
type RunRow = typeof RunRow.Type;

const TickRow = Schema.Struct({
  at: Schema.String,
  outcome: Schema.Literals(["ok", "failed"]),
  detail: Schema.NullOr(Schema.String),
});

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export interface UsageRecord {
  readonly at: string;
  readonly account: string;
  readonly inputTokens: number;
  readonly outputTokens: number | null;
  readonly cacheTokens: number | null;
  readonly convertedCost: number | null;
}

export interface UsageSlice {
  readonly modelAccount: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number | null;
  readonly cacheTokens: number | null;
  readonly convertedCost: number | null;
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
    readonly read: (
      run: Pick<PipelineRun, "threadId" | "sessionStartedAt" | "sessionEndedAt">,
    ) => Effect.Effect<ReadonlyArray<UsageRecord>, PipelineUsageUnreadable>;
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
  readonly commitNote?: typeof PIPELINE_METRIC_UNREAD | null;
  readonly ciQueueMs?: number | null;
  readonly ciQueueNote?: typeof PIPELINE_METRIC_UNREAD | null;
  /** Why this run stopped moving. Not the global tick row. */
  readonly detail?: string | null;
  /** Set when this run uses its one automatic retry. Never cleared. */
  readonly renewedOnce?: boolean;
}

export type StartSupervisedCode =
  | "disabled"
  | "repository_denied"
  | "ineligible"
  | "conflict"
  | Extract<ClaimLease.ClaimResult, { readonly status: 404 | 409 | 503 }>["code"];
export type StartSupervisedResult =
  | { readonly status: "started"; readonly run: PipelineRun }
  | { readonly status: "rejected"; readonly code: StartSupervisedCode };

interface PipelineRunsShape {
  readonly tick: Effect.Effect<void, PipelineRunsError>;
  readonly list: Effect.Effect<PipelineRunList, PipelineRunsError>;
  readonly startSupervised: (input: {
    readonly issueNumber: number;
    readonly repository: string;
    readonly controllerThreadId: string;
  }) => Effect.Effect<StartSupervisedResult, PipelineRunsError>;
  readonly note: (
    issueNumber: number,
    patch: PipelineRunNote,
    repository?: string,
  ) => Effect.Effect<void, PipelineRunsError>;
}

export class PipelineRuns extends Context.Service<PipelineRuns, PipelineRunsShape>()(
  "t3/pipeline/PipelineRuns",
) {}

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(RunRow));
const decodeTick = Schema.decodeUnknownEffect(Schema.NullOr(TickRow));
const decodeList = Schema.decodeUnknownEffect(PipelineRunList);

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
  if (inWindow.length === 0) return undefined;
  const accounts = [...new Set(inWindow.map((record) => record.account).filter(Boolean))].sort();
  return {
    modelAccount: accounts.length === 0 ? null : accounts.join(","),
    inputTokens: inWindow.reduce((sum, record) => sum + record.inputTokens, 0),
    outputTokens: inWindow.every((record) => record.outputTokens !== null)
      ? inWindow.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0)
      : null,
    cacheTokens: inWindow.every((record) => record.cacheTokens !== null)
      ? inWindow.reduce((sum, record) => sum + (record.cacheTokens ?? 0), 0)
      : null,
    convertedCost: inWindow.every((record) => record.convertedCost !== null)
      ? inWindow.reduce((sum, record) => sum + (record.convertedCost ?? 0), 0)
      : null,
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
    notified_reason AS notifiedReason,
    notify_note AS notifyNote,
    thread_id AS threadId,
    controller_thread_id AS controllerThreadId,
    accepted_head_sha AS acceptedHeadSha,
    controller_verdict AS controllerVerdict,
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
    commit_note AS commitNote,
    ci_queue_ms AS ciQueueMs,
    ci_queue_note AS ciQueueNote,
    detail,
    renewed_once AS renewedOnce
  FROM pipeline_runs
  ORDER BY updated_at DESC, id DESC
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* PipelineGitHubIssues;
  const settings = yield* ServerSettings.ServerSettingsService;
  const ports = yield* PipelineIntakePorts;
  const usage = yield* PipelineUsage;
  const claims = yield* ClaimLease.ClaimLeasePort;

  const feishu = yield* Effect.serviceOption(PipelineFeishu);
  const brief = yield* Effect.serviceOption(DailyBrief);
  let briefedDay: string | null = null;
  const maybeBrief = Effect.gen(function* () {
    const slot = beijingBriefSlot(yield* DateTime.now);
    if (!slot.due || briefedDay === slot.day || Option.isNone(brief)) return;
    const outcome = yield* Effect.exit(brief.value.run);
    if (Exit.isSuccess(outcome) && outcome.value.sent) briefedDay = slot.day;
  });

  // A failed attempt still counts: the same reason is not sent again.
  const announce = Effect.fn("PipelineRuns.announce")(function* (
    id: number,
    message: StuckMessage,
  ) {
    if (Option.isNone(feishu)) return;
    const outcome = yield* feishu.value.send(message);
    yield* sql`
      UPDATE pipeline_runs SET
        notified_reason = ${message.reason},
        notify_note = ${outcome.delivered ? null : outcome.note}
      WHERE id = ${id}
    `.pipe(Effect.mapError(sqlFailure));
  });
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
    readonly repository: string;
    readonly status: "claimed" | "stuck";
    readonly stuckReason: PipelineStuckReason | null;
    readonly claimToken?: string | null;
    readonly controllerThreadId?: string;
  }) {
    const at = yield* nowIso();
    const inserted = yield* sql<{ readonly id: number }>`
      INSERT INTO pipeline_runs (
        repository, issue_number, title, status, stuck_reason, updated_at, claim_token, controller_thread_id
      )
      VALUES (
        ${input.repository},
        ${input.issue.number},
        ${input.issue.title},
        ${input.status},
        ${input.stuckReason},
        ${at},
        ${input.claimToken ?? null},
        ${input.controllerThreadId ?? null}
      )
      RETURNING id
    `.pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "UniqueViolation",
        () => Effect.succeed([] as ReadonlyArray<{ readonly id: number }>),
      ),
      Effect.mapError(sqlFailure),
    );
    const id = inserted[0]?.id;
    if (id !== undefined && input.status === "stuck" && input.stuckReason !== null) {
      yield* announce(id, {
        repository: input.repository,
        issueNumber: input.issue.number,
        reason: input.stuckReason,
        prNumber: null,
      });
    }
    return id;
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
    for (const row of closed) {
      if (row.inputTokens !== null) continue;
      const start = row.sessionStartedAt;
      const end = row.sessionEndedAt;
      if (start === null || end === null) continue;
      const read = yield* Effect.exit(usage.read(row));
      const sliced = Exit.isSuccess(read) ? sliceUsage(read.value, start, end) : undefined;
      if (sliced === undefined) {
        if (row.usageNote !== null) continue;
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

  const settleRelease = Effect.fn("PipelineRuns.settleRelease")(function* (row: {
    readonly id: number;
    readonly repository: string;
    readonly issueNumber: number;
    readonly token: string;
  }) {
    const outcome = yield* Effect.exit(
      ClaimLease.releaseClaim(claims, {
        repo: row.repository,
        issue: row.issueNumber,
        token: row.token,
      }),
    );
    if (Exit.isFailure(outcome)) {
      yield* Effect.logWarning("pipeline.claim.release-failed", {
        issue: row.issueNumber,
        cause: Cause.pretty(outcome.cause),
      });
      return;
    }
    const result = outcome.value;
    if (result.status === 503 || (result.status !== 200 && result.code !== "not_claimed")) {
      yield* Effect.logWarning("pipeline.claim.release-failed", {
        issue: row.issueNumber,
        status: result.status,
        code: result.code,
      });
      return;
    }
    if (result.code === "not_claimed") {
      yield* Effect.logWarning("pipeline.claim.release-lost", {
        issue: row.issueNumber,
        code: result.code,
      });
    }
    yield* sql`
      UPDATE pipeline_runs SET claim_token = NULL
      WHERE id = ${row.id} AND claim_token = ${row.token}
    `.pipe(
      Effect.mapError(sqlFailure),
      Effect.catchCause((cause) =>
        Effect.logWarning("pipeline.claim.release-failed", {
          issue: row.issueNumber,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });
  const releaseUnstoredClaim = Effect.fn("PipelineRuns.releaseUnstoredClaim")(function* (claim: {
    readonly repository: string;
    readonly issueNumber: number;
    readonly token: string;
  }) {
    const released = yield* Effect.exit(
      ClaimLease.releaseClaim(claims, {
        repo: claim.repository,
        issue: claim.issueNumber,
        token: claim.token,
      }),
    );
    if (Exit.isFailure(released)) {
      yield* Effect.logError("pipeline.claim.release-orphaned", {
        issue: claim.issueNumber,
        token: claim.token,
        cause: Cause.pretty(released.cause),
      });
      return;
    }
    if (released.value.status !== 200 && released.value.code !== "not_claimed") {
      yield* Effect.logError("pipeline.claim.release-orphaned", {
        issue: claim.issueNumber,
        token: claim.token,
        cause: released.value.code,
      });
    }
  });

  const releasePending = Effect.fn("PipelineRuns.releasePending")(function* () {
    const pending = yield* sql<{
      readonly id: number;
      readonly repository: string;
      readonly issueNumber: number;
      readonly claimToken: string;
    }>`
      SELECT id, repository, issue_number AS issueNumber, claim_token AS claimToken
      FROM pipeline_runs
      WHERE claim_token IS NOT NULL
        AND (
          status = 'merged'
          OR (status = 'stuck' AND stuck_reason = '取消')
        )
    `.pipe(Effect.mapError(sqlFailure));
    for (const row of pending) {
      if (row.claimToken.length === 0) continue;
      yield* settleRelease({
        id: row.id,
        repository: row.repository,
        issueNumber: row.issueNumber,
        token: row.claimToken,
      });
    }
  });

  const tick: PipelineRunsShape["tick"] = Effect.gen(function* () {
    yield* releasePending().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("pipeline.claim.release-failed", { cause: Cause.pretty(cause) }),
      ),
    );
    yield* Effect.exit(maybeBrief);
    const current = yield* settings.getSettings.pipe(Effect.mapError(sqlFailure));
    if (!current.pipelineEnabled) {
      if (current.pipelineEnabledAt !== null) {
        yield* Effect.exit(settings.updateSettings({ pipelineEnabledAt: null }));
      }
      return;
    }
    let openedAt = current.pipelineEnabledAt;
    if (openedAt === null) {
      const stamped = DateTime.formatIso(yield* DateTime.now);
      const wrote = yield* Effect.exit(settings.updateSettings({ pipelineEnabledAt: stamped }));
      openedAt = Exit.isSuccess(wrote) ? stamped : null;
    }
    yield* claims.register(current.pipelineRepos).pipe(Effect.mapError(sqlFailure));
    yield* refreshUsage();
    const repos = current.pipelineRepos.flatMap((slug) => {
      const parsed = parseRepo(slug);
      return parsed === undefined ? [] : [parsed];
    });
    if (repos.length === 0) {
      yield* noteTick("ok", null);
      return;
    }
    const collected: Array<PipelineIssue> = [];
    for (const repo of repos) {
      const listed = yield* Effect.exit(issues.listEligible(repo));
      if (Exit.isFailure(listed)) {
        yield* noteTick("failed", failureTag(listed.cause));
        return;
      }
      for (const issue of listed.value) {
        collected.push({ ...issue, repository: repo.slug });
      }
    }
    const whitelist = yield* Effect.exit(ports.readWhitelist);
    if (Exit.isFailure(whitelist)) {
      yield* noteTick("failed", "白名单读不到");
      return;
    }
    const repoOrder = new Map(repos.map((repo, index) => [repo.slug, index]));
    const ordered = [...collected].sort((left, right) => {
      const byRepo =
        (repoOrder.get(left.repository ?? "") ?? 0) - (repoOrder.get(right.repository ?? "") ?? 0);
      return byRepo === 0 ? left.number - right.number : byRepo;
    });
    const states = new Map<string, PrerequisiteState>();
    const needed = new Map<
      string,
      { readonly repo: (typeof repos)[number]; readonly number: number }
    >();
    for (const issue of ordered) {
      const repo = parseRepo(issue.repository ?? "");
      if (repo === undefined) continue;
      for (const number of prerequisiteIssueNumbers(issue.body)) {
        needed.set(`${repo.slug}#${number}`, { repo, number });
      }
    }
    for (const [key, item] of needed) {
      if (
        ordered.some((issue) => issue.repository === item.repo.slug && issue.number === item.number)
      ) {
        states.set(key, "open");
        continue;
      }
      const read = yield* Effect.exit(issues.read(item.number, item.repo));
      if (Exit.isFailure(read)) {
        states.set(key, "unread");
        continue;
      }
      const state = read.value.state;
      states.set(key, state === "open" || state === "closed" ? state : "unread");
    }
    const now = yield* DateTime.now;
    const existing = yield* loadRows();
    for (const run of existing) {
      if (run.status !== "claimed" || isDefaultRepo(run.repository)) continue;
      const repo = repos.find((candidate) => candidate.slug === run.repository);
      if (repo === undefined) continue;
      const labeled = yield* Effect.exit(issues.addLabel(run.issueNumber, LOCAL_LABEL, repo));
      if (Exit.isFailure(labeled)) {
        yield* noteTick("failed", failureTag(labeled.cause));
        return;
      }
    }
    const activeIssues = new Set(
      existing.filter(isActiveRun).map((run) => `${run.repository}#${run.issueNumber}`),
    );
    const openSessions = existing.filter((run) => run.status === "session").length;
    for (const issue of ordered) {
      const repository = issue.repository ?? REPOSITORY_NAME;
      const repo = parseRepo(repository);
      if (repo === undefined) continue;
      const key = `${repository}#${issue.number}`;
      const decision = decideIntake(
        {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          author: issue.author ?? null,
          createdAt: issue.createdAt ?? null,
        },
        {
          whitelist: whitelist.value,
          openedAt,
          now,
          prerequisiteState: (number) => states.get(`${repository}#${number}`) ?? "unread",
        },
      );
      if (!decision.pull) continue;
      if (issue.body.includes(WORKFLOWS_PATH)) {
        if (!activeIssues.has(key)) {
          yield* insertRun({ issue, repository, status: "stuck", stuckReason: "交人" });
          activeIssues.add(key);
        }
        continue;
      }
      if (acceptanceItemCount(issue.body) < 1) continue;
      if (activeIssues.has(key)) continue;
      if (openSessions >= MAX_OPEN_SESSIONS) continue;
      const leased = yield* ClaimLease.claimForRun(claims, {
        repo: repository,
        issue: issue.number,
        title: issue.title,
      });
      if (leased.status !== 200) continue;
      // Ledger claim commits before this insert; they are not one transaction.
      // Release this token if the row is not stored. If that release also fails,
      // restart cannot retry: the token was never persisted, so it expires at the
      // original two-hour leaseUntil. Do not delete by holder or by a null fence.
      const stored = yield* Effect.exit(
        insertRun({
          issue,
          repository,
          status: "claimed",
          stuckReason: null,
          claimToken: leased.token,
        }),
      );
      if (Exit.isFailure(stored) || stored.value === undefined) {
        yield* releaseUnstoredClaim({
          repository,
          issueNumber: issue.number,
          token: leased.token,
        });
        if (Exit.isFailure(stored)) return yield* Effect.failCause(stored.cause);
        continue;
      }
      if (!isDefaultRepo(repository)) {
        const labeled = yield* Effect.exit(issues.addLabel(issue.number, LOCAL_LABEL, repo));
        if (Exit.isFailure(labeled)) {
          yield* noteTick("failed", failureTag(labeled.cause));
          return;
        }
      }
      activeIssues.add(key);
    }
    yield* noteTick("ok", null);
  }).pipe(Effect.withSpan("PipelineRuns.tick"));

  const list: PipelineRunsShape["list"] = Effect.gen(function* () {
    const runs = (yield* loadRows()).map((row): PipelineRun => {
      const { notifiedReason: _notifiedReason, ...rest } = row;
      return {
        ...rest,
        renewedOnce: row.renewedOnce === 1,
        costLabel: PIPELINE_COST_LABEL,
      };
    });
    return yield* decodeList({
      runs,
      summary: summarize(runs),
      lastTick: yield* loadTick(),
      costLabel: PIPELINE_COST_LABEL,
    }).pipe(Effect.mapError(sqlFailure));
  }).pipe(Effect.withSpan("PipelineRuns.list"));

  const startSupervised: PipelineRunsShape["startSupervised"] = Effect.fn(
    "PipelineRuns.startSupervised",
  )(function* (input) {
    const current = yield* settings.getSettings.pipe(Effect.mapError(sqlFailure));
    const repo = parseRepo(input.repository);
    if (repo === undefined || !current.pipelineRepos.includes(repo.slug))
      return { status: "rejected", code: "repository_denied" as const };
    const existing = (yield* list).runs.find(
      (run) =>
        run.repository === repo.slug && run.issueNumber === input.issueNumber && isActiveRun(run),
    );
    if (existing !== undefined) {
      return existing.controllerThreadId === input.controllerThreadId
        ? { status: "started", run: existing }
        : { status: "rejected", code: "conflict" as const };
    }
    const candidates = yield* issues.listEligible(repo).pipe(Effect.mapError(sqlFailure));
    const issue = candidates.find((candidate) => candidate.number === input.issueNumber);
    if (issue === undefined) return { status: "rejected", code: "ineligible" as const };
    const prerequisiteState = new Map();
    for (const number of prerequisiteIssueNumbers(issue.body)) {
      const read = yield* Effect.exit(issues.read(number, repo));
      prerequisiteState.set(
        number,
        Exit.isSuccess(read) ? (read.value.state ?? "unread") : "unread",
      );
    }
    const now = yield* DateTime.now;
    const decision = decideIntake(
      { ...issue, author: issue.author ?? null, createdAt: issue.createdAt ?? null },
      {
        whitelist: yield* ports.readWhitelist.pipe(Effect.mapError(sqlFailure)),
        openedAt: current.pipelineEnabledAt ?? DateTime.formatIso(now),
        now,
        prerequisiteState: (number) => prerequisiteState.get(number) ?? "unread",
      },
    );
    if (
      !decision.pull ||
      issue.body.includes(WORKFLOWS_PATH) ||
      acceptanceItemCount(issue.body) < 1
    )
      return { status: "rejected", code: "ineligible" as const };
    yield* claims.register([repo.slug]).pipe(Effect.mapError(sqlFailure));
    const leased = yield* ClaimLease.claimForRun(claims, {
      repo: repo.slug,
      issue: issue.number,
      title: issue.title,
    });
    if (leased.status !== 200) return { status: "rejected", code: leased.code };
    const stored = yield* Effect.exit(
      insertRun({
        issue,
        repository: repo.slug,
        status: "claimed",
        stuckReason: null,
        claimToken: leased.token,
        controllerThreadId: input.controllerThreadId,
      }),
    );
    if (Exit.isFailure(stored) || stored.value === undefined) {
      yield* releaseUnstoredClaim({
        repository: repo.slug,
        issueNumber: issue.number,
        token: leased.token,
      });
      if (Exit.isFailure(stored)) return yield* Effect.failCause(stored.cause);
      return { status: "rejected", code: "conflict" as const };
    }
    const run = (yield* list).runs.find((candidate) => candidate.id === stored.value);
    if (run === undefined)
      return yield* new PipelineRunsError({ cause: "stored supervised run is unreadable" });
    return { status: "started", run };
  });

  const note: PipelineRunsShape["note"] = Effect.fn("PipelineRuns.note")(function* (
    issueNumber: number,
    patch: PipelineRunNote,
    repository?: string,
  ) {
    const repositoryName = repository ?? REPOSITORY_NAME;
    const rows = (yield* loadRows()).filter(
      (row) => row.repository === repositoryName && row.issueNumber === issueNumber,
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
    const commitCount =
      typeof patch.commitCount === "number"
        ? patch.commitCount
        : patch.commitNote === PIPELINE_METRIC_UNREAD
          ? null
          : patch.commitCount === undefined
            ? target.commitCount
            : patch.commitCount;
    const commitNote =
      typeof patch.commitCount === "number"
        ? null
        : patch.commitNote === undefined
          ? target.commitNote
          : patch.commitNote;
    const ciQueueMs =
      typeof patch.ciQueueMs === "number"
        ? patch.ciQueueMs
        : patch.ciQueueNote === PIPELINE_METRIC_UNREAD
          ? null
          : patch.ciQueueMs === undefined
            ? target.ciQueueMs
            : patch.ciQueueMs;
    const ciQueueNote =
      typeof patch.ciQueueMs === "number"
        ? null
        : patch.ciQueueNote === undefined
          ? target.ciQueueNote
          : patch.ciQueueNote;
    const nextHead = patch.headSha === undefined ? target.headSha : patch.headSha;
    const verdictStale = nextHead !== target.headSha;
    yield* sql`
      UPDATE pipeline_runs SET
        status = ${nextStatus},
        stuck_reason = ${nextReason},
        thread_id = ${patch.threadId === undefined ? target.threadId : patch.threadId},
        pr_number = ${patch.prNumber === undefined ? target.prNumber : patch.prNumber},
        head_sha = ${nextHead},
        session_started_at = ${
          patch.sessionStartedAt === undefined ? target.sessionStartedAt : patch.sessionStartedAt
        },
        session_ended_at = ${
          patch.sessionEndedAt === undefined ? target.sessionEndedAt : patch.sessionEndedAt
        },
        commit_count = ${commitCount},
        commit_note = ${commitNote},
        ci_queue_ms = ${ciQueueMs},
        ci_queue_note = ${ciQueueNote},
        detail = ${patch.detail === undefined ? target.detail : patch.detail},
        renewed_once = ${patch.renewedOnce === true ? 1 : target.renewedOnce},
        controller_verdict = ${verdictStale ? null : target.controllerVerdict},
        accepted_head_sha = ${verdictStale ? null : target.acceptedHeadSha},
        updated_at = ${at}
      WHERE id = ${target.id}
    `.pipe(Effect.mapError(sqlFailure));
    if (nextStatus === "stuck" && nextReason !== null && nextReason !== target.notifiedReason) {
      yield* announce(target.id, {
        repository: target.repository,
        issueNumber: target.issueNumber,
        reason: nextReason,
        prNumber: patch.prNumber === undefined ? target.prNumber : patch.prNumber,
      });
    }
    if (
      (patch.threadId !== undefined && patch.threadId !== target.threadId) ||
      (patch.sessionStartedAt !== undefined &&
        patch.sessionStartedAt !== target.sessionStartedAt) ||
      (patch.sessionEndedAt !== undefined && patch.sessionEndedAt !== target.sessionEndedAt)
    ) {
      yield* writeUsage(target.id, {
        modelAccount: null,
        inputTokens: null,
        outputTokens: null,
        cacheTokens: null,
        convertedCost: null,
        usageNote: null,
      });
    }
    yield* refreshUsage();
    if (nextStatus === "merged" || (nextStatus === "stuck" && nextReason === TERMINAL_CANCEL)) {
      const tokenRow = yield* sql<{ readonly claimToken: string | null }>`
        SELECT claim_token AS claimToken FROM pipeline_runs WHERE id = ${target.id}
      `.pipe(Effect.mapError(sqlFailure));
      const token = tokenRow[0]?.claimToken;
      if (token !== null && token !== undefined && token.length > 0) {
        yield* settleRelease({ id: target.id, repository: target.repository, issueNumber, token });
      }
    }
  });

  return PipelineRuns.of({ tick, list, note, startSupervised });
});

export const layer = Layer.effect(PipelineRuns, make);

const TranscriptEntry = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.String,
      usage: Schema.optional(
        Schema.Struct({
          input: Schema.optional(NonNegativeInt),
          output: Schema.optional(NonNegativeInt),
          cacheRead: Schema.optional(NonNegativeInt),
          cacheWrite: Schema.optional(NonNegativeInt),
        }),
      ),
    }),
  ),
});
const decodeTranscriptEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(TranscriptEntry));
const NativeSession = Schema.Struct({
  driver: Schema.String,
  nativeThreadRef: Schema.NullOr(Schema.Struct({ nativeId: Schema.String })),
});
const decodeNativeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeSession));

/** omp writes one pi-format jsonl per session; the ACP id is the uuid in the file name, not a path. */
const OMP_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const layerUsageAt = (sessionsRoot: string | undefined) =>
  Layer.effect(
    PipelineUsage,
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = sessionsRoot ?? path.join(NodeOS.homedir(), ".omp", "agent", "sessions");
      const sql = yield* SqlClient.SqlClient;
      const findOmpTranscript = Effect.fn("PipelineUsage.findOmpTranscript")(function* (
        nativeId: string,
      ) {
        if (!OMP_SESSION_ID.test(nativeId)) return yield* new PipelineUsageUnreadable();
        const suffix = `_${nativeId}.jsonl`;
        const matches: string[] = [];
        for (const entry of yield* filesystem.readDirectory(root)) {
          if (entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\")) {
            continue;
          }
          const directory = path.join(root, entry);
          const info = yield* filesystem.stat(directory);
          if (info.type !== "Directory") continue;
          for (const file of yield* filesystem.readDirectory(directory)) {
            if (file.endsWith(suffix) && !file.includes("/") && !file.includes("\\")) {
              matches.push(path.join(directory, file));
            }
          }
        }
        const [only] = matches;
        if (matches.length !== 1 || only === undefined) return yield* new PipelineUsageUnreadable();
        return only;
      });
      const read = Effect.fn("PipelineUsage.read")(
        function* (run: Pick<PipelineRun, "threadId" | "sessionStartedAt" | "sessionEndedAt">) {
          if (run.threadId === null) return yield* new PipelineUsageUnreadable();
          const rows = yield* sql<{
            readonly payload: string;
          }>`SELECT payload_json AS payload FROM orchestration_v2_projection_provider_threads
       WHERE thread_id = ${run.threadId} AND owner_node_id IS NULL`;
          if (rows.length !== 1) return yield* new PipelineUsageUnreadable();
          const session = yield* decodeNativeSession(rows[0]!.payload);
          if (session.nativeThreadRef === null) return yield* new PipelineUsageUnreadable();
          const nativeId = session.nativeThreadRef.nativeId;
          // pi stores the transcript path. omp stores only the session uuid.
          const transcript =
            session.driver === "pi"
              ? nativeId
              : session.driver === "acpRegistry"
                ? yield* findOmpTranscript(nativeId)
                : yield* new PipelineUsageUnreadable();
          const start = Date.parse(run.sessionStartedAt ?? "");
          const end = Date.parse(run.sessionEndedAt ?? "");
          if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
            return yield* new PipelineUsageUnreadable();
          }
          const contents = yield* filesystem.readFileString(transcript);
          const records: UsageRecord[] = [];
          for (const line of contents.split(/\r?\n/)) {
            if (line.trim().length === 0) continue;
            const entry = yield* decodeTranscriptEntry(line);
            if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
            const at = Date.parse(entry.timestamp ?? "");
            if (!Number.isFinite(at)) return yield* new PipelineUsageUnreadable();
            if (at < start || at > end) continue;
            const usage = entry.message.usage;
            if (usage?.input === undefined) return yield* new PipelineUsageUnreadable();
            records.push({
              at: entry.timestamp!,
              account: "",
              inputTokens: usage.input,
              outputTokens: usage.output ?? null,
              cacheTokens:
                usage.cacheRead === undefined || usage.cacheWrite === undefined
                  ? null
                  : usage.cacheRead + usage.cacheWrite,
              convertedCost: null,
            });
          }
          if (records.length === 0) return yield* new PipelineUsageUnreadable();
          return records;
        },
        Effect.mapError(() => new PipelineUsageUnreadable()),
      );
      return PipelineUsage.of({ read });
    }),
  );

export const layerUsage = layerUsageAt(undefined);

export const layerLive = layer.pipe(
  Layer.provide(ClaimLease.layerLive),
  Layer.provide(dailyBriefLive),
  Layer.provide(feishuLayer.pipe(Layer.provide(FetchHttpClient.layer))),
  Layer.provide(layerPortsDefault),
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
