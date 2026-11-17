// 每段一串有序候选，读不到或用尽跳下一个（讨论稿批次 4）。状态由调用方在给定的当时给出；
// 本模块不读供应商，留状态的调用方决定什么叫读不到、什么叫用尽。
import type { ModelSelection } from "@t3tools/contracts";

export const STUCK_NO_MODEL = "没配模型";
export const STUCK_CANDIDATES_EXHAUSTED = "候选用尽";

export type CandidateAvailability = "ready" | "unreadable" | "exhausted";

export interface RouteCandidate {
  readonly model: ModelSelection;
  readonly availability: CandidateAvailability;
}

/** One ordered list per stage, taken in settings order; the list itself never reorders. */
export interface StageCandidateSettings {
  readonly author: ReadonlyArray<RouteCandidate>;
  readonly verifier: ReadonlyArray<RouteCandidate>;
}

export type StageRoutePick =
  | { readonly kind: "open-session"; readonly sessionOpened: true; readonly model: ModelSelection }
  | {
      readonly kind: "stuck";
      readonly sessionOpened: false;
      readonly reason: typeof STUCK_NO_MODEL | typeof STUCK_CANDIDATES_EXHAUSTED;
    };

/** Settings store only the ordered models; availability is caller-supplied at pick time. */
export const orderedCandidates = (
  models: ReadonlyArray<ModelSelection>,
): ReadonlyArray<RouteCandidate> => models.map((model) => ({ model, availability: "ready" }));

/** First ready candidate wins. An empty list is 没配模型; a list of skips is 候选用尽. */
export function pickRouteCandidate(candidates: ReadonlyArray<RouteCandidate>): StageRoutePick {
  const ready = candidates.find((item) => item.availability === "ready");
  if (ready === undefined) {
    return {
      kind: "stuck",
      sessionOpened: false,
      reason: candidates.length === 0 ? STUCK_NO_MODEL : STUCK_CANDIDATES_EXHAUSTED,
    };
  }
  return { kind: "open-session", sessionOpened: true, model: ready.model };
}
