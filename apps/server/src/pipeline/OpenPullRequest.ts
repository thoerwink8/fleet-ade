import { PipelineRunsError, ServerSettingsError } from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { PipelineBudget } from "./budget.ts";
import { sessionBranch } from "./DispatchSession.ts";
import { PIPELINE_HOST, PipelineGitHubIssues, layer as issuesLayer } from "./GitHubIssues.ts";
import { PipelineRuns, type PipelineRunNote } from "./PipelineRuns.ts";
import { shouldAdvancePipelineRun } from "./pipelineAdvance.ts";
import { parseRepo } from "./repoAllowlist.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const BASE_BRANCH = "main";

/**
 * The workflow name in ci.yml. Check-run names are job names, so a pull
 * request's check list never contains this.
 */
const CI_WORKFLOW = "CI";

/** Recorded when CI is green. Cold verify selects status `verify`, not this text. */
const CI_GREEN = "CI 已绿、未验";
const UNREAD = "没查成";
const NO_CHECK = "没有检查";
const CHECK_RED = "检查红";

const TICK_INTERVAL = Duration.minutes(5);

const WorkflowRun = Schema.Struct({
  id: Schema.Int,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
});

const WorkflowRunsPage = Schema.Struct({
  total_count: Schema.optional(Schema.Int),
  workflow_runs: Schema.Array(WorkflowRun),
});

const decodeRunsPage = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRunsPage));

const RUNNING: Record<string, true> = {
  queued: true,
  in_progress: true,
  waiting: true,
  requested: true,
  pending: true,
  action_required: true,
};

/** 任务单里「怎么算做完」一节的条目。开 PR 时这是项目改动的来源。 */
export const acceptanceItems = (body: string): ReadonlyArray<string> => {
  let inSection = false;
  const items: Array<string> = [];
  for (const line of body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(\S.*?)\s*$/.exec(line);
    if (heading !== null) {
      if (inSection) break;
      inSection = heading[2] === "怎么算做完";
      continue;
    }
    if (!inSection) continue;
    const item = /^\s*(?:[-*]|\d+[.)])\s+(\S.*?)\s*$/.exec(line);
    if (item !== null) items.push(item[1]!);
  }
  return items;
};

/**
 * 正文只写项目改动和已经记下的验证结果。不写谁开的、不写运行来源。
 * 验证结果为空就明说还没有，不编一条。
 */
export const pullRequestBody = (input: {
  readonly changes: ReadonlyArray<string>;
  readonly verification: ReadonlyArray<string>;
}): string => {
  const changes =
    input.changes.length === 0
      ? "- 任务单没有写下改动"
      : input.changes.map((item) => `- ${item}`).join("\n");
  const verification =
    input.verification.length === 0
      ? "- 还没有记下验证结果"
      : input.verification.map((item) => `- ${item}`).join("\n");
  return `## 改动\n\n${changes}\n\n## 验证\n\n${verification}\n`;
};

const RECORDED_CHECK = /^(?:vp|pnpm|npm|node|bun|deno|pytest|cargo|go test|make)\b/;

/** 提交说明里真正跑过的检查。描述、任务号、运行来源都不算。 */
export const recordedChecks = (subjects: ReadonlyArray<string>): ReadonlyArray<string> => {
  const checks: Array<string> = [];
  for (const subject of subjects) {
    for (const piece of subject.split(/[\n；;]+/)) {
      const check = piece.trim().replace(/^[-*]\s+/, "");
      if (RECORDED_CHECK.test(check) && !checks.includes(check)) checks.push(check);
    }
  }
  return checks;
};

export interface OpenedPullRequest {
  readonly number: number;
  readonly headSha?: string;
}

export class PullRequestOpenError extends Schema.TaggedError<PullRequestOpenError>()(
  "PullRequestOpenError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface PullRequestDraft {
  readonly cwd: string;
  readonly branch: string;
  readonly title: string;
  /** 任务单原文。改动一节只从这里的「怎么算做完」取。 */
  readonly issueBody: string;
  readonly headSha: string;
}

/**
 * Push the session branch, then open one pull request.
 * The body is composed from the issue and the commits on the branch.
 * An open request for the same branch is reused. Tests replace this.
 */
export class PullRequestOpener extends Context.Service<
  PullRequestOpener,
  {
    readonly open: (
      draft: PullRequestDraft,
    ) => Effect.Effect<OpenedPullRequest, PullRequestOpenError>;
  }
>()("t3/pipeline/OpenPullRequest/PullRequestOpener") {}

export type CiCheckOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure" }
  | { readonly kind: "pending" }
  | { readonly kind: "missing" };

export class CiCheckReadError extends Schema.TaggedError<CiCheckReadError>()(
  "CiCheckReadError",
  {},
) {
  override get message(): string {
    return UNREAD;
  }
}

/** The `CI` workflow run on one commit. A missing run is not a failure. */
export class CiCheckReader extends Context.Service<
  CiCheckReader,
  {
    readonly read: (input: {
      readonly headSha: string;
      readonly repository: string;
    }) => Effect.Effect<CiCheckOutcome, CiCheckReadError>;
  }
>()("t3/pipeline/OpenPullRequest/CiCheckReader") {}

const failOpen = (detail: string) => new PullRequestOpenError({ detail });

const makeOpener = Effect.gen(function* () {
  const git = yield* GitWorkflowService.GitWorkflowService;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const open = Effect.fn("OpenPullRequest.open")(function* (draft: PullRequestDraft) {
    const logged = yield* driver
      .execute({
        operation: "OpenPullRequest.commitSubjects",
        cwd: draft.cwd,
        args: ["log", "--format=%s%n%b%x00", `origin/${BASE_BRANCH}..HEAD`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.mapError((error) => failOpen(error.message)));
    if (logged.exitCode !== 0 || logged.stdoutTruncated) {
      return yield* failOpen("commit subjects were not read");
    }
    const body = pullRequestBody({
      changes: acceptanceItems(draft.issueBody),
      verification: recordedChecks(logged.stdout.split("\u0000")),
    });
    const pushedBranch = yield* git
      .runStackedAction({
        actionId: `pipeline-pr-${draft.branch}`,
        cwd: draft.cwd,
        action: "push",
      })
      .pipe(Effect.mapError((error) => failOpen(error.message)));
    if (
      pushedBranch.push.status !== "pushed" &&
      pushedBranch.push.status !== "skipped_up_to_date"
    ) {
      return yield* failOpen("branch was not pushed");
    }

    const provider = yield* registry
      .resolve({ cwd: draft.cwd })
      .pipe(Effect.mapError((error) => failOpen(error.message)));
    const listed = yield* provider
      .listChangeRequests({
        cwd: draft.cwd,
        headSelector: draft.branch,
        state: "open",
        limit: 20,
      })
      .pipe(Effect.mapError((error) => failOpen(error.message)));
    const matches = listed.filter((request) => request.headRefName === draft.branch);
    const existing = matches.find((request) => request.headSha === draft.headSha) ?? matches[0];
    if (existing !== undefined) {
      return {
        number: existing.number,
        ...(existing.headSha === undefined ? {} : { headSha: existing.headSha }),
      };
    }

    const directory = yield* fileSystem
      .makeTempDirectory({ prefix: "pipeline-pr-" })
      .pipe(Effect.mapError((error) => failOpen(error.message)));
    const created = yield* Effect.gen(function* () {
      const bodyFile = path.join(directory, "body.md");
      yield* fileSystem.writeFileString(bodyFile, body);
      yield* provider.createChangeRequest({
        cwd: draft.cwd,
        baseRefName: BASE_BRANCH,
        headSelector: draft.branch,
        title: draft.title,
        bodyFile,
      });
      const after = yield* provider.listChangeRequests({
        cwd: draft.cwd,
        headSelector: draft.branch,
        state: "open",
        limit: 20,
      });
      return after.find((request) => request.headRefName === draft.branch);
    }).pipe(
      Effect.mapError((error) => failOpen(error.message)),
      Effect.ensuring(fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore)),
    );
    if (created === undefined) return yield* failOpen("pull request number was not found");
    return {
      number: created.number,
      ...(created.headSha === undefined ? {} : { headSha: created.headSha }),
    };
  });

  return PullRequestOpener.of({ open });
});

export const layerOpener = Layer.effect(PullRequestOpener, makeOpener);

const makeReader = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;

  const read = Effect.fn("OpenPullRequest.readCi")(function* (input: {
    readonly headSha: string;
    readonly repository: string;
  }) {
    const repo = parseRepo(input.repository);
    if (repo === undefined) return yield* new CiCheckReadError();
    const slug = `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    const response = yield* rest
      .rest({
        host: PIPELINE_HOST,
        operation: "pipelineCiCheck",
        path: `repos/${slug}/actions/runs?head_sha=${encodeURIComponent(input.headSha)}&per_page=100`,
      })
      .pipe(Effect.mapError(() => new CiCheckReadError()));
    if (response.status < 200 || response.status >= 300 || response.truncated) {
      return yield* new CiCheckReadError();
    }
    const page = yield* decodeRunsPage(response.body).pipe(
      Effect.mapError(() => new CiCheckReadError()),
    );
    const named = page.workflow_runs.filter((run) => run.name === CI_WORKFLOW);
    if (named.length === 0) {
      const cutOff =
        page.workflow_runs.length === 100 &&
        (page.total_count === undefined || page.total_count > page.workflow_runs.length);
      if (cutOff) return yield* new CiCheckReadError();
      return { kind: "missing" as const };
    }
    const latest = named.reduce((best, run) => (run.id > best.id ? run : best));
    const status = latest.status ?? "";
    if (status !== "completed") {
      if (RUNNING[status] === true) return { kind: "pending" as const };
      return yield* new CiCheckReadError();
    }
    return latest.conclusion === "success"
      ? { kind: "success" as const }
      : { kind: "failure" as const };
  });

  return CiCheckReader.of({ read });
});

export const layerReader = Layer.effect(CiCheckReader, makeReader);

interface OpenPullRequestShape {
  readonly tick: Effect.Effect<void, PipelineRunsError | ServerSettingsError>;
}

export class OpenPullRequest extends Context.Service<OpenPullRequest, OpenPullRequestShape>()(
  "t3/pipeline/OpenPullRequest",
) {}

const make = Effect.gen(function* () {
  const runs = yield* PipelineRuns;
  const issues = yield* PipelineGitHubIssues;
  const budget = yield* PipelineBudget;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const opener = yield* PullRequestOpener;
  const reader = yield* CiCheckReader;

  const writeDetail = (
    issueNumber: number,
    current: string | null,
    next: string | null,
    repository: string,
  ) => (current === next ? Effect.void : runs.note(issueNumber, { detail: next }, repository));

  const tick = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    const listed = yield* runs.list;
    const paths = yield* projections
      .getThreadWorktreePaths({ includeArchived: true })
      .pipe(Effect.mapError((cause) => new PipelineRunsError({ cause })));
    const cwdByThread = new Map(paths.map((entry) => [String(entry.threadId), entry.worktreePath]));

    for (const run of listed.runs) {
      if (!shouldAdvancePipelineRun(current.pipelineEnabled, run)) continue;
      if (run.status !== "session" && run.status !== "pr-open" && run.status !== "checks") continue;
      if (run.status === "session" && run.sessionEndedAt === null) continue;
      const repo = parseRepo(run.repository);
      if (repo === undefined) {
        yield* writeDetail(run.issueNumber, run.detail, UNREAD, run.repository);
        continue;
      }
      if (run.headSha === null) {
        yield* writeDetail(run.issueNumber, run.detail, UNREAD, run.repository);
        continue;
      }
      const verdict = yield* budget.review(run);
      if (verdict === "over") {
        yield* runs.note(
          run.issueNumber,
          {
            status: "stuck",
            stuckReason: "超预算",
            detail: null,
          },
          run.repository,
        );
        continue;
      }
      if (verdict === "hold") {
        yield* writeDetail(run.issueNumber, run.detail, UNREAD, run.repository);
        continue;
      }

      let headSha = run.headSha;
      let status = run.status;
      if (run.prNumber === null) {
        const cwd = run.threadId === null ? undefined : cwdByThread.get(run.threadId);
        if (cwd === undefined) {
          yield* writeDetail(run.issueNumber, run.detail, UNREAD, run.repository);
          continue;
        }
        const issue = yield* issues.read(run.issueNumber, repo).pipe(Effect.exit);
        if (Exit.isFailure(issue)) {
          yield* writeDetail(run.issueNumber, run.detail, UNREAD, run.repository);
          continue;
        }
        const opened = yield* opener
          .open({
            cwd,
            branch: sessionBranch(run.issueNumber, run.title, run.repository),
            title: run.title,
            issueBody: issue.value.body,
            headSha,
          })
          .pipe(Effect.exit);
        if (Exit.isFailure(opened)) {
          yield* writeDetail(run.issueNumber, run.detail, UNREAD, run.repository);
          yield* Effect.logWarning("pipeline.open-pr.unread", {
            issueNumber: run.issueNumber,
            detail: Cause.pretty(opened.cause),
          });
          continue;
        }
        headSha = opened.value.headSha ?? headSha;
        yield* runs.note(
          run.issueNumber,
          {
            status: "pr-open",
            prNumber: opened.value.number,
            headSha,
            detail: null,
          },
          run.repository,
        );
        const lined = yield* budget.review({
          ...run,
          prNumber: opened.value.number,
          status: "pr-open",
        });
        if (lined === "over") {
          yield* runs.note(
            run.issueNumber,
            {
              status: "stuck",
              stuckReason: "超预算",
              detail: null,
            },
            run.repository,
          );
          continue;
        }
        if (lined === "hold") {
          yield* writeDetail(run.issueNumber, null, UNREAD, run.repository);
          continue;
        }
        status = "pr-open";
      }
      if (status !== "checks") {
        yield* runs.note(run.issueNumber, { status: "checks" }, run.repository);
      }

      const outcome = yield* reader.read({ headSha, repository: run.repository }).pipe(Effect.exit);
      if (Exit.isFailure(outcome)) {
        yield* writeDetail(
          run.issueNumber,
          status === "checks" ? run.detail : null,
          UNREAD,
          run.repository,
        );
        continue;
      }
      if (outcome.value.kind === "failure") {
        yield* budget.settle(run.issueNumber, { reason: CHECK_RED, detail: null }, run.repository);
        continue;
      }
      const note: PipelineRunNote =
        outcome.value.kind === "success"
          ? { status: "verify", detail: CI_GREEN }
          : outcome.value.kind === "missing"
            ? { detail: NO_CHECK }
            : { detail: null };
      const currentDetail = status === "checks" ? run.detail : null;
      if (
        note.status === undefined &&
        note.detail !== undefined &&
        note.detail === currentDetail &&
        status === "checks"
      ) {
        continue;
      }
      yield* runs.note(run.issueNumber, note, run.repository);
    }
  }).pipe(Effect.withSpan("OpenPullRequest.tick"));

  return OpenPullRequest.of({ tick });
});

export const layer = Layer.effect(OpenPullRequest, make);

export const layerLive = layer.pipe(
  Layer.provide(layerOpener),
  Layer.provide(layerReader),
  Layer.provide(issuesLayer),
  Layer.provide(GitHubRest.layerWithDependencies),
  Layer.provide(GitVcsDriver.layer),
);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const opening = yield* OpenPullRequest;
    yield* forkParked(
      opening.tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pipeline.open-pr.tick-failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
      ),
    );
  }),
);
