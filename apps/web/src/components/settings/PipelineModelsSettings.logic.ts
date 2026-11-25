import * as Equal from "effect/Equal";

import type { ModelSelection } from "@t3tools/contracts";
import type { ModelEsque } from "../chat/providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";

/**
 * Mirrors the server's same-model check in ColdVerifySession: a verifier pick is refused when it
 * equals the author pick. Options count, so a same-slug candidate with different effort still runs.
 */
export function samePipelineModel(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    Equal.equals(left.options ?? [], right.options ?? [])
  );
}

/** One slot per instance+model; options on a stored candidate are only edited by hand. */
function sameCandidate(left: ModelSelection, right: ModelSelection): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

export function moveCandidate(
  candidates: ReadonlyArray<ModelSelection>,
  index: number,
  direction: -1 | 1,
): ReadonlyArray<ModelSelection> {
  const target = index + direction;
  if (index < 0 || index >= candidates.length || target < 0 || target >= candidates.length) {
    return candidates;
  }
  const next = [...candidates];
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

export function appendCandidate(
  candidates: ReadonlyArray<ModelSelection>,
  selection: ModelSelection,
): ReadonlyArray<ModelSelection> {
  return candidates.some((candidate) => sameCandidate(candidate, selection))
    ? candidates
    : [...candidates, selection];
}

export function removeCandidateAt(
  candidates: ReadonlyArray<ModelSelection>,
  index: number,
): ReadonlyArray<ModelSelection> {
  return candidates.filter((_, candidate) => candidate !== index);
}

/** The picker calls this per row; a saved candidate blocks picking the same slot again. */
export function pipelineCandidateDisabledReason(
  candidates: ReadonlyArray<ModelSelection>,
  instanceId: ModelSelection["instanceId"],
  model: string,
): string | null {
  return candidates.some(
    (candidate) => candidate.instanceId === instanceId && candidate.model === model,
  )
    ? "已在候选中"
    : null;
}

/** First usable candidates collide exactly when index 0 does; the pipeline tries lists in order. */
export function verifierConflictsWithAuthor(
  author: ReadonlyArray<ModelSelection>,
  verifier: ReadonlyArray<ModelSelection>,
): boolean {
  const pickedAuthor = author[0];
  const pickedVerifier = verifier[0];
  return (
    pickedAuthor !== undefined &&
    pickedVerifier !== undefined &&
    samePipelineModel(pickedAuthor, pickedVerifier)
  );
}

export interface PipelineCandidateDisplay {
  readonly name: string;
  readonly slug: string;
  readonly unavailableReason: string | null;
}

/** Resolves what one stored candidate shows; a missing provider or model keeps the saved slug. */
export function pipelineCandidateDisplay(input: {
  readonly selection: ModelSelection;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<
    ModelSelection["instanceId"],
    ReadonlyArray<ModelEsque>
  >;
}): PipelineCandidateDisplay {
  const { selection } = input;
  const entry = input.entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const option = (input.modelOptionsByInstance.get(selection.instanceId) ?? []).find(
    (candidate) => candidate.slug === selection.model,
  );
  const unavailableReason =
    entry === undefined
      ? "这台电脑上没有这个智能体。"
      : !entry.enabled
        ? `${entry.displayName} 已关闭。`
        : !entry.isAvailable
          ? `${entry.displayName} 不可用。`
          : option === undefined || option.isUnavailable === true
            ? "此模型不可用。"
            : null;
  return {
    name: option?.name ?? selection.model,
    slug: selection.model,
    unavailableReason,
  };
}
