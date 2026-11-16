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
import { sessionBranch } from "./DispatchSession.ts";
import { PIPELINE_HOST, REPOSITORY } from "./GitHubIssues.ts";
import { PipelineRuns, type PipelineRunNote } from "./PipelineRuns.ts";

const REPOSITORY_NAME = `${REPOSITORY.owner}/${REPOSITORY.name}`;
const BASE_BRANCH = "main";

/**
 * The workflow name in ci.yml. Check-run names are job names, so a pull
 * request's check list never contains this.
 */
const CI_WORKFLOW = "CI";

/** Cold-verify picks this up. This step does not enter `verify`. */
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

export const pullRequestBody = (issueNumber: number, title: string): string =>
  `#${issueNumber} ${title.trim()}\n\n流水线开的\n`;

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
  readonly body: string;
  readonly headSha: string;
}

/**
 * Push the session branch, then open one pull request with a fixed body.
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
    }) => Effect.Effect<CiCheckOutcome, CiCheckReadError>;
  }
>()("t3/pipeline/OpenPullRequest/CiCheckReader") {}

const failOpen = (detail: string) => new PullRequestOpenError({ detail });

const makeOpener = Effect.gen(function* () {
  const git = yield* GitWorkflowService.GitWorkflowService;
  const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const open = Effect.fn("OpenPullRequest.open")(function* (draft: PullRequestDraft) {
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
      yield* fileSystem.writeFileString(bodyFile, draft.body);
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

  const read = Effect.fn("OpenPullRequest.readCi")(function* (input: { readonly headSha: string }) {
    const slug = `${encodeURIComponent(REPOSITORY.owner)}/${encodeURIComponent(REPOSITORY.name)}`;
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
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const opener = yield* PullRequestOpener;
  const reader = yield* CiCheckReader;

  const writeDetail = (issueNumber: number, current: string | null, next: string | null) =>
    current === next ? Effect.void : runs.note(issueNumber, { detail: next });

  const tick = Effect.gen(function* () {
    if (!(yield* settings.getSettings).pipelineEnabled) return;
    const listed = yield* runs.list;
    const paths = yield* projections
      .getThreadWorktreePaths({ includeArchived: true })
      .pipe(Effect.mapError((cause) => new PipelineRunsError({ cause })));
    const cwdByThread = new Map(paths.map((entry) => [String(entry.threadId), entry.worktreePath]));

    for (const run of listed.runs) {
      if (run.repository !== REPOSITORY_NAME) continue;
      if (run.status !== "session" && run.status !== "pr-open" && run.status !== "checks") continue;
      if (run.status === "checks" && run.detail === CI_GREEN) continue;
      if (run.status === "session" && run.sessionEndedAt === null) continue;
      if (run.headSha === null) {
        yield* writeDetail(run.issueNumber, run.detail, UNREAD);
        continue;
      }

      let headSha = run.headSha;
      let status = run.status;
      if (run.prNumber === null) {
        const cwd = run.threadId === null ? undefined : cwdByThread.get(run.threadId);
        if (cwd === undefined) {
          yield* writeDetail(run.issueNumber, run.detail, UNREAD);
          continue;
        }
        const opened = yield* opener
          .open({
            cwd,
            branch: sessionBranch(run.issueNumber, run.title),
            title: run.title,
            body: pullRequestBody(run.issueNumber, run.title),
            headSha,
          })
          .pipe(Effect.exit);
        if (Exit.isFailure(opened)) {
          yield* writeDetail(run.issueNumber, run.detail, UNREAD);
          yield* Effect.logWarning("pipeline.open-pr.unread", {
            issueNumber: run.issueNumber,
            detail: Cause.pretty(opened.cause),
          });
          continue;
        }
        headSha = opened.value.headSha ?? headSha;
        yield* runs.note(run.issueNumber, {
          status: "pr-open",
          prNumber: opened.value.number,
          headSha,
          detail: null,
        });
        status = "pr-open";
      }
      if (status !== "checks") {
        yield* runs.note(run.issueNumber, { status: "checks" });
      }

      const outcome = yield* reader.read({ headSha }).pipe(Effect.exit);
      if (Exit.isFailure(outcome)) {
        yield* writeDetail(run.issueNumber, status === "checks" ? run.detail : null, UNREAD);
        continue;
      }
      const note: PipelineRunNote =
        outcome.value.kind === "success"
          ? { detail: CI_GREEN }
          : outcome.value.kind === "failure"
            ? { status: "stuck", stuckReason: CHECK_RED, detail: null }
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
      yield* runs.note(run.issueNumber, note);
    }
  }).pipe(Effect.withSpan("OpenPullRequest.tick"));

  return OpenPullRequest.of({ tick });
});

export const layer = Layer.effect(OpenPullRequest, make);

export const layerLive = layer.pipe(
  Layer.provide(layerOpener),
  Layer.provide(layerReader),
  Layer.provide(GitHubRest.layerWithDependencies),
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
