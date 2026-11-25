import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { presentVersionControlError } from "./components/versionControlError.logic";
import type { ThreadShell } from "./types";

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = targetThread.worktreePath?.trim();
  if (!targetWorktreePath) {
    return null;
  }

  // Threads can store one worktree as `/repo/wt` and `/repo/wt/`, and
  // confirming deletion force-removes the checkout for every thread on it.
  const targetKey = normalizeProjectPathForComparison(targetWorktreePath);
  const isShared = threads.some(
    (thread) =>
      thread.id !== threadId &&
      thread.worktreePath !== null &&
      normalizeProjectPathForComparison(thread.worktreePath) === targetKey,
  );

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}

/**
 * The toast after a thread is deleted but its worktree cleanup failed. When only the Git status
 * refresh failed the worktree is already gone, so the title says that first.
 */
export function describeWorktreeCleanupFailure(input: {
  readonly removalFailed: boolean;
  readonly error: unknown;
  readonly worktreePath?: string;
}): { readonly title: string; readonly description: string; readonly detail: string } {
  if (!input.removalFailed) {
    const presentation = presentVersionControlError(input.error, "刷新 Git 状态");
    return {
      title: "工作树已删除，但无法刷新 Git 状态",
      description: presentation.description,
      detail: presentation.detail,
    };
  }
  const presentation = presentVersionControlError(input.error, "删除工作树");
  return {
    title: presentation.title,
    description:
      input.worktreePath === undefined
        ? presentation.description
        : `无法删除 ${input.worktreePath}。${presentation.description}`,
    detail: presentation.detail,
  };
}
