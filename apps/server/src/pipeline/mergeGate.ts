import {
  PipelineRunsError,
  ServerSettingsError,
  type PipelineRun,
  type PipelineStuckReason,
} from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PipelineBudget } from "./budget.ts";
import { PIPELINE_HOST } from "./GitHubIssues.ts";
import { PipelineRuns, type PipelineRunNote } from "./PipelineRuns.ts";
import { shouldAdvancePipelineRun } from "./pipelineAdvance.ts";
import { parseRepo } from "./repoAllowlist.ts";
import standardPathsFile from "./standard-paths.json" with { type: "json" };

/** Workflow name in ci.yml. Job names are not this. */
const CI_CHECK_NAME = "CI";

/** Commit status written by cold verify. */
const COLD_VERIFY_CONTEXT = "cold-verify";

const WORKFLOWS_PATH = ".github/workflows/";
const UNREAD = "没查成";
const HANDOVER: PipelineStuckReason = "交人";

const TICK_INTERVAL = Duration.minutes(5);

export type CheckState = "success" | "failure" | "pending" | "missing";

export interface HeadCheck {
  readonly state: CheckState;
  readonly sha: string | null;
}

export interface RequiredCheck {
  readonly name: string;
  readonly state: CheckState;
  readonly sha: string | null;
}

export interface MergeGateFacts {
  readonly headSha: string;
  readonly checks: ReadonlyArray<RequiredCheck>;
  readonly coldVerify: HeadCheck;
  readonly paths: ReadonlyArray<string>;
  readonly autoMerge: boolean;
  readonly supervised?: boolean;
  readonly controllerVerdict?: "accepted" | "rejected" | null;
  readonly acceptedHeadSha?: string | null;
}

export type MergeGateDecision =
  | { readonly kind: "hold" }
  | { readonly kind: "stuck"; readonly reason: PipelineStuckReason }
  | { readonly kind: "unread"; readonly detail: typeof UNREAD }
  | { readonly kind: "mergeable" }
  | { readonly kind: "merge" };

const isPathList = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === "string" && item.length > 0);

const readStandardPaths = (): ReadonlyArray<string> => {
  const value: unknown = standardPathsFile;
  if (!isPathList(value)) throw new Error("改标准的路径清单认不出");
  return value;
};

/**
 * Every check on this head must be success, including one named CI, and
 * cold-verify must be success on this head. Listed paths and
 * `.github/workflows/` are handover. A list that cannot be read is 没查成.
 */
export const decideMerge = (
  facts: MergeGateFacts,
  readPaths: () => ReadonlyArray<string> = readStandardPaths,
): MergeGateDecision => {
  if (facts.paths.some((path) => path.startsWith(WORKFLOWS_PATH))) {
    return { kind: "stuck", reason: HANDOVER };
  }
  let rules: ReadonlyArray<string>;
  try {
    rules = readPaths();
  } catch {
    return { kind: "unread", detail: UNREAD };
  }
  if (rules.length === 0) return { kind: "unread", detail: UNREAD };
  if (
    facts.paths.some((path) =>
      rules.some((rule) => (rule.endsWith("/") ? path.startsWith(rule) : path === rule)),
    )
  ) {
    return { kind: "stuck", reason: HANDOVER };
  }
  const onThisHead = (check: RequiredCheck): boolean =>
    check.state === "success" && check.sha === facts.headSha;
  if (
    facts.supervised === true &&
    (facts.controllerVerdict !== "accepted" || facts.acceptedHeadSha !== facts.headSha)
  ) {
    return { kind: "hold" };
  }
  if (
    !facts.checks.some((check) => check.name === CI_CHECK_NAME && onThisHead(check)) ||
    !facts.checks.every(onThisHead) ||
    facts.coldVerify.state !== "success" ||
    facts.coldVerify.sha !== facts.headSha
  ) {
    return { kind: "hold" };
  }
  return facts.supervised === true || !facts.autoMerge ? { kind: "mergeable" } : { kind: "merge" };
};

export interface MergeGateObservation {
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly state: CheckState;
  }>;
  readonly coldVerify: CheckState;
  readonly paths: ReadonlyArray<string>;
  /** True when this head is already merged. A failed read is an error, not this. */
  readonly merged: boolean;
}

export class MergeGateReadError extends Schema.TaggedError<MergeGateReadError>()(
  "MergeGateReadError",
  {},
) {
  override get message(): string {
    return UNREAD;
  }
}

export class MergeRequestError extends Schema.TaggedError<MergeRequestError>()(
  "MergeRequestError",
  {},
) {
  override get message(): string {
    return UNREAD;
  }
}

/** One pull request's checks, cold-verify status, diff paths, and merged flag. */
export class MergeGateReader extends Context.Service<
  MergeGateReader,
  {
    readonly read: (input: {
      readonly number: number;
      readonly headSha: string;
      readonly repository: string;
    }) => Effect.Effect<MergeGateObservation, MergeGateReadError>;
  }
>()("t3/pipeline/mergeGate/MergeGateReader") {}

/** The existing merge. Tests replace this and count calls. */
export class PullRequestMerger extends Context.Service<
  PullRequestMerger,
  {
    readonly merge: (input: {
      readonly number: number;
      readonly headSha: string;
      readonly repository: string;
    }) => Effect.Effect<void, MergeRequestError>;
  }
>()("t3/pipeline/mergeGate/PullRequestMerger") {}

const WorkflowRun = Schema.Struct({
  id: Schema.Int,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  head_sha: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
});

const WorkflowRunsPage = Schema.Struct({
  total_count: Schema.optional(Schema.Int),
  workflow_runs: Schema.Array(WorkflowRun),
});

const CommitStatus = Schema.Struct({
  context: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
});

const CombinedStatus = Schema.Struct({
  sha: Schema.optional(Schema.NullOr(Schema.String)),
  statuses: Schema.Array(CommitStatus),
});

const DiffFile = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optional(Schema.NullOr(Schema.String)),
});

const PullRequest = Schema.Struct({
  merged: Schema.optional(Schema.Boolean),
  head: Schema.Struct({
    sha: Schema.String,
  }),
});

const decodeRunsPage = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRunsPage));
const decodeCombined = Schema.decodeUnknownEffect(Schema.fromJsonString(CombinedStatus));
const decodeFiles = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(DiffFile)));
const decodePull = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequest));

const githubSlug = (repository: string): string | undefined => {
  const parsed = parseRepo(repository);
  if (parsed === undefined) return undefined;
  return `${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
};

export const workflowChecks = (
  page: typeof WorkflowRunsPage.Type,
  headSha: string,
): ReadonlyArray<{ readonly name: string; readonly state: CheckState }> | undefined => {
  const cutOff =
    page.workflow_runs.length === 100 &&
    (page.total_count === undefined || page.total_count > page.workflow_runs.length);
  if (cutOff) return undefined;
  const latest = new Map<string, { readonly id: number; readonly state: CheckState }>();
  for (const run of page.workflow_runs) {
    if (run.head_sha !== headSha) continue;
    const name = run.name;
    if (name === undefined || name === null || name.length === 0) return undefined;
    const status = run.status ?? "";
    if (status.length === 0) return undefined;
    const state: CheckState =
      status !== "completed" ? "pending" : run.conclusion === "success" ? "success" : "failure";
    const previous = latest.get(name);
    if (previous === undefined || run.id > previous.id) latest.set(name, { id: run.id, state });
  }
  return [...latest.entries()].map(([name, item]) => ({ name, state: item.state }));
};

const coldState = (page: typeof CombinedStatus.Type, headSha: string): CheckState | undefined => {
  if (page.sha !== undefined && page.sha !== null && page.sha !== headSha) return undefined;
  const named = page.statuses.filter((status) => status.context === COLD_VERIFY_CONTEXT);
  const latest = named.at(-1);
  if (latest === undefined) return "missing";
  const state = latest.state ?? "";
  if (state === "success") return "success";
  if (state === "pending") return "pending";
  if (state.length === 0) return undefined;
  return "failure";
};

const makeReader = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;

  const get = (operation: string, path: string) =>
    rest
      .rest({ host: PIPELINE_HOST, operation, path })
      .pipe(Effect.mapError(() => new MergeGateReadError()));

  const read = Effect.fn("mergeGate.read")(function* (input: {
    readonly number: number;
    readonly headSha: string;
    readonly repository: string;
  }) {
    const slug = githubSlug(input.repository);
    if (slug === undefined) return yield* new MergeGateReadError();
    const [runs, statuses, files, pull] = yield* Effect.all(
      [
        get(
          "pipelineMergeCi",
          `repos/${slug}/actions/runs?head_sha=${encodeURIComponent(input.headSha)}&per_page=100`,
        ),
        get(
          "pipelineMergeStatus",
          `repos/${slug}/commits/${encodeURIComponent(input.headSha)}/status`,
        ),
        get("pipelineMergeFiles", `repos/${slug}/pulls/${input.number}/files?per_page=100`),
        get("pipelineMergePull", `repos/${slug}/pulls/${input.number}`),
      ],
      { concurrency: 1 },
    );
    for (const response of [runs, statuses, files, pull]) {
      if (response.status < 200 || response.status >= 300 || response.truncated) {
        return yield* new MergeGateReadError();
      }
    }
    const decodedRuns = yield* decodeRunsPage(runs.body).pipe(
      Effect.mapError(() => new MergeGateReadError()),
    );
    const decodedStatus = yield* decodeCombined(statuses.body).pipe(
      Effect.mapError(() => new MergeGateReadError()),
    );
    const decodedFiles = yield* decodeFiles(files.body).pipe(
      Effect.mapError(() => new MergeGateReadError()),
    );
    const decodedPull = yield* decodePull(pull.body).pipe(
      Effect.mapError(() => new MergeGateReadError()),
    );
    if (decodedPull.head.sha !== input.headSha) return yield* new MergeGateReadError();
    if (decodedFiles.length === 100) return yield* new MergeGateReadError();
    const checks = workflowChecks(decodedRuns, input.headSha);
    const coldVerify = coldState(decodedStatus, input.headSha);
    if (checks === undefined || coldVerify === undefined) return yield* new MergeGateReadError();
    return {
      checks,
      coldVerify,
      paths: decodedFiles.flatMap((file) =>
        file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
      ),
      merged: decodedPull.merged === true,
    };
  });

  return MergeGateReader.of({ read });
});

const layerReader = Layer.effect(MergeGateReader, makeReader);

const makeMerger = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;

  const merge = Effect.fn("mergeGate.merge")(function* (input: {
    readonly number: number;
    readonly headSha: string;
    readonly repository: string;
  }) {
    const slug = githubSlug(input.repository);
    if (slug === undefined) return yield* new MergeRequestError();
    const current = yield* rest
      .rest({
        host: PIPELINE_HOST,
        operation: "pipelineMergeRead",
        path: `repos/${slug}/pulls/${input.number}`,
      })
      .pipe(Effect.mapError(() => new MergeRequestError()));
    if (current.status < 200 || current.status >= 300 || current.truncated) {
      return yield* new MergeRequestError();
    }
    const pull = yield* decodePull(current.body).pipe(
      Effect.mapError(() => new MergeRequestError()),
    );
    if (pull.head.sha !== input.headSha) return yield* new MergeRequestError();
    if (pull.merged === true) return;
    const response = yield* rest
      .rest({
        host: PIPELINE_HOST,
        operation: "pipelineMerge",
        method: "PUT",
        path: `repos/${slug}/pulls/${input.number}/merge`,
        body: { sha: input.headSha, merge_method: "merge" },
      })
      .pipe(Effect.mapError(() => new MergeRequestError()));
    if (response.status < 200 || response.status >= 300) return yield* new MergeRequestError();
  });

  return PullRequestMerger.of({ merge });
});

const layerMerger = Layer.effect(PullRequestMerger, makeMerger);

interface MergeGateShape {
  readonly tick: Effect.Effect<void, PipelineRunsError | ServerSettingsError>;
}

export class MergeGate extends Context.Service<MergeGate, MergeGateShape>()(
  "t3/pipeline/mergeGate",
) {}

const sameNote = (run: PipelineRun, note: PipelineRunNote): boolean =>
  (note.status === undefined || note.status === run.status) &&
  (note.stuckReason === undefined || note.stuckReason === run.stuckReason) &&
  (note.detail === undefined || note.detail === run.detail);

const make = Effect.gen(function* () {
  const runs = yield* PipelineRuns;
  const budget = yield* PipelineBudget;
  const settings = yield* ServerSettings.ServerSettingsService;
  const reader = yield* MergeGateReader;
  const merger = yield* PullRequestMerger;

  const write = (run: PipelineRun, note: PipelineRunNote) =>
    sameNote(run, note) ? Effect.void : runs.note(run.issueNumber, note, run.repository);

  const tick = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    const listed = yield* runs.list;
    const attempted = new Set<string>();

    for (const run of listed.runs) {
      if (!shouldAdvancePipelineRun(current.pipelineEnabled, run)) continue;
      if (run.status !== "checks" && run.status !== "verify" && run.status !== "mergeable") {
        continue;
      }
      const headSha = run.headSha;
      const prNumber = run.prNumber;
      if (prNumber === null || headSha === null) {
        yield* write(run, { detail: UNREAD });
        continue;
      }
      const verdict = yield* budget.review(run);
      if (verdict === "over") {
        yield* write(run, { status: "stuck", stuckReason: "超预算", detail: null });
        continue;
      }
      if (verdict === "hold") {
        yield* write(run, { detail: UNREAD });
        continue;
      }

      const observed = yield* reader
        .read({ number: prNumber, headSha, repository: run.repository })
        .pipe(Effect.exit);
      if (Exit.isFailure(observed)) {
        yield* write(run, { detail: UNREAD });
        yield* Effect.logWarning("pipeline.merge-gate.unread", {
          issueNumber: run.issueNumber,
          detail: Cause.pretty(observed.cause),
        });
        continue;
      }
      if (observed.value.merged) {
        yield* write(run, { status: "merged", stuckReason: null, detail: null });
        continue;
      }

      const decision = decideMerge({
        headSha,
        checks: observed.value.checks.map((check) => ({
          name: check.name,
          state: check.state,
          sha: check.state === "missing" ? null : headSha,
        })),
        coldVerify: {
          state: observed.value.coldVerify,
          sha: observed.value.coldVerify === "missing" ? null : headSha,
        },
        paths: observed.value.paths,
        autoMerge: current.pipelineAutoMerge,
        supervised: run.controllerThreadId !== null,
        controllerVerdict: run.controllerVerdict,
        acceptedHeadSha: run.acceptedHeadSha,
      });
      if (decision.kind === "hold") continue;
      if (decision.kind === "unread") {
        yield* write(run, { detail: decision.detail });
        continue;
      }
      if (decision.kind === "stuck") {
        yield* write(run, { status: "stuck", stuckReason: decision.reason, detail: null });
        continue;
      }
      if (decision.kind === "mergeable") {
        yield* write(run, { status: "mergeable", stuckReason: null, detail: null });
        continue;
      }
      if (decision.kind !== "merge") continue;

      const key = `${run.repository}:${prNumber}:${headSha}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      const merged = yield* merger
        .merge({ number: prNumber, headSha, repository: run.repository })
        .pipe(Effect.exit);
      if (Exit.isFailure(merged)) {
        yield* runs.note(
          run.issueNumber,
          {
            status: "mergeable",
            stuckReason: null,
            detail: UNREAD,
          },
          run.repository,
        );
        continue;
      }
      yield* write(run, { status: "merged", stuckReason: null, detail: null });
    }
  }).pipe(Effect.withSpan("mergeGate.tick"));

  return MergeGate.of({ tick });
});

export const layer = Layer.effect(MergeGate, make);

export const layerLive = layer.pipe(Layer.provide(layerReader), Layer.provide(layerMerger));

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const gate = yield* MergeGate;
    yield* forkParked(
      gate.tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pipeline.merge-gate.tick-failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
      ),
    );
  }),
);
