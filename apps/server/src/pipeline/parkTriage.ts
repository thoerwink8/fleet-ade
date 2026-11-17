import {
  PIPELINE_STUCK_REASONS,
  CommandId,
  MessageId,
  PipelineRunsError,
  ServerSettingsError,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2RunStatus,
  type PipelineRun,
  type PipelineStuckReason,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PipelineGitHubIssues } from "./GitHubIssues.ts";
import { PipelineRuns } from "./PipelineRuns.ts";
import { parseRepo } from "./repoAllowlist.ts";
import { STUCK_NO_MODEL, orderedCandidates, pickRouteCandidate } from "./routeCandidates.ts";

/** #10 的续一次集合。成员不在这里改。 */
export const RENEW_ONCE_REASONS = ["会话失败", "检查红", "超时"] as const;
const RENEW_ONCE: ReadonlySet<string> = new Set(RENEW_ONCE_REASONS);

export const PARK_TRIAGE_AFTER_MINUTES = 15;
const AFTER_MS = PARK_TRIAGE_AFTER_MINUTES * 60_000;
const SESSION_TRIES = 3;

const HUMAN_CATEGORIES = ["要掏新钱", "删了找不回又没备份", "改标准"] as const;
type HumanCategory = (typeof HUMAN_CATEGORIES)[number];
const LOCAL_LABEL = "本机做";

export interface CommanderRequest {
  readonly repository: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly stuckReason: PipelineStuckReason;
  readonly detail: string | null;
  readonly model: ModelSelection | null;
}

export interface CommanderVerdict {
  readonly action: string;
  readonly category: string | null;
}

export type CommanderSessionResult =
  | { readonly started: false }
  | { readonly started: true; readonly verdict: CommanderVerdict | null };

export interface CommanderSessionOpenerShape {
  readonly open: (input: CommanderRequest) => Effect.Effect<CommanderSessionResult>;
}

/** 选哪个模型由调用方传入，这里不读候选串。 */
export class CommanderSessionOpener extends Context.Service<
  CommanderSessionOpener,
  CommanderSessionOpenerShape
>()("t3/pipeline/parkTriage/CommanderSessionOpener") {}

export interface LabelAction {
  readonly issueNumber: number;
  readonly label: typeof LOCAL_LABEL;
}

export interface ParkTriageReport {
  readonly lines: ReadonlyArray<string>;
  readonly requests: number;
  readonly labelActions: ReadonlyArray<LabelAction>;
}

interface ParkTriageShape {
  readonly triage: (input: {
    readonly modelConfigured: boolean;
    readonly model?: ModelSelection | null;
  }) => Effect.Effect<ParkTriageReport, PipelineRunsError | ServerSettingsError>;
}

export class ParkTriage extends Context.Service<ParkTriage, ParkTriageShape>()(
  "t3/pipeline/parkTriage",
) {}

type Marker =
  | { readonly kind: "done"; readonly since: string }
  | { readonly kind: "unstarted"; readonly tries: number; readonly since: string }
  | { readonly kind: "label-pending"; readonly since: string }
  | {
      readonly kind: "no-model";
      readonly since: string;
      readonly original: typeof OriginalContext.Type;
    };

const OriginalContext = Schema.Struct({
  stuckReason: Schema.Literals(PIPELINE_STUCK_REASONS),
  detail: Schema.NullOr(Schema.String),
});
const decodeOriginalContext = Schema.decodeUnknownOption(Schema.fromJsonString(OriginalContext));
const encodeOriginalContext = Schema.encodeSync(Schema.fromJsonString(OriginalContext));

const isHumanCategory = (value: string): value is HumanCategory =>
  (HUMAN_CATEGORIES as ReadonlyArray<string>).includes(value);

const parseMarker = (detail: string | null): Marker | null => {
  if (detail === null) return null;
  const since = detail.split(" ").at(-1);
  if (since === undefined || !Number.isFinite(Date.parse(since))) return null;
  if (detail.startsWith("已交指挥官")) return { kind: "done", since };
  const unstarted = /^指挥官会话没起成 (\d+) /.exec(detail);
  if (unstarted?.[1] !== undefined) {
    const tries = Number(unstarted[1]);
    return Number.isInteger(tries) ? { kind: "unstarted", tries, since } : null;
  }
  if (detail.startsWith("贴本机做待重试 ")) return { kind: "label-pending", since };
  if (detail.startsWith("没配模型 ")) {
    const original = decodeOriginalContext(
      detail.slice("没配模型 ".length, detail.lastIndexOf(" ")),
    );
    if (Option.isSome(original)) return { kind: "no-model", since, original: original.value };
  }
  return null;
};

const awaitingRenew = (run: PipelineRun): boolean =>
  run.stuckReason !== null && RENEW_ONCE.has(run.stuckReason) && !run.renewedOnce;

/** 人取消的运行已经结案；note 会改到另一条还开着的运行上。 */
const closedOut = (run: PipelineRun): boolean =>
  run.status === "merged" || (run.status === "stuck" && run.stuckReason === "取消");

type Allowed =
  | { readonly kind: "continue" }
  | { readonly kind: "label" }
  | { readonly kind: "handover"; readonly category: HumanCategory }
  | { readonly kind: "reject" };

const allow = (verdict: CommanderVerdict | null): Allowed => {
  if (verdict === null) return { kind: "reject" };
  const action = verdict.action.trim();
  if (action === "继续") return { kind: "continue" };
  if (action === "贴本机做") return { kind: "label" };
  const category = verdict.category?.trim() ?? "";
  if (action === "交人" && isHumanCategory(category)) return { kind: "handover", category };
  return { kind: "reject" };
};

const make = Effect.gen(function* () {
  const runs = yield* PipelineRuns;
  const settings = yield* ServerSettings.ServerSettingsService;
  const opener = yield* CommanderSessionOpener;
  const issues = yield* PipelineGitHubIssues;

  const keepStuck = Effect.fn("ParkTriage.keepStuck")(function* (run: PipelineRun, detail: string) {
    if (run.stuckReason === null) return;
    yield* runs.note(
      run.issueNumber,
      {
        status: "stuck",
        stuckReason: run.stuckReason,
        detail,
      },
      run.repository,
    );
  });

  const handOver = Effect.fn("ParkTriage.handOver")(function* (run: PipelineRun, since: string) {
    yield* runs.note(
      run.issueNumber,
      {
        status: "stuck",
        stuckReason: "交人",
        detail: `已交指挥官 ${since}`,
      },
      run.repository,
    );
  });

  const resume = Effect.fn("ParkTriage.resume")(function* (run: PipelineRun) {
    yield* runs.note(
      run.issueNumber,
      {
        status: "claimed",
        stuckReason: null,
        threadId: null,
        sessionStartedAt: null,
        sessionEndedAt: null,
        detail: null,
      },
      run.repository,
    );
  });

  const applyLocalLabel = Effect.fn("ParkTriage.applyLocalLabel")(function* (
    run: PipelineRun,
    since: string,
  ) {
    const repo = parseRepo(run.repository);
    if (repo === undefined) return false;
    const written = yield* issues.addLabel(run.issueNumber, LOCAL_LABEL, repo).pipe(Effect.exit);
    if (Exit.isFailure(written)) {
      yield* Effect.logWarning("pipeline.park-triage.label-failed", {
        issueNumber: run.issueNumber,
        cause: Cause.pretty(written.cause),
      });
      return false;
    }
    yield* keepStuck(run, `已交指挥官·贴本机做 ${since}`);
    return true;
  });

  const triage = Effect.fn("ParkTriage.triage")(function* (input: {
    readonly modelConfigured: boolean;
    readonly model?: ModelSelection | null;
  }) {
    const lines: Array<string> = [];
    const labelActions: Array<LabelAction> = [];
    let requests = 0;
    if (!(yield* settings.getSettings).pipelineEnabled) {
      return { lines, requests, labelActions };
    }
    const nowMs = Date.parse(DateTime.formatIso(yield* DateTime.now));
    const active = new Map<string, PipelineRun>();
    for (const run of (yield* runs.list).runs) {
      if (closedOut(run) || active.has(`${run.repository}#${run.issueNumber}`)) {
        continue;
      }
      active.set(`${run.repository}#${run.issueNumber}`, run);
    }

    for (let run of active.values()) {
      if (run.status !== "stuck" || run.stuckReason === null) continue;
      let marker = parseMarker(run.detail);
      if (marker?.kind === "done") continue;
      const since = marker?.since ?? run.updatedAt;
      const age = nowMs - Date.parse(since);
      if (!Number.isFinite(age) || age < AFTER_MS) {
        lines.push(`#${run.issueNumber} 停下未满 15 分钟不产生裁决请求`);
        continue;
      }
      if (marker?.kind === "label-pending") {
        if (yield* applyLocalLabel(run, since)) {
          labelActions.push({ issueNumber: run.issueNumber, label: LOCAL_LABEL });
          lines.push(`#${run.issueNumber} 已贴本机做，不再派`);
        } else {
          lines.push(`#${run.issueNumber} 本机做标签没写成，保留待重试，不算已处理`);
        }
        continue;
      }
      if (marker?.kind === "no-model") {
        if (!input.modelConfigured) {
          lines.push(`#${run.issueNumber} 没配模型，不算已处理`);
          continue;
        }
        yield* runs.note(run.issueNumber, marker.original, run.repository);
        run = { ...run, ...marker.original };
        marker = parseMarker(run.detail);
      }
      if (run.stuckReason === null) continue;
      if (awaitingRenew(run)) {
        lines.push(`#${run.issueNumber} 还在续一次集合里，不产生裁决请求`);
        continue;
      }
      if (!input.modelConfigured) {
        const detail = `没配模型 ${encodeOriginalContext({ stuckReason: run.stuckReason, detail: run.detail })} ${since}`;
        yield* runs.note(
          run.issueNumber,
          {
            status: "stuck",
            stuckReason: STUCK_NO_MODEL,
            detail,
          },
          run.repository,
        );
        lines.push(`#${run.issueNumber} 没配模型，不算已处理`);
        continue;
      }
      const tries = marker?.kind === "unstarted" ? marker.tries : 0;
      if (tries >= SESSION_TRIES - 1) {
        yield* handOver(run, since);
        lines.push(`#${run.issueNumber} 第三次没起成执行默认动作，不再请求会话`);
        continue;
      }
      requests += 1;
      const outside = !RENEW_ONCE.has(run.stuckReason);
      lines.push(
        outside
          ? `#${run.issueNumber} 已满 15 分钟、且不在续一次集合里，产生一次裁决请求`
          : `#${run.issueNumber} 已满 15 分钟、续一次没解开，产生一次裁决请求`,
      );
      const opened = yield* opener
        .open({
          repository: run.repository,
          issueNumber: run.issueNumber,
          title: run.title,
          stuckReason: run.stuckReason,
          detail: run.detail,
          model: input.model ?? null,
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(opened) || opened.value.started === false) {
        const next = tries + 1;
        yield* keepStuck(run, `指挥官会话没起成 ${next} ${since}`);
        lines.push(`#${run.issueNumber} 第 ${next} 次会话没起成，不算已处理`);
        continue;
      }
      const allowed = allow(opened.value.verdict);
      if (allowed.kind === "continue") {
        yield* resume(run);
        const count = (yield* runs.list).runs.length;
        lines.push(`#${run.issueNumber} 裁决是继续，运行回到可派，运行条数仍是 ${count}`);
        continue;
      }
      if (allowed.kind === "label") {
        yield* keepStuck(run, `贴本机做待重试 ${since}`);
        if (yield* applyLocalLabel(run, since)) {
          labelActions.push({ issueNumber: run.issueNumber, label: LOCAL_LABEL });
          lines.push(`#${run.issueNumber} 裁决是贴本机做，已贴本机做，不再派`);
        } else {
          lines.push(`#${run.issueNumber} 本机做标签没写成，保留待重试，不算已处理`);
        }
        continue;
      }
      if (allowed.kind === "handover") {
        yield* handOver(run, since);
        lines.push(
          `#${run.issueNumber} 裁决是交人，类别${allowed.category}，运行保持 stuck，原因交人`,
        );
        continue;
      }
      yield* handOver(run, since);
      lines.push(
        `#${run.issueNumber} 动作不在继续、交人、贴本机做里或交人类别不是那三类，不执行该动作，改为默认动作 stuck 原因交人`,
      );
    }

    if (lines.length > 0) yield* Effect.logInfo(lines.join("\n"));
    return { lines, requests, labelActions };
  });

  return ParkTriage.of({ triage });
});

export const layer = Layer.effect(ParkTriage, make);

/** 写单候选优先，空了再用验单候选。两边都没有能用的就是没配模型。 */
const firstUsableModel = (
  author: ReadonlyArray<ModelSelection>,
  verifier: ReadonlyArray<ModelSelection>,
): ModelSelection | null => {
  for (const models of [author, verifier]) {
    const picked = pickRouteCandidate(orderedCandidates(models));
    if (picked.kind === "open-session") return picked.model;
  }
  return null;
};

export const scanParkedRuns = Effect.fn("ParkTriage.scan")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const triage = yield* ParkTriage;
  const current = yield* settings.getSettings;
  const model = firstUsableModel(current.pipelineAuthorModel, current.pipelineVerifierModel);
  return yield* triage.triage({ modelConfigured: model !== null, model });
});

const isTerminalRun = (status: OrchestrationV2RunStatus): boolean =>
  status === "completed" ||
  status === "interrupted" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "rolled_back";

/** 会话只交一份裁决。认不出就当没起成，好让同一次停下再试。 */
const verdictFromText = (text: string): CommanderVerdict | null => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as { readonly action?: unknown; readonly category?: unknown };
  if (typeof record.action !== "string" || record.action.trim() === "") return null;
  return {
    action: record.action,
    category: typeof record.category === "string" ? record.category : null,
  };
};

const commanderPrompt = (input: CommanderRequest): string =>
  [
    `单 #${input.issueNumber} ${input.title} 停下了，原因是${input.stuckReason}。${input.detail ?? ""}`,
    "你只交裁决，不改文件、不跑命令。",
    "动作只能是继续、交人、贴本机做。交人时类别只能是要掏新钱、删了找不回又没备份、改标准。",
    '最后只返回 JSON：{"action":"继续","category":null}',
  ].join("");

const COMMANDER_WAIT = Duration.minutes(20);

const NOT_STARTED: CommanderSessionResult = { started: false };

const heard = (verdict: CommanderVerdict): CommanderSessionResult => ({
  started: true,
  verdict,
});

const liveOpener = Layer.effect(
  CommanderSessionOpener,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectService.ProjectService;
    const random = yield* SecureRandom.SecureRandom;

    const projectIdForRepository = Effect.fn("ParkTriage.project")(function* (repository: string) {
      const parsed = parseRepo(repository);
      if (parsed === undefined) return undefined;
      let cursor = 0;
      for (;;) {
        const page = yield* projects.listPage({ cursor, limit: 50 });
        const match = page.projects.find(
          (project) =>
            project.repositoryIdentity !== null &&
            project.repositoryIdentity !== undefined &&
            project.repositoryIdentity.owner === parsed.owner &&
            project.repositoryIdentity.name === parsed.name,
        );
        if (match !== undefined) return match.id;
        if (page.nextCursor === null) return undefined;
        cursor = page.nextCursor;
      }
    });

    const readVerdict = Effect.fn("ParkTriage.readVerdict")(function* (threadId: ThreadId) {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs.findLast((item) => isTerminalRun(item.status));
      if (run === undefined) return undefined;
      if (run.status !== "completed") return NOT_STARTED;
      const text = projection.messages.findLast(
        (message) => message.role === "assistant" && !message.streaming,
      )?.text;
      if (text === undefined) return NOT_STARTED;
      const verdict = verdictFromText(text);
      if (verdict === null) return NOT_STARTED;
      return heard(verdict);
    });

    const openSession = Effect.fn("ParkTriage.open")(function* (input: CommanderRequest) {
      if (input.model === null) return NOT_STARTED;
      const projectId = yield* projectIdForRepository(input.repository);
      if (projectId === undefined) return NOT_STARTED;
      const threadId = ThreadId.make(
        `pipeline:commander:${encodeURIComponent(input.repository)}:${input.issueNumber}:${yield* random.uuidV4()}`,
      );
      const watched = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "run.updated" &&
            event.payload.threadId === threadId &&
            isTerminalRun(event.payload.status),
        ),
        Stream.take(1),
        Stream.runHead,
        Effect.forkScoped,
      );
      const started = yield* dispatchCommander(orchestrator, projectId, threadId, input).pipe(
        Effect.exit,
      );
      if (Exit.isFailure(started)) {
        yield* Fiber.interrupt(watched);
        return NOT_STARTED;
      }
      const already = yield* readVerdict(threadId).pipe(Effect.exit);
      const read = Exit.isSuccess(already) ? already.value : undefined;
      if (read !== undefined) {
        yield* Fiber.interrupt(watched);
        return read;
      }
      yield* Fiber.join(watched).pipe(Effect.timeout(COMMANDER_WAIT), Effect.ignore);
      const later = yield* readVerdict(threadId).pipe(Effect.exit);
      const settled = Exit.isSuccess(later) ? later.value : undefined;
      if (settled !== undefined) return settled;
      return NOT_STARTED;
    });

    const open = Effect.fn("CommanderSessionOpener.open")(function* (input: CommanderRequest) {
      return yield* openSession(input).pipe(
        Effect.scoped,
        Effect.orElseSucceed(() => NOT_STARTED),
      );
    });

    return CommanderSessionOpener.of({ open });
  }),
);

const dispatchCommander = Effect.fn("ParkTriage.dispatch")(function* (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  projectId: ProjectId,
  threadId: ThreadId,
  input: CommanderRequest,
) {
  const model = input.model;
  if (model === null) return;
  const create: OrchestrationV2Command = {
    type: "thread.create",
    commandId: CommandId.make(`pipeline:commander:create:${threadId}`),
    threadId,
    projectId,
    title: `指挥官 #${input.issueNumber}`,
    modelSelection: model,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "system",
    creationSource: "server",
  };
  yield* orchestrator.dispatch(create);
  const message: OrchestrationV2Command = {
    type: "message.dispatch",
    commandId: CommandId.make(`pipeline:commander:message:${threadId}`),
    threadId,
    messageId: MessageId.make(`pipeline:commander:message:${threadId}`),
    text: commanderPrompt(input),
    attachments: [],
    modelSelection: model,
    dispatchMode: { type: "start_immediately" },
    createdBy: "system",
    creationSource: "server",
  };
  yield* orchestrator.dispatch(message);
});

export const layerLive = layer.pipe(Layer.provide(liveOpener));

const TICK_INTERVAL = Duration.minutes(5);

export const layerWorker = Layer.effectDiscard(
  forkParked(
    scanParkedRuns().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("pipeline.park-triage.tick-failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.repeat(Schedule.spaced(TICK_INTERVAL)),
    ),
  ),
);
