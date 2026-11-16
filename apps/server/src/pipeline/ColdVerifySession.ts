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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlError from "effect/sql/SqlError";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as ServerSettings from "../serverSettings.ts";
import {
  CommitStatusWriteError,
  GitHubCommitStatus,
  type CommitStatusTarget,
  type CommitStatusWrite,
  layer as commitStatusLayer,
} from "./GitHubCommitStatus.ts";
import { REPOSITORY } from "./GitHubIssues.ts";
import { MAX_OPEN_SESSIONS, PipelineRuns, type PipelineRunNote } from "./PipelineRuns.ts";
import { SessionEndInbox } from "./SessionEndInbox.ts";
import { judgeColdVerify, type ColdVerifyModelOutput } from "./coldVerifyVerdict.ts";

const STUCK_NO_MODEL = "没配模型";
const STUCK_COLD_VERIFY = "冷验收不过";
const STUCK_HANDOVER = "交人";
const MAX_ROUNDS = 2;
const REPOSITORY_NAME = `${REPOSITORY.owner}/${REPOSITORY.name}`;
const STATUS_HOST = "github.com";

const VerifyRunRow = Schema.Struct({
  id: Schema.Int,
  repository: Schema.String,
  issueNumber: Schema.Int,
  title: Schema.String,
  prNumber: Schema.NullOr(Schema.Int),
  threadId: Schema.NullOr(Schema.String),
  headSha: Schema.String,
  detail: Schema.NullOr(Schema.String),
});

const decodeVerifyRuns = Schema.decodeUnknownEffect(Schema.Array(VerifyRunRow));

const ModelOutput = Schema.Struct({
  verdict: Schema.NullOr(Schema.Literals(["pass", "fail"])),
  problems: Schema.Array(Schema.Struct({ text: Schema.String })),
  suggestions: Schema.Array(Schema.Struct({ text: Schema.String })),
  handovers: Schema.Array(Schema.Struct({ text: Schema.String })),
});

const decodeModelOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelOutput));

/** One verifier session. The live opener dispatches it; tests replace this and count calls. */
export interface ColdVerifyRequest {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly text: string;
}

interface VerifierOpenerShape {
  readonly open: (
    request: ColdVerifyRequest,
  ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
}

export class VerifierOpener extends Context.Service<VerifierOpener, VerifierOpenerShape>()(
  "t3/pipeline/ColdVerifySession/VerifierOpener",
) {}

/** A round that ran, or a reason it never started. No network and no model live here. */
export type ColdVerifyAttempt =
  | { readonly kind: "output"; readonly output: ColdVerifyModelOutput }
  | { readonly kind: "not-started"; readonly detail: string }
  | { readonly kind: "waiting" };

export interface ColdVerifyDecision {
  readonly note: PipelineRunNote;
  readonly status: CommitStatusWrite | undefined;
  readonly rounds: number;
}

const sameModel = (left: ModelSelection, right: ModelSelection): boolean =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  Equal.equals(left.options ?? {}, right.options ?? {});

const targetOf = (sha: string): CommitStatusTarget => ({
  host: STATUS_HOST,
  owner: REPOSITORY.owner,
  repo: REPOSITORY.name,
  sha,
});

const roundCount = (detail: string | null): number => {
  const matched = /第 (\d+) 轮/.exec(detail ?? "");
  const count = matched === null ? 0 : Number(matched[1]);
  return Number.isInteger(count) && count >= 0 ? count : 0;
};

/** Verifier thread stays in the detail. `thread_id` remains the author session. */
const DISPATCHED = /^已派第 (\d+) 轮 (\S+)$/;

const dispatchedRound = (
  detail: string | null,
): { readonly round: number; readonly threadId: string } | undefined => {
  const matched = DISPATCHED.exec(detail ?? "");
  if (matched === null) return undefined;
  const round = Number(matched[1]);
  return Number.isInteger(round) ? { round, threadId: matched[2]! } : undefined;
};

const stick = (reason: "没配模型" | "冷验收不过" | "交人", detail: string): PipelineRunNote => ({
  status: "stuck",
  stuckReason: reason,
  detail,
});
const decided = (
  note: PipelineRunNote,
  rounds: number,
  status?: CommitStatusWrite,
): ColdVerifyDecision => ({ note, status, rounds });

/**
 * Decide one verify run from attempts a caller already has. Calls the landed verdict as-is.
 * A pass writes success only for the sha given here. A write that misses that sha stays verify.
 */
export const decideColdVerify = Effect.fn("ColdVerifySession.decide")(function* (
  input: {
    readonly sha: string;
    readonly priorRounds: number;
    readonly attempts: ReadonlyArray<ColdVerifyAttempt>;
    readonly suggestions: ReadonlyArray<string>;
  },
  write: (
    outcome: ReturnType<typeof judgeColdVerify>,
  ) => Effect.Effect<CommitStatusWrite, CommitStatusWriteError>,
) {
  let rounds = input.priorRounds;
  const suggestions = [...input.suggestions];
  for (const attempt of input.attempts) {
    if (attempt.kind === "waiting") {
      return decided(
        {
          status: "verify",
          detail: rounds === 0 ? null : `第 ${rounds} 轮后等资源，仍待验`,
        },
        rounds,
      );
    }
    if (attempt.kind === "not-started") {
      return decided(stick(STUCK_COLD_VERIFY, `没跑起来：${attempt.detail}`), rounds);
    }
    rounds += 1;
    const outcome = judgeColdVerify(attempt.output);
    if (outcome.kind === "pass") {
      const written = yield* write(outcome);
      if (written.sha !== input.sha || written.state !== "success") {
        return decided(
          { status: "verify", detail: `第 ${rounds} 轮过了，但状态没写到当前 head` },
          rounds,
        );
      }
      const kept = [...suggestions, ...outcome.suggestions];
      return decided(
        {
          status: "verify",
          detail:
            kept.length === 0
              ? `第 ${rounds} 轮过了，建议留在运行上`
              : `第 ${rounds} 轮过了，建议：${kept.join("；")}`,
        },
        rounds,
        written,
      );
    }
    if (outcome.kind === "handover") {
      return decided(
        stick(STUCK_HANDOVER, `第 ${rounds} 轮判不了：${outcome.handovers.join("；")}`),
        rounds,
      );
    }
    if (outcome.kind === "block") suggestions.push(...outcome.suggestions);
    if (rounds >= MAX_ROUNDS) {
      return decided(
        stick(
          STUCK_COLD_VERIFY,
          outcome.kind === "block"
            ? `第 ${rounds} 轮仍不过：${outcome.problems[0] ?? "有能挡的问题"}`
            : `第 ${rounds} 轮仍没验成`,
        ),
        rounds,
      );
    }
  }
  return decided(
    { status: "verify", detail: rounds === 0 ? null : `第 ${rounds} 轮不过，仍待验` },
    rounds,
  );
});

const verifierRefused = (
  verifier: ModelSelection | null,
  author: ModelSelection | null,
): string | undefined => {
  if (verifier === null) return "验单模型是空的";
  if (author !== null && sameModel(verifier, author)) return "验单模型跟写单模型相同";
  return undefined;
};

const EMPTY_OUTPUT: ColdVerifyModelOutput = {
  verdict: null,
  problems: [],
  suggestions: [],
  handovers: [],
};

/** The last assistant message is the round's conclusion. Unreadable text is an empty round. */
export const conclusionOf = (
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): Effect.Effect<ColdVerifyModelOutput | undefined> => {
  const text = [...messages].reverse().find((message) => message.role === "assistant")?.text;
  if (text === undefined) return Effect.void.pipe(Effect.as(undefined));
  return decodeModelOutput(text).pipe(Effect.orElseSucceed(() => EMPTY_OUTPUT));
};

interface ColdVerifySessionShape {
  readonly tick: Effect.Effect<
    void,
    | PipelineRunsError
    | ProjectService.ProjectOperationError
    | ProjectionStore.ProjectionStoreV2Error
    | Schema.SchemaError
    | ServerSettingsError
    | CommitStatusWriteError
    | SqlError.SqlError
  >;
}

const matchesRepository = (owner: string | undefined, name: string | undefined): boolean =>
  owner === REPOSITORY.owner && name === REPOSITORY.name;

const verifyBriefing = (run: {
  readonly repository: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly prNumber: number | null;
  readonly headSha: string;
}): string => {
  const pullRequest = run.prNumber === null ? "PR 号还没有" : `PR #${run.prNumber}`;
  return `仓 ${run.repository}。任务 #${run.issueNumber} ${run.title}。任务号不是 PR 号。${pullRequest}。只核对 head ${run.headSha} 相对该 PR 基线分支的 diff、改了哪些文件、怎么算做完、PR 正文。别的 head 不算。结论用 JSON：verdict、problems、suggestions、handovers。`;
};

const make = Effect.gen(function* () {
  const runs = yield* PipelineRuns;
  const settings = yield* ServerSettings.ServerSettingsService;
  const statuses = yield* GitHubCommitStatus;
  const projects = yield* ProjectService.ProjectService;
  const opener = yield* VerifierOpener;
  const inbox = yield* SessionEndInbox;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const verifyRuns = Effect.fn("ColdVerifySession.verifyRuns")(function* () {
    const listed = yield* runs.list;
    return yield* decodeVerifyRuns(
      listed.runs.flatMap((run) =>
        run.repository === REPOSITORY_NAME && run.status === "verify" && run.headSha !== null
          ? [
              {
                id: run.id,
                repository: run.repository,
                issueNumber: run.issueNumber,
                title: run.title,
                prNumber: run.prNumber,
                threadId: run.threadId,
                headSha: run.headSha,
                detail: run.detail,
              },
            ]
          : [],
      ),
    );
  });

  const projectForRepository = Effect.fn("ColdVerifySession.projectForRepository")(function* () {
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

  const tick = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    if (!current.pipelineEnabled) return;
    const pending = yield* verifyRuns();
    const refused = verifierRefused(current.pipelineVerifierModel, current.pipelineAuthorModel);
    const ends = yield* inbox.list;
    const endByThread = new Map(ends.map((entry) => [entry.threadId, entry]));
    const listed = yield* runs.list;
    const authorOpen = listed.runs.filter(
      (run) => run.repository === REPOSITORY_NAME && run.status === "session",
    ).length;
    const inFlight = pending.filter((run) => {
      const dispatched = dispatchedRound(run.detail);
      if (dispatched === undefined) return false;
      return !endByThread.has(ThreadId.make(dispatched.threadId));
    }).length;
    let occupied = authorOpen + inFlight;

    for (const run of pending) {
      if (refused !== undefined || current.pipelineVerifierModel === null) {
        yield* runs.note(run.issueNumber, stick(STUCK_NO_MODEL, refused ?? "验单模型是空的"));
        continue;
      }
      const prior = roundCount(run.detail);
      const dispatched = dispatchedRound(run.detail);
      if (dispatched !== undefined) {
        const ended = endByThread.get(ThreadId.make(dispatched.threadId));
        if (ended === undefined) continue;
        const attempt: ColdVerifyAttempt =
          ended.status === "completed"
            ? yield* projections
                .getThreadSnapshot(ThreadId.make(dispatched.threadId))
                .pipe(
                  Effect.flatMap((snapshot) =>
                    conclusionOf(snapshot.projection.messages).pipe(
                      Effect.map((output) =>
                        output === undefined
                          ? ({ kind: "not-started", detail: "会话结束但没有结论" } as const)
                          : ({ kind: "output", output } as const),
                      ),
                    ),
                  ),
                )
            : { kind: "not-started", detail: `会话终态 ${ended.status}` };
        const decision = yield* decideColdVerify(
          {
            sha: run.headSha,
            priorRounds: dispatched.round - 1,
            attempts: [attempt],
            suggestions: [],
          },
          (outcome) => statuses.writeColdVerify(targetOf(run.headSha), outcome),
        );
        const status = decision.note.status ?? "verify";
        yield* runs.note(run.issueNumber, {
          status,
          stuckReason: decision.note.stuckReason ?? null,
          detail: decision.note.detail ?? null,
        });
        continue;
      }
      if (prior >= MAX_ROUNDS) continue;
      if (occupied >= MAX_OPEN_SESSIONS) {
        const decision = yield* decideColdVerify(
          {
            sha: run.headSha,
            priorRounds: prior,
            attempts: [{ kind: "waiting" }],
            suggestions: [],
          },
          () => Effect.die("等资源不写状态"),
        );
        yield* runs.note(run.issueNumber, decision.note);
        continue;
      }
      const project = yield* projectForRepository();
      if (project === undefined) {
        yield* runs.note(
          run.issueNumber,
          stick(STUCK_COLD_VERIFY, "没跑起来：no project for this repository"),
        );
        continue;
      }
      const next = prior + 1;
      const threadId = ThreadId.make(`pipeline:verify:${run.issueNumber}:${run.id}:${next}`);
      const opened = yield* opener
        .open({
          threadId,
          projectId: project.id,
          modelSelection: current.pipelineVerifierModel,
          text: verifyBriefing(run),
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(opened)) {
        yield* runs.note(
          run.issueNumber,
          stick(STUCK_COLD_VERIFY, "没跑起来：session was not opened"),
        );
        continue;
      }
      yield* runs.note(run.issueNumber, {
        status: "verify",
        detail: `已派第 ${next} 轮 ${threadId}`,
      });
      occupied += 1;
    }
  }).pipe(Effect.withSpan("ColdVerifySession.tick"));

  return { tick };
});

export class ColdVerifySession extends Context.Service<ColdVerifySession, ColdVerifySessionShape>()(
  "t3/pipeline/ColdVerifySession",
) {}

const liveOpener = Layer.effect(
  VerifierOpener,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const open = Effect.fn("ColdVerifySession.open")(function* (request: ColdVerifyRequest) {
      const create: OrchestrationV2Command = {
        type: "thread.create",
        commandId: CommandId.make(`pipeline:verify:create:${request.threadId}`),
        threadId: request.threadId,
        projectId: request.projectId,
        title: request.threadId,
        modelSelection: request.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      };
      yield* orchestrator.dispatch(create);
      const message: OrchestrationV2Command = {
        type: "message.dispatch",
        commandId: CommandId.make(`pipeline:verify:message:${request.threadId}`),
        threadId: request.threadId,
        messageId: MessageId.make(`pipeline:verify:message:${request.threadId}`),
        text: request.text,
        attachments: [],
        modelSelection: request.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "system",
        creationSource: "server",
      };
      yield* orchestrator.dispatch(message);
    });
    return VerifierOpener.of({ open });
  }),
);

export const layer = Layer.effect(ColdVerifySession, make);

export const layerLive = layer.pipe(
  Layer.provide(liveOpener),
  Layer.provideMerge(commitStatusLayer.pipe(Layer.provide(GitHubRest.layerWithDependencies))),
  Layer.provideMerge(ProjectionStore.layer),
);

const TICK_INTERVAL = Duration.minutes(5);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const session = yield* ColdVerifySession;
    yield* forkParked(
      session.tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pipeline.cold-verify.tick-failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
      ),
    );
  }),
);
