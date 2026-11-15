import {
  PIPELINE_COST_LABEL,
  PIPELINE_RECENT_RUNS,
  PIPELINE_RUN_STATUSES,
  PIPELINE_STUCK_REASONS,
  PIPELINE_USAGE_UNREAD,
  PipelineRunMissing,
  PipelineRunReadError,
  type PipelineRun,
  type PipelineRunList,
  type PipelineRunStatus,
  type PipelineStuckReason,
  type PipelineTick,
  type PipelineUsageState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubIssues from "./GitHubIssues.ts";

/** How often a running server ticks. One place. */
const TICK_INTERVAL = Duration.minutes(5);

/** Runs that have a session open and not ended. One place. */
const MAX_OPEN_SESSIONS = 1;

const WORKFLOWS_PATH = ".github/workflows/";
const ACCEPTANCE = "怎么算做完";
const USAGE_CSV_LIMIT_BYTES = 32 * 1024 * 1024;
const USAGE_COMMAND_TIMEOUT = Duration.seconds(30);

type TickResult =
  | { readonly outcome: "disabled" }
  | { readonly outcome: "read-failed" }
  | { readonly outcome: "ok" };

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
}

interface StoredRun {
  readonly id: number;
  readonly repository: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly status: PipelineRunStatus;
  readonly stuckReason: PipelineStuckReason | null;
  readonly threadId: string | null;
  readonly prNumber: number | null;
  readonly headSha: string | null;
  readonly updatedAt: string;
  readonly sessionStartedAt: string | null;
  readonly sessionEndedAt: string | null;
  readonly magpieAccount: string | null;
  readonly usageState: PipelineUsageState;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheTokens: number | null;
  readonly convertedCost: string | null;
  readonly commitCount: number | null;
  readonly ciQueueMs: number | null;
}

export interface UsageSlice {
  readonly read: true;
  readonly magpieAccount: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheTokens: number;
  readonly convertedCost: string;
}

const StoredRunRow = Schema.Struct({
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
  magpieAccount: Schema.NullOr(Schema.String),
  usageState: Schema.Literals(["absent", "unread", "read"]),
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  cacheTokens: Schema.NullOr(Schema.Int),
  convertedCost: Schema.NullOr(Schema.String),
  commitCount: Schema.NullOr(Schema.Int),
  ciQueueMs: Schema.NullOr(Schema.Int),
});

const TickRow = Schema.Struct({
  at: Schema.String,
  outcome: Schema.Literals(["ok", "read-failed"]),
  detail: Schema.NullOr(Schema.String),
});

const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(StoredRunRow));
const decodeTick = Schema.decodeUnknownEffect(Schema.Array(TickRow));

const activeRun = (run: Pick<StoredRun, "status" | "stuckReason">): boolean =>
  run.status !== "merged" && !(run.status === "stuck" && run.stuckReason === "取消");

const readFailure = new PipelineRunReadError({ message: "读运行记录失败" });

/** `--last` covers from the session start through now, plus a minute. Slicing drops the rest. */
export const magpieLastArgument = (startIso: string, nowMs: number): string | null => {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start) || start > nowMs) return null;
  const minutes = Math.ceil((nowMs - start) / 60_000) + 1;
  if (!Number.isSafeInteger(minutes) || minutes < 1) return null;
  return `${minutes}m`;
};

const parseCsv = (line: string): Array<string> => {
  const out: Array<string> = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        current += char ?? "";
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      out.push(current);
      current = "";
    } else {
      current += char ?? "";
    }
  }
  out.push(current);
  return out;
};

const toMicros = (raw: string): number | null => {
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const [whole = "0", fraction = ""] = raw.split(".");
  const padded = `${fraction}0000000`.slice(0, 7);
  const round = padded[6];
  const micros =
    Number(whole) * 1_000_000 +
    Number(padded.slice(0, 6)) +
    (round !== undefined && round >= "5" ? 1 : 0);
  return Number.isSafeInteger(micros) ? micros : null;
};

const fromMicros = (micros: number): string => {
  const whole = Math.trunc(micros / 1_000_000);
  const fraction = String(Math.abs(micros % 1_000_000))
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction.length === 0 ? String(whole) : `${whole}.${fraction}`;
};

const integerCell = (raw: string): number | null =>
  /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : null;

/**
 * Sum magpie `usage --csv` rows whose time falls inside the session window.
 * A missing column or a bad number is unreadable, not a zero.
 */
export const sliceMagpieUsageCsv = (
  text: string,
  startIso: string,
  endIso: string,
): UsageSlice | { readonly read: false } => {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { read: false };
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("plugin: host"));
  const headerAt = lines.findIndex((line) => parseCsv(line).includes("input_tokens"));
  const headerLine = headerAt < 0 ? undefined : lines[headerAt];
  if (headerLine === undefined) return { read: false };
  const header = parseCsv(headerLine);
  const timeIndex = header.indexOf("time");
  const inputIndex = header.indexOf("input_tokens");
  const outputIndex = header.indexOf("output_tokens");
  const cacheWriteIndex = header.indexOf("cache_write_tokens");
  const cacheReadIndex = header.indexOf("cache_read_tokens");
  const costIndex = header.indexOf("cost_usd");
  const accountIndex = header.indexOf("provider_account");
  if (
    timeIndex < 0 ||
    inputIndex < 0 ||
    outputIndex < 0 ||
    cacheWriteIndex < 0 ||
    cacheReadIndex < 0 ||
    costIndex < 0 ||
    accountIndex < 0
  ) {
    return { read: false };
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;
  let costMicros = 0;
  const accounts = new Set<string>();
  for (const line of lines.slice(headerAt + 1)) {
    const cells = parseCsv(line);
    const at = Date.parse(cells[timeIndex] ?? "");
    if (!Number.isFinite(at)) return { read: false };
    if (at < start || at > end) continue;
    const input = integerCell(cells[inputIndex] ?? "");
    const output = integerCell(cells[outputIndex] ?? "");
    const cacheWrite = integerCell(cells[cacheWriteIndex] ?? "");
    const cacheRead = integerCell(cells[cacheReadIndex] ?? "");
    const cost = toMicros(cells[costIndex] ?? "");
    if (
      input === null ||
      output === null ||
      cacheWrite === null ||
      cacheRead === null ||
      cost === null
    ) {
      return { read: false };
    }
    inputTokens += input;
    outputTokens += output;
    cacheTokens += cacheWrite + cacheRead;
    costMicros += cost;
    const account = (cells[accountIndex] ?? "").trim();
    if (account.length > 0) accounts.add(account);
  }
  return {
    read: true,
    magpieAccount: accounts.size === 0 ? null : [...accounts].sort().join("、"),
    inputTokens,
    outputTokens,
    cacheTokens,
    convertedCost: fromMicros(costMicros),
  };
};

const failureDetail = (error: { readonly _tag: string; readonly reason?: string }): string =>
  error.reason === undefined ? error._tag : `${error._tag}:${error.reason}`;

export class PipelineMagpieUsage extends Context.Service<
  PipelineMagpieUsage,
  {
    /** CSV covering the session start through now. Failure is unreadable usage, not a zero. */
    readonly readCsv: (sessionStartedAt: string) => Effect.Effect<string, PipelineRunReadError>;
  }
>()("t3/pipeline/PipelineRuns/PipelineMagpieUsage") {}

const layerMagpieUsage = Layer.effect(
  PipelineMagpieUsage,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // npm's Windows shim is `magpie.cmd`; spawning `magpie` without a shell fails with ENOENT.
    const platform = yield* HostProcess.Platform;
    const command = platform === "win32" ? "magpie.cmd" : "magpie";
    const readCsv = Effect.fn("PipelineMagpieUsage.readCsv")(function* (sessionStartedAt: string) {
      const nowMs = yield* Clock.currentTimeMillis;
      const last = magpieLastArgument(sessionStartedAt, nowMs);
      if (last === null) return yield* new PipelineRunReadError({ message: PIPELINE_USAGE_UNREAD });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(command, ["usage", "--csv", "--last", last], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: "1 second",
          }),
        )
        .pipe(Effect.mapError(() => new PipelineRunReadError({ message: PIPELINE_USAGE_UNREAD })));
      const read = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.timeout(USAGE_COMMAND_TIMEOUT),
        Effect.mapError(() => new PipelineRunReadError({ message: PIPELINE_USAGE_UNREAD })),
      );
      const [stdout, stderr, exitCode] = read;
      if (exitCode !== 0 || stdout.length + stderr.length > USAGE_CSV_LIMIT_BYTES) {
        return yield* new PipelineRunReadError({ message: PIPELINE_USAGE_UNREAD });
      }
      return stdout;
    }, Effect.scoped);
    return PipelineMagpieUsage.of({ readCsv });
  }),
);

interface PipelineRunsShape {
  readonly tick: () => Effect.Effect<TickResult, PipelineRunReadError>;
  readonly list: () => Effect.Effect<PipelineRunList, PipelineRunReadError>;
  /** Fills later columns on the issue's active run. Does not insert a second run. */
  readonly note: (
    issueNumber: number,
    patch: PipelineRunNote,
  ) => Effect.Effect<void, PipelineRunReadError | PipelineRunMissing>;
}

export class PipelineRuns extends Context.Service<PipelineRuns, PipelineRunsShape>()(
  "t3/pipeline/PipelineRuns",
) {}

const loadRuns = Effect.fn("PipelineRuns.loadRuns")(function* (sql: SqlClient.SqlClient) {
  return yield* sql`
    SELECT id, repository, issue_number AS issueNumber, title, status,
           stuck_reason AS stuckReason, thread_id AS threadId, pr_number AS prNumber,
           head_sha AS headSha, updated_at AS updatedAt,
           session_started_at AS sessionStartedAt, session_ended_at AS sessionEndedAt,
           magpie_account AS magpieAccount, usage_state AS usageState,
           input_tokens AS inputTokens, output_tokens AS outputTokens,
           cache_tokens AS cacheTokens, converted_cost AS convertedCost,
           commit_count AS commitCount, ci_queue_ms AS ciQueueMs
    FROM pipeline_runs
    ORDER BY updated_at DESC, id DESC
  `.pipe(
    Effect.mapError(() => readFailure),
    Effect.flatMap((rows) => decodeRuns(rows).pipe(Effect.mapError(() => readFailure))),
  );
});

const summarize = (recent: ReadonlyArray<PipelineRun>): PipelineRunList["summary"] => {
  const counted = recent.filter((run) => run.commitCount !== null);
  const reworkRate =
    counted.length === 0
      ? null
      : counted.filter((run) => (run.commitCount ?? 0) > 2).length / counted.length;
  const durations = recent.flatMap((run) => {
    if (run.sessionStartedAt === null || run.sessionEndedAt === null) return [];
    const start = Date.parse(run.sessionStartedAt);
    const end = Date.parse(run.sessionEndedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    return [end - start];
  });
  const costs = recent.flatMap((run) =>
    run.usageState === "read" && run.convertedCost !== null
      ? [toMicros(run.convertedCost) ?? Number.NaN]
      : [],
  );
  const averageDurationMs =
    durations.length === 0
      ? null
      : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
  const averageConvertedCost =
    costs.length === 0 || costs.some((value) => !Number.isFinite(value))
      ? null
      : fromMicros(Math.round(costs.reduce((sum, value) => sum + value, 0) / costs.length));
  return {
    reworkRate,
    averageDurationMs,
    averageConvertedCost,
    costLabel: PIPELINE_COST_LABEL,
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const issues = yield* GitHubIssues.PipelineGitHubIssues;
  const usage = yield* PipelineMagpieUsage;
  const gate = yield* Semaphore.make(1);
  const repository = `${GitHubIssues.REPOSITORY.owner}/${GitHubIssues.REPOSITORY.name}`;

  const nowIso = Effect.fn("PipelineRuns.nowIso")(function* () {
    return DateTime.formatIso(yield* DateTime.now);
  });

  const writeTick = Effect.fn("PipelineRuns.writeTick")(function* (
    outcome: "ok" | "read-failed",
    detail: string | null,
  ) {
    const at = yield* nowIso();
    yield* sql`
      INSERT INTO pipeline_tick (id, at, outcome, detail) VALUES (1, ${at}, ${outcome}, ${detail})
      ON CONFLICT (id) DO UPDATE SET
        at = excluded.at, outcome = excluded.outcome, detail = excluded.detail
    `.pipe(Effect.mapError(() => readFailure));
  });

  const insertRun = Effect.fn("PipelineRuns.insertRun")(function* (input: {
    readonly issueNumber: number;
    readonly title: string;
    readonly status: PipelineRunStatus;
    readonly stuckReason: PipelineStuckReason | null;
  }) {
    const updatedAt = yield* nowIso();
    yield* sql`
      INSERT INTO pipeline_runs (
        repository, issue_number, title, status, stuck_reason, thread_id, pr_number, head_sha,
        updated_at, session_started_at, session_ended_at, magpie_account, usage_state,
        input_tokens, output_tokens, cache_tokens, converted_cost, commit_count, ci_queue_ms
      ) VALUES (
        ${repository}, ${input.issueNumber}, ${input.title}, ${input.status}, ${input.stuckReason},
        ${null}, ${null}, ${null}, ${updatedAt}, ${null}, ${null}, ${null}, ${"absent"},
        ${null}, ${null}, ${null}, ${null}, ${null}, ${null}
      )
    `.pipe(Effect.mapError(() => readFailure));
  });

  const updateStored = Effect.fn("PipelineRuns.updateStored")(function* (run: StoredRun) {
    yield* sql`
      UPDATE pipeline_runs SET
        status = ${run.status},
        stuck_reason = ${run.stuckReason},
        thread_id = ${run.threadId},
        pr_number = ${run.prNumber},
        head_sha = ${run.headSha},
        updated_at = ${run.updatedAt},
        session_started_at = ${run.sessionStartedAt},
        session_ended_at = ${run.sessionEndedAt},
        magpie_account = ${run.magpieAccount},
        usage_state = ${run.usageState},
        input_tokens = ${run.inputTokens},
        output_tokens = ${run.outputTokens},
        cache_tokens = ${run.cacheTokens},
        converted_cost = ${run.convertedCost},
        commit_count = ${run.commitCount},
        ci_queue_ms = ${run.ciQueueMs}
      WHERE id = ${run.id}
    `.pipe(Effect.mapError(() => readFailure));
  });

  const markUnread = (run: StoredRun, updatedAt: string): StoredRun => ({
    ...run,
    updatedAt,
    usageState: "unread",
    magpieAccount: null,
    inputTokens: null,
    outputTokens: null,
    cacheTokens: null,
    convertedCost: null,
  });

  const fillSpend = Effect.fn("PipelineRuns.fillSpend")(function* () {
    for (const run of yield* loadRuns(sql)) {
      if (
        run.sessionStartedAt === null ||
        run.sessionEndedAt === null ||
        run.usageState === "read"
      ) {
        continue;
      }
      const csv = yield* usage.readCsv(run.sessionStartedAt).pipe(Effect.result);
      const updatedAt = yield* nowIso();
      if (Result.isFailure(csv)) {
        if (run.usageState !== "unread") yield* updateStored(markUnread(run, updatedAt));
        continue;
      }
      const sliced = sliceMagpieUsageCsv(csv.success, run.sessionStartedAt, run.sessionEndedAt);
      if (!sliced.read) {
        if (run.usageState !== "unread") yield* updateStored(markUnread(run, updatedAt));
        continue;
      }
      yield* updateStored({
        ...run,
        updatedAt,
        usageState: "read",
        magpieAccount: sliced.magpieAccount,
        inputTokens: sliced.inputTokens,
        outputTokens: sliced.outputTokens,
        cacheTokens: sliced.cacheTokens,
        convertedCost: sliced.convertedCost,
      });
    }
  });

  const tickBody = Effect.fn("PipelineRuns.tick")(function* (): Effect.fn.Return<
    TickResult,
    PipelineRunReadError
  > {
    const current = yield* settings.getSettings.pipe(Effect.mapError(() => readFailure));
    if (!current.pipelineEnabled) return { outcome: "disabled" };

    const listed = yield* issues.listEligible().pipe(Effect.result);
    if (Result.isFailure(listed)) {
      yield* writeTick("read-failed", failureDetail(listed.failure));
      return { outcome: "read-failed" };
    }

    const existing = yield* loadRuns(sql);
    const activeIssues = new Set<number>();
    let openSessions = 0;
    for (const run of existing) {
      if (run.repository !== repository) continue;
      if (activeRun(run)) activeIssues.add(run.issueNumber);
      if (run.status === "session") openSessions++;
    }

    const eligible = [...listed.success].sort((left, right) => left.number - right.number);
    for (const issue of eligible) {
      if (!issue.body.includes(ACCEPTANCE)) continue;
      if (issue.body.includes(WORKFLOWS_PATH)) {
        if (!activeIssues.has(issue.number)) {
          yield* insertRun({
            issueNumber: issue.number,
            title: issue.title,
            status: "stuck",
            stuckReason: "交人",
          });
          activeIssues.add(issue.number);
        }
        continue;
      }
      // One active run per issue, and at most one open session in the whole pipeline.
      if (activeIssues.has(issue.number) || openSessions >= MAX_OPEN_SESSIONS) continue;
      yield* insertRun({
        issueNumber: issue.number,
        title: issue.title,
        status: "claimed",
        stuckReason: null,
      });
      activeIssues.add(issue.number);
    }

    yield* fillSpend();
    yield* writeTick("ok", null);
    return { outcome: "ok" };
  });

  const listBody = Effect.fn("PipelineRuns.list")(function* () {
    const runs = (yield* loadRuns(sql)).map((run): PipelineRun => ({
      ...run,
      usageNote: run.usageState === "unread" ? PIPELINE_USAGE_UNREAD : null,
      costLabel: PIPELINE_COST_LABEL,
    }));
    const recent = runs.slice(0, PIPELINE_RECENT_RUNS);
    const ticks = yield* sql`
      SELECT at, outcome, detail FROM pipeline_tick WHERE id = 1
    `.pipe(
      Effect.mapError(() => readFailure),
      Effect.flatMap((rows) => decodeTick(rows).pipe(Effect.mapError(() => readFailure))),
    );
    const lastTick: PipelineTick | null = ticks[0] ?? null;
    return { runs, recent, summary: summarize(recent), lastTick };
  });

  const noteBody = Effect.fn("PipelineRuns.note")(function* (
    issueNumber: number,
    patch: PipelineRunNote,
  ) {
    const current = (yield* loadRuns(sql)).find(
      (run) => run.issueNumber === issueNumber && activeRun(run),
    );
    if (current === undefined) return yield* new PipelineRunMissing({ issueNumber });
    const sessionStartedAt =
      patch.sessionStartedAt === undefined ? current.sessionStartedAt : patch.sessionStartedAt;
    const sessionEndedAt =
      patch.sessionEndedAt === undefined ? current.sessionEndedAt : patch.sessionEndedAt;
    const windowChanged =
      sessionStartedAt !== current.sessionStartedAt || sessionEndedAt !== current.sessionEndedAt;
    yield* updateStored({
      ...current,
      status: patch.status ?? current.status,
      stuckReason: patch.stuckReason === undefined ? current.stuckReason : patch.stuckReason,
      threadId: patch.threadId === undefined ? current.threadId : patch.threadId,
      prNumber: patch.prNumber === undefined ? current.prNumber : patch.prNumber,
      headSha: patch.headSha === undefined ? current.headSha : patch.headSha,
      sessionStartedAt,
      sessionEndedAt,
      commitCount: patch.commitCount === undefined ? current.commitCount : patch.commitCount,
      ciQueueMs: patch.ciQueueMs === undefined ? current.ciQueueMs : patch.ciQueueMs,
      updatedAt: yield* nowIso(),
      ...(windowChanged
        ? {
            usageState: "absent" as const,
            magpieAccount: null,
            inputTokens: null,
            outputTokens: null,
            cacheTokens: null,
            convertedCost: null,
          }
        : {}),
    });
  });

  return PipelineRuns.of({
    tick: Effect.fn("PipelineRuns.tick")(function* () {
      return yield* gate.withPermits(1)(tickBody());
    }),
    list: Effect.fn("PipelineRuns.list")(function* () {
      return yield* gate.withPermits(1)(listBody());
    }),
    note: Effect.fn("PipelineRuns.note")(function* (issueNumber: number, patch: PipelineRunNote) {
      return yield* gate.withPermits(1)(noteBody(issueNumber, patch));
    }),
  });
});

export const layer = Layer.effect(PipelineRuns, make);

const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const runs = yield* PipelineRuns;
    const step = runs
      .tick()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pipeline.tick.failed", { cause }).pipe(
            Effect.as({ outcome: "failed" }),
          ),
        ),
      );
    yield* forkParked(Effect.repeat(step, Schedule.spaced(TICK_INTERVAL)));
  }),
);

/**
 * The GitHub driver's REST client stays inside that driver, so the tick builds its own.
 * One list every five minutes does not share the driver's in-memory quota reserve.
 */
const services = layer.pipe(
  Layer.provide(GitHubIssues.layer),
  Layer.provide(GitHubRest.layerWithDependencies),
  Layer.provide(layerMagpieUsage),
);

export const layerLive = Layer.merge(services, layerWorker.pipe(Layer.provide(services)));
