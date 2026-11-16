import {
  CommandId,
  MessageId,
  PipelineRunsError,
  ServerSettingsError,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Command,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";

import { forkParked } from "../serverActivation.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { REPOSITORY, PipelineGitHubIssues, type PipelineIssue } from "./GitHubIssues.ts";
import { PipelineBudget } from "./budget.ts";
import { PipelineRuns, type PipelineRunNote } from "./PipelineRuns.ts";
import { SessionEndInbox, type SessionEndEntry } from "./SessionEndInbox.ts";

const STUCK_NO_MODEL = "没配模型";
const STUCK_SESSION_FAILED = "会话失败";
const STUCK_TIMEOUT = "超时";
const STUCK_CANCELLED = "取消";
const REPOSITORY_NAME = `${REPOSITORY.owner}/${REPOSITORY.name}`;

const branchFragment = (title: string): string => {
  const fragment = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return fragment.length > 0 ? fragment : "issue";
};

export const sessionBranch = (issueNumber: number, title: string): string =>
  `pipeline/${issueNumber}-${branchFragment(title)}`;

/** A run the session step can still move. Later states belong to later issues. */
const OPEN_STATUSES = ["claimed", "session"] as const;

interface OpenRun {
  readonly id: number;
  readonly issueNumber: number;
  readonly title: string;
  readonly status: (typeof OPEN_STATUSES)[number];
  readonly threadId: string | null;
  readonly sessionStartedAt: string | null;
  readonly sessionEndedAt: string | null;
  readonly renewedOnce: boolean;
}

const OpenRunRow = Schema.Struct({
  id: Schema.Int,
  issueNumber: Schema.Int,
  title: Schema.String,
  status: Schema.Literals(OPEN_STATUSES),
  threadId: Schema.NullOr(Schema.String),
  sessionStartedAt: Schema.NullOr(Schema.String),
  sessionEndedAt: Schema.NullOr(Schema.String),
  renewedOnce: Schema.Boolean,
});

export interface DispatchedSession {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly worktreePath: string;
  readonly modelSelection: ModelSelection;
  readonly text: string;
}

/**
 * What opening a session does. The live one dispatches `thread.create` then one
 * `message.dispatch` carrying the issue body. Tests replace it and count calls.
 */
interface SessionOpenerShape {
  readonly open: (
    session: DispatchedSession,
  ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
}

export class SessionOpener extends Context.Service<SessionOpener, SessionOpenerShape>()(
  "t3/pipeline/DispatchSession/SessionOpener",
) {}

const decodeOpenRuns = Schema.decodeUnknownEffect(Schema.Array(OpenRunRow));

const matchesRepository = (owner: string | undefined, name: string | undefined): boolean =>
  owner === REPOSITORY.owner && name === REPOSITORY.name;

const minutesSince = (startedAt: string, now: DateTime.DateTime): number | undefined => {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return undefined;
  return (DateTime.toEpochMillis(now) - started) / 60_000;
};

const failNote = (terminal: SessionEndEntry["status"]): PipelineRunNote =>
  terminal === "cancelled"
    ? { status: "stuck", stuckReason: STUCK_CANCELLED }
    : { status: "stuck", stuckReason: STUCK_SESSION_FAILED };

interface DispatchSessionShape {
  readonly tick: Effect.Effect<
    void,
    | PipelineRunsError
    | ProjectService.ProjectOperationError
    | Schema.SchemaError
    | ServerSettingsError
    | SqlError.SqlError
  >;
}

const make = Effect.gen(function* () {
  const runs = yield* PipelineRuns;
  const budget = yield* PipelineBudget;
  const issues = yield* PipelineGitHubIssues;
  const inbox = yield* SessionEndInbox;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const opener = yield* SessionOpener;

  const openRuns = Effect.fn("DispatchSession.openRuns")(function* () {
    const listed = yield* runs.list;
    return yield* decodeOpenRuns(
      listed.runs.filter(
        (run) =>
          run.repository === REPOSITORY_NAME &&
          (run.status === "claimed" || run.status === "session"),
      ),
    );
  });

  const projectForRepository = Effect.fn("DispatchSession.projectForRepository")(function* () {
    let cursor = 0;
    for (;;) {
      const page = yield* projects.listPage({ cursor, limit: 50 });
      const match = page.projects.find(
        (project) =>
          project.repositoryIdentity !== null &&
          project.repositoryIdentity !== undefined &&
          matchesRepository(project.repositoryIdentity.owner, project.repositoryIdentity.name),
      );
      if (match !== undefined) return match;
      if (page.nextCursor === null) return undefined;
      cursor = page.nextCursor;
    }
  });

  const stick = (issueNumber: number, note: PipelineRunNote) =>
    note.status === "stuck" && note.stuckReason != null
      ? budget.settle(issueNumber, {
          reason: note.stuckReason,
          ...(note.detail !== undefined ? { detail: note.detail } : {}),
          ...(note.sessionEndedAt !== undefined ? { sessionEndedAt: note.sessionEndedAt } : {}),
        })
      : runs.note(issueNumber, note);

  const applyEnd = Effect.fn("DispatchSession.applyEnd")(function* (
    run: OpenRun,
    entry: SessionEndEntry,
  ) {
    if (entry.status === "completed") {
      const headKnown = entry.headLookup === "found" && entry.headSha !== undefined;
      yield* stick(run.issueNumber, {
        status: "session",
        sessionEndedAt: entry.endedAt,
        ...(headKnown
          ? { headSha: entry.headSha, detail: null }
          : { detail: "会话结束但查不到 head" }),
      });
      return;
    }
    const terminal =
      entry.status === "cancelled"
        ? "取消"
        : entry.status === "interrupted"
          ? "interrupted"
          : "failed";
    yield* stick(run.issueNumber, {
      ...failNote(entry.status),
      sessionEndedAt: entry.endedAt,
      detail: `原终态 ${terminal}`,
    });
  });

  const dispatchClaimed = Effect.fn("DispatchSession.dispatchClaimed")(function* (
    run: OpenRun,
    issue: PipelineIssue,
    model: ModelSelection,
    now: string,
  ) {
    const failed = (detail: string) =>
      stick(run.issueNumber, { status: "stuck", stuckReason: STUCK_SESSION_FAILED, detail }).pipe(
        Effect.tap(() =>
          Effect.logWarning("pipeline.dispatch.session-failed", {
            issueNumber: run.issueNumber,
            detail,
          }),
        ),
      );
    const project = yield* projectForRepository();
    if (project === undefined) return yield* failed("no project for this repository");
    const branch = sessionBranch(issue.number, issue.title);
    const cwd = project.workspaceRoot;
    const base = yield* git
      .fetchWorktreeBaseCommit({ cwd, refName: "main" })
      .pipe(Effect.orElseSucceed(() => null));
    if (base === null) return yield* failed("remote base main is unavailable");
    const created = yield* git
      .createWorktree({
        cwd,
        refName: base.commitSha,
        newRefName: branch,
        baseRefName: `refs/remotes/${base.remoteRefName}`,
        path: null,
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(created)) return yield* failed("worktree was not created");
    const threadId = ThreadId.make(
      `pipeline:${issue.number}:${run.id}${run.renewedOnce ? ":retry" : ""}`,
    );
    const opened = yield* opener
      .open({
        threadId,
        projectId: project.id,
        branch,
        worktreePath: created.value.worktree.path,
        modelSelection: model,
        text: issue.body,
      })
      .pipe(Effect.exit);
    if (Exit.isFailure(opened)) return yield* failed("session was not opened");
    yield* stick(run.issueNumber, { status: "session", threadId, sessionStartedAt: now });
  });

  const tick = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    if (!current.pipelineEnabled) return;
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const timeout = Duration.toMillis(Duration.minutes(current.pipelineSessionTimeoutMinutes));
    const pending = yield* openRuns();
    const ends = yield* inbox.list;
    const endByThread = new Map(ends.map((entry) => [entry.threadId, entry]));

    for (const run of pending) {
      if (run.status === "session") {
        if (run.sessionEndedAt !== null) continue;
        const entry =
          run.threadId === null ? undefined : endByThread.get(ThreadId.make(run.threadId));
        if (entry !== undefined) {
          yield* applyEnd(run, entry);
          continue;
        }
        const elapsed =
          run.sessionStartedAt === null ? undefined : minutesSince(run.sessionStartedAt, now);
        if (elapsed !== undefined && elapsed * 60_000 > timeout) {
          yield* stick(run.issueNumber, {
            status: "stuck",
            stuckReason: STUCK_TIMEOUT,
            sessionEndedAt: nowIso,
            detail: "超时",
          });
        }
        continue;
      }

      if (run.threadId !== null) continue;
      const model = current.pipelineAuthorModel;
      if (model === null) {
        yield* stick(run.issueNumber, { status: "stuck", stuckReason: STUCK_NO_MODEL });
        continue;
      }
      const issue = yield* issues.read(run.issueNumber).pipe(Effect.option);
      if (Option.isNone(issue)) {
        yield* stick(run.issueNumber, {
          status: "stuck",
          stuckReason: STUCK_SESSION_FAILED,
          detail: "读不到这张单",
        });
        continue;
      }
      if ((yield* openRuns()).some((item) => item.status === "session")) continue;
      yield* dispatchClaimed(run, issue.value, model, nowIso);
    }
  }).pipe(Effect.withSpan("DispatchSession.tick"));

  return { tick };
});

export class DispatchSession extends Context.Service<DispatchSession, DispatchSessionShape>()(
  "t3/pipeline/DispatchSession",
) {}

const liveOpener = Layer.effect(
  SessionOpener,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const open = Effect.fn("DispatchSession.open")(function* (session: DispatchedSession) {
      const create: OrchestrationV2Command = {
        type: "thread.create",
        commandId: CommandId.make(`pipeline:create:${session.threadId}`),
        threadId: session.threadId,
        projectId: session.projectId,
        title: session.branch,
        modelSelection: session.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: session.branch,
        worktreePath: session.worktreePath,
        createdBy: "system",
        creationSource: "server",
      };
      yield* orchestrator.dispatch(create);
      const message: OrchestrationV2Command = {
        type: "message.dispatch",
        commandId: CommandId.make(`pipeline:message:${session.threadId}`),
        threadId: session.threadId,
        messageId: MessageId.make(`pipeline:message:${session.threadId}`),
        text: session.text,
        attachments: [],
        modelSelection: session.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "system",
        creationSource: "server",
      };
      yield* orchestrator.dispatch(message);
    });
    return SessionOpener.of({ open });
  }),
);

export const layer = Layer.effect(DispatchSession, make);

export const layerLive = layer.pipe(Layer.provide(liveOpener));

const TICK_INTERVAL = Duration.minutes(5);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const session = yield* DispatchSession;
    yield* forkParked(
      session.tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pipeline.dispatch.tick-failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
      ),
    );
  }),
);
