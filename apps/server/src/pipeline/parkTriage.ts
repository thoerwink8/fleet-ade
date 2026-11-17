import {
  PipelineRunsError,
  ServerSettingsError,
  type PipelineRun,
  type PipelineStuckReason,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { REPOSITORY } from "./GitHubIssues.ts";
import { PipelineRuns } from "./PipelineRuns.ts";

const REPOSITORY_NAME = `${REPOSITORY.owner}/${REPOSITORY.name}`;

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
  readonly issueNumber: number;
  readonly title: string;
  readonly stuckReason: PipelineStuckReason;
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

/** 模型有没有由调用方传入，这里不读选路设置。 */
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
  }) => Effect.Effect<ParkTriageReport, PipelineRunsError | ServerSettingsError>;
}

export class ParkTriage extends Context.Service<ParkTriage, ParkTriageShape>()(
  "t3/pipeline/parkTriage",
) {}

type Marker =
  | { readonly kind: "done"; readonly since: string }
  | { readonly kind: "unstarted"; readonly tries: number; readonly since: string }
  | { readonly kind: "no-model"; readonly since: string };

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
  if (detail.startsWith("没配模型 ")) return { kind: "no-model", since };
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

  const keepStuck = Effect.fn("ParkTriage.keepStuck")(function* (run: PipelineRun, detail: string) {
    if (run.stuckReason === null) return;
    yield* runs.note(run.issueNumber, {
      status: "stuck",
      stuckReason: run.stuckReason,
      detail,
    });
  });

  const handOver = Effect.fn("ParkTriage.handOver")(function* (run: PipelineRun, since: string) {
    yield* runs.note(run.issueNumber, {
      status: "stuck",
      stuckReason: "交人",
      detail: `已交指挥官 ${since}`,
    });
  });

  const resume = Effect.fn("ParkTriage.resume")(function* (run: PipelineRun) {
    yield* runs.note(run.issueNumber, {
      status: "claimed",
      stuckReason: null,
      threadId: null,
      sessionStartedAt: null,
      sessionEndedAt: null,
      detail: null,
    });
  });

  const triage = Effect.fn("ParkTriage.triage")(function* (input: {
    readonly modelConfigured: boolean;
  }) {
    const lines: Array<string> = [];
    const labelActions: Array<LabelAction> = [];
    let requests = 0;
    if (!(yield* settings.getSettings).pipelineEnabled) {
      return { lines, requests, labelActions };
    }
    const nowMs = Date.parse(DateTime.formatIso(yield* DateTime.now));
    const active = new Map<number, PipelineRun>();
    for (const run of (yield* runs.list).runs) {
      if (run.repository !== REPOSITORY_NAME || closedOut(run) || active.has(run.issueNumber)) {
        continue;
      }
      active.set(run.issueNumber, run);
    }

    for (const run of active.values()) {
      if (run.status !== "stuck" || run.stuckReason === null) continue;
      const marker = parseMarker(run.detail);
      if (marker?.kind === "done") continue;
      const since = marker?.since ?? run.updatedAt;
      const age = nowMs - Date.parse(since);
      if (!Number.isFinite(age) || age < AFTER_MS) {
        lines.push(`#${run.issueNumber} 停下未满 15 分钟不产生裁决请求`);
        continue;
      }
      if (awaitingRenew(run)) {
        lines.push(`#${run.issueNumber} 还在续一次集合里，不产生裁决请求`);
        continue;
      }
      if (!input.modelConfigured) {
        const detail = `没配模型 ${since}`;
        if (marker?.kind !== "unstarted" && run.detail !== detail) {
          yield* keepStuck(run, detail);
        }
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
          issueNumber: run.issueNumber,
          title: run.title,
          stuckReason: run.stuckReason,
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
        labelActions.push({ issueNumber: run.issueNumber, label: LOCAL_LABEL });
        yield* keepStuck(run, `已交指挥官·贴本机做 ${since}`);
        lines.push(`#${run.issueNumber} 裁决是贴本机做，标签动作 本机做，不再派`);
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
