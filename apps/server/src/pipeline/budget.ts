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
import { PIPELINE_HOST, REPOSITORY } from "./GitHubIssues.ts";
import { PipelineRuns } from "./PipelineRuns.ts";

const REPOSITORY_NAME = `${REPOSITORY.owner}/${REPOSITORY.name}`;
const UNREAD = "没查成";
const RENEWED = "已续一次";
const OVER_BUDGET: PipelineStuckReason = "超预算";

/** Session failure, a red check, and a timeout share one retry. Anything else stays stuck. */
const RENEWABLE: ReadonlySet<PipelineStuckReason> = new Set(["会话失败", "检查红", "超时"]);

const TICK_INTERVAL = Duration.minutes(5);

const PullBody = Schema.Struct({
  additions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const decodePull = Schema.decodeUnknownEffect(Schema.fromJsonString(PullBody));

export class PullRequestAdditionsUnreadable extends Schema.TaggedError<PullRequestAdditionsUnreadable>()(
  "PullRequestAdditionsUnreadable",
  {},
) {
  override get message(): string {
    return UNREAD;
  }
}

/** Added lines on one pull request. A failed read is not zero and not over budget. */
export class PullRequestAdditions extends Context.Service<
  PullRequestAdditions,
  {
    readonly read: (input: {
      readonly number: number;
    }) => Effect.Effect<number, PullRequestAdditionsUnreadable>;
  }
>()("t3/pipeline/budget/PullRequestAdditions") {}

export interface StuckProposal {
  readonly reason: PipelineStuckReason;
  readonly detail?: string | null;
  readonly sessionEndedAt?: string | null;
}

interface PipelineBudgetShape {
  readonly tick: Effect.Effect<void, PipelineRunsError | ServerSettingsError>;
  readonly review: (
    run: PipelineRun,
  ) => Effect.Effect<"pass" | "hold" | "over", ServerSettingsError>;
  readonly settle: (
    issueNumber: number,
    proposed: StuckProposal,
    repository?: string,
  ) => Effect.Effect<void, PipelineRunsError | ServerSettingsError>;
}

export class PipelineBudget extends Context.Service<PipelineBudget, PipelineBudgetShape>()(
  "t3/pipeline/budget/PipelineBudget",
) {}

/** Recorded input tokens once the session window is closed. Missing numbers are not zero. */
const recordedInput = (run: PipelineRun): "pending" | "unread" | number => {
  if (run.sessionStartedAt === null || run.sessionEndedAt === null) return "pending";
  if (run.usageNote !== null || run.inputTokens === null) return "unread";
  return run.inputTokens;
};

const makeReader = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;
  const slug = `${encodeURIComponent(REPOSITORY.owner)}/${encodeURIComponent(REPOSITORY.name)}`;
  const read = Effect.fn("PipelineBudget.readAdditions")(function* (input: {
    readonly number: number;
  }) {
    const response = yield* rest
      .rest({
        host: PIPELINE_HOST,
        operation: "pipelineBudgetPull",
        path: `repos/${slug}/pulls/${input.number}`,
      })
      .pipe(Effect.mapError(() => new PullRequestAdditionsUnreadable()));
    if (response.status < 200 || response.status >= 300 || response.truncated) {
      return yield* new PullRequestAdditionsUnreadable();
    }
    const pull = yield* decodePull(response.body).pipe(
      Effect.mapError(() => new PullRequestAdditionsUnreadable()),
    );
    return pull.additions;
  });
  return PullRequestAdditions.of({ read });
});

const layerAdditions = Layer.effect(PullRequestAdditions, makeReader);

const make = Effect.gen(function* () {
  const runs = yield* PipelineRuns;
  const settings = yield* ServerSettings.ServerSettingsService;
  const additions = yield* PullRequestAdditions;

  const limits = Effect.fn("PipelineBudget.limits")(function* () {
    const current = yield* settings.getSettings;
    return {
      enabled: current.pipelineEnabled,
      tokens: current.pipelineTokenInputEquivalent,
      lines: current.pipelinePullRequestAddedLines,
    };
  });

  const review = Effect.fn("PipelineBudget.review")(function* (run: PipelineRun) {
    const current = yield* limits();
    const input = recordedInput(run);
    if (input === "unread") return "hold" as const;
    if (typeof input === "number" && input > current.tokens) return "over" as const;
    if (run.prNumber === null) return "pass" as const;
    const read = yield* additions.read({ number: run.prNumber }).pipe(Effect.exit);
    if (Exit.isFailure(read)) return "hold" as const;
    return read.value > current.lines ? ("over" as const) : ("pass" as const);
  });

  const load = Effect.fn("PipelineBudget.load")(function* (
    issueNumber: number,
    repository?: string,
  ) {
    const repositoryName = repository ?? REPOSITORY_NAME;
    return (yield* runs.list).runs.find(
      (run) => run.repository === repositoryName && run.issueNumber === issueNumber,
    );
  });

  const settle = Effect.fn("PipelineBudget.settle")(function* (
    issueNumber: number,
    proposed: StuckProposal,
    repository?: string,
  ) {
    const repositoryName = repository ?? REPOSITORY_NAME;
    let current = yield* load(issueNumber, repositoryName);
    if (current === undefined) {
      return yield* new PipelineRunsError({ cause: `no run for issue ${issueNumber}` });
    }
    const closeWindow =
      RENEWABLE.has(proposed.reason) &&
      proposed.sessionEndedAt != null &&
      current.sessionStartedAt !== null &&
      current.sessionEndedAt !== proposed.sessionEndedAt;
    if (closeWindow) {
      yield* runs.note(issueNumber, { sessionEndedAt: proposed.sessionEndedAt }, repository);
      current = (yield* load(issueNumber, repository)) ?? current;
    }
    if ((yield* review(current)) === "over") {
      yield* runs.note(
        issueNumber,
        {
          status: "stuck",
          stuckReason: OVER_BUDGET,
          detail: null,
          ...(proposed.sessionEndedAt != null ? { sessionEndedAt: proposed.sessionEndedAt } : {}),
        },
        repository,
      );
      return;
    }
    if (!current.renewedOnce && RENEWABLE.has(proposed.reason)) {
      yield* runs.note(
        issueNumber,
        {
          status: "claimed",
          stuckReason: null,
          threadId: null,
          sessionStartedAt: null,
          sessionEndedAt: null,
          detail: RENEWED,
          renewedOnce: true,
        },
        repository,
      );
      return;
    }
    yield* runs.note(
      issueNumber,
      {
        status: "stuck",
        stuckReason: proposed.reason,
        ...(proposed.detail !== undefined ? { detail: proposed.detail } : {}),
        ...(proposed.sessionEndedAt !== undefined
          ? { sessionEndedAt: proposed.sessionEndedAt }
          : {}),
      },
      repository,
    );
  });

  const tick = Effect.gen(function* () {
    if (!(yield* limits()).enabled) return;
    for (const run of (yield* runs.list).runs) {
      if (run.repository !== REPOSITORY_NAME || run.status === "merged") continue;
      if (run.status === "stuck" && run.stuckReason !== null && RENEWABLE.has(run.stuckReason)) {
        yield* settle(run.issueNumber, {
          reason: run.stuckReason,
          detail: run.detail,
          sessionEndedAt: run.sessionEndedAt,
        });
        continue;
      }
      if (run.status === "stuck") continue;
      const verdict = yield* review(run);
      if (verdict === "over") {
        yield* runs.note(run.issueNumber, {
          status: "stuck",
          stuckReason: OVER_BUDGET,
          detail: null,
        });
        continue;
      }
      if (verdict === "hold" && run.detail !== UNREAD) {
        yield* runs.note(run.issueNumber, { detail: UNREAD });
      }
    }
  }).pipe(Effect.withSpan("PipelineBudget.tick"));

  return PipelineBudget.of({ tick, review, settle });
});

export const layer = Layer.effect(PipelineBudget, make);

export const layerLive = layer.pipe(
  Layer.provide(layerAdditions),
  Layer.provide(GitHubRest.layerWithDependencies),
);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const budget = yield* PipelineBudget;
    yield* forkParked(
      budget.tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pipeline.budget.tick-failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
      ),
    );
  }),
);
