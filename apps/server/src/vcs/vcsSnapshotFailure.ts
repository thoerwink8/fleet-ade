import {
  type GitCommandAction,
  GitCommandError,
  GitManagerError,
  PullRequestOperationError,
  SourceControlRepositoryError,
  TextGenerationError,
  VCS_SNAPSHOT_FAILURE_DETAIL_MAX_LENGTH,
  type VcsSnapshotFailure,
  VcsProcessExitError,
  VcsProcessSpawnError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isGitCommandError = Schema.is(GitCommandError);
const isVcsProcessSpawnError = Schema.is(VcsProcessSpawnError);
const isVcsProcessExitError = Schema.is(VcsProcessExitError);
const isGitManagerError = Schema.is(GitManagerError);
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
const isPullRequestOperationError = Schema.is(PullRequestOperationError);
const isTextGenerationError = Schema.is(TextGenerationError);

export function clampVcsSnapshotFailureDetail(detail: string): string {
  const trimmed = detail.trim();
  const text = trimmed.length > 0 ? trimmed : detail;
  if (text.length <= VCS_SNAPSHOT_FAILURE_DETAIL_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, VCS_SNAPSHOT_FAILURE_DETAIL_MAX_LENGTH - 1)}\u2026`;
}

function buildSnapshotFailure(input: {
  readonly _tag: string;
  readonly operation?: string;
  readonly action?: GitCommandAction;
  readonly reason?: string;
  readonly detail: string;
}): VcsSnapshotFailure {
  const operation = input.operation?.trim();
  const reason = input.reason?.trim();
  return {
    _tag: input._tag,
    ...(operation ? { operation } : {}),
    ...(input.action !== undefined ? { action: input.action } : {}),
    ...(reason ? { reason } : {}),
    detail: clampVcsSnapshotFailureDetail(input.detail),
  };
}

function fromDirectVcsError(
  error: unknown,
  fallbackAction?: GitCommandAction,
): VcsSnapshotFailure | undefined {
  if (isGitCommandError(error)) {
    const action = error.action ?? fallbackAction;
    return buildSnapshotFailure({
      _tag: error._tag,
      operation: error.operation,
      ...(action !== undefined ? { action } : {}),
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
      detail: error.detail,
    });
  }
  if (isVcsProcessSpawnError(error)) {
    return buildSnapshotFailure({
      _tag: error._tag,
      operation: error.operation,
      ...(fallbackAction !== undefined ? { action: fallbackAction } : {}),
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
      detail: error.message,
    });
  }
  if (isVcsProcessExitError(error)) {
    return buildSnapshotFailure({
      _tag: error._tag,
      operation: error.operation,
      ...(fallbackAction !== undefined ? { action: fallbackAction } : {}),
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
      detail: error.detail,
    });
  }
  return undefined;
}

export function toVcsSnapshotFailure(
  error: unknown,
  fallback?: { readonly action?: GitCommandAction },
): VcsSnapshotFailure | undefined {
  const directVcs = fromDirectVcsError(error, fallback?.action);
  if (directVcs !== undefined) {
    return directVcs;
  }

  if (isSourceControlRepositoryError(error)) {
    const action = error.operation === "cloneRepository" ? "clone" : fallback?.action;
    if (error.reason !== undefined) {
      return buildSnapshotFailure({
        _tag: error._tag,
        operation: error.operation,
        ...(action !== undefined ? { action } : {}),
        reason: error.reason,
        detail: error.detail,
      });
    }
    const unwrapped = fromDirectVcsError(error.cause, action);
    if (unwrapped !== undefined) {
      return buildSnapshotFailure({
        _tag: unwrapped._tag,
        ...(unwrapped.operation !== undefined ? { operation: unwrapped.operation } : {}),
        ...(unwrapped.action !== undefined
          ? { action: unwrapped.action }
          : action !== undefined
            ? { action }
            : {}),
        ...(unwrapped.reason !== undefined ? { reason: unwrapped.reason } : {}),
        detail: error.detail.trim().length > 0 ? error.detail : unwrapped.detail,
      });
    }
    return buildSnapshotFailure({
      _tag: error._tag,
      operation: error.operation,
      ...(action !== undefined ? { action } : {}),
      detail: error.detail,
    });
  }

  if (
    isGitManagerError(error) ||
    isPullRequestOperationError(error) ||
    isTextGenerationError(error)
  ) {
    return buildSnapshotFailure({
      _tag: error._tag,
      operation: error.operation,
      ...(fallback?.action !== undefined ? { action: fallback.action } : {}),
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
      detail: error.detail,
    });
  }

  return undefined;
}
