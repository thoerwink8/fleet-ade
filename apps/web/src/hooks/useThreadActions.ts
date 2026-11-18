import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useRouter } from "@tanstack/react-router";

import { getFallbackThreadIdAfterDelete, pinOrderKeyBetween } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { orchestrationEnvironment } from "../state/orchestration";
import { projectEnvironment } from "../state/projects";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useNewThreadHandler } from "./useHandleNewThread";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { announce } from "../lib/announce";
import { readLocalApi } from "../localApi";
import {
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentThreadRefs,
  readProject,
  readThreadShell,
  readThreadShells,
} from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { clearThreadPreviewState } from "../previewStateStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useClientSettings } from "./useSettings";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

export class ThreadArchiveBlockedError extends Schema.TaggedError<ThreadArchiveBlockedError>()(
  "ThreadArchiveBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "提供方仍在运行时无法归档。";
  }
}

export class ThreadSettlementUnsupportedError extends Schema.TaggedError<ThreadSettlementUnsupportedError>()(
  "ThreadSettlementUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "此环境的服务器尚不支持收尾。请更新服务器后再使用“收尾”。";
  }
}

export class ThreadSnoozeUnsupportedError extends Schema.TaggedError<ThreadSnoozeUnsupportedError>()(
  "ThreadSnoozeUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "此环境的服务器尚不支持暂缓。请更新服务器后再使用“暂缓”。";
  }
}

export class ThreadSnoozeBlockedError extends Schema.TaggedError<ThreadSnoozeBlockedError>()(
  "ThreadSnoozeBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "此会话正在等你处理。请先回复待处理的请求，再暂缓它。";
  }
}

function topOfPinnedRunOrderKey(): string | undefined {
  let firstKey: string | null = null;
  for (const shell of readThreadShells()) {
    if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
    if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}

export class ThreadAutoSettleOptOutUnsupportedError extends Schema.TaggedError<ThreadAutoSettleOptOutUnsupportedError>()(
  "ThreadAutoSettleOptOutUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "此环境的服务器尚不支持按会话关闭自动收尾。请更新服务器后再使用该功能。";
  }
}

export class ThreadPinningUnsupportedError extends Schema.TaggedError<ThreadPinningUnsupportedError>()(
  "ThreadPinningUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "此环境的服务器尚不支持置顶。请更新服务器后再使用“置顶”。";
  }
}

export class ThreadPinReorderUnsupportedError extends Schema.TaggedError<ThreadPinReorderUnsupportedError>()(
  "ThreadPinReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "此环境的服务器尚不支持重新排列置顶会话。请更新服务器后再调整置顶顺序。";
  }
}

export class ThreadActiveReorderUnsupportedError extends Schema.TaggedError<ThreadActiveReorderUnsupportedError>()(
  "ThreadActiveReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return "请更新此环境的服务器，以重新排列活动会话。";
  }
}

async function requestThreadUnpinConfirmation(input: {
  enabled: boolean;
  title: string;
  confirm: ((message: string) => Promise<boolean>) | null;
}) {
  const { confirm } = input;
  if (!input.enabled || confirm === null) {
    return AsyncResult.success(true);
  }

  return settlePromise(() =>
    confirm([`取消置顶会话“${input.title}”？`, "这会将会话移出置顶区域。"].join("\n")),
  );
}

export async function navigateAfterThreadDeletion(navigate: () => Promise<void>) {
  const result = await settlePromise(navigate);
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "会话已删除，但跳转失败",
        description: error instanceof Error ? error.message : "发生错误。",
      }),
    );
  }
}

function useMarkThreadUnread() {
  const markThreadUnreadMutation = useAtomCommand(threadEnvironment.markUnread, {
    reportFailure: false,
  });
  const markThreadUnreadLocal = useUiStateStore((state) => state.markThreadUnread);
  return (target: ScopedThreadRef) => {
    if (readEnvironmentServerConfigLoaded(target.environmentId)) {
      void markThreadUnreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      return;
    }
    const thread = readThreadShell(target);
    markThreadUnreadLocal(scopedThreadKey(target), thread?.latestRun?.completedAt);
  };
}

export function useAcknowledgeThreadWoke() {
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  return (target: ScopedThreadRef, wokeAt: string) => {
    if (readEnvironmentServerConfigLoaded(target.environmentId)) {
      void visitThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, visitedAt: wokeAt },
      });
      return;
    }
    markThreadVisited(scopedThreadKey(target), wokeAt);
  };
}

// These Undos restore a thread's place in the list, which archiving or deleting it ends.
const LIST_PLACEMENT_UNDO_KINDS = ["settle", "snooze", "pin"];

function expireThreadUndos(target: ScopedThreadRef, kinds: readonly string[]) {
  for (const kind of kinds) ThreadUndo.invalidate(kind, scopedThreadKey(target));
}

function clearDeletedThreadPanelState(ref: ScopedThreadRef) {
  clearThreadPreviewState(ref);
  useRightPanelStore.getState().removeThread(ref);
  useDiffPanelStore.getState().removeThread(ref);
  usePreviewMiniPlayerStore.getState().removeThread(ref);
}

/** A No project thread that already has its own folder, on a server that can promote it. */
export function canTurnThreadIntoProject(threadRef: ScopedThreadRef): boolean {
  const thread = readThreadShell(threadRef);
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  if (!thread?.worktreePath || config?.environment.capabilities.threadProjectFromScratch !== true) {
    return false;
  }
  const project = readProject({
    environmentId: threadRef.environmentId,
    projectId: thread.projectId,
  });
  return project !== null && isScratchProject(project, config.scratchWorkspaceRoot);
}

function threadOperationFailure(target: ScopedThreadRef) {
  return readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
    ? null
    : AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: "此连接无法修改会话。",
            requiredScope: AuthOrchestrationOperateScope,
          }),
        ),
      );
}

export function useThreadActions() {
  const archiveThreadMutation = useOrchestrationCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const unarchiveThreadMutation = useOrchestrationCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const deleteThreadMutation = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const batchThreadsMutation = useOrchestrationCommand(threadEnvironment.batch, {
    reportFailure: false,
  });
  const settleThreadMutation = useOrchestrationCommand(threadEnvironment.settle, {
    reportFailure: false,
  });
  const unsettleThreadMutation = useOrchestrationCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  const pinThreadMutation = useOrchestrationCommand(threadEnvironment.pin, {
    reportFailure: false,
  });
  const unpinThreadMutation = useOrchestrationCommand(threadEnvironment.unpin, {
    reportFailure: false,
  });
  const setThreadAutoSettleMutation = useOrchestrationCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });
  const reorderPinnedThreadMutation = useOrchestrationCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveThreadMutation = useOrchestrationCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const snoozeThreadMutation = useOrchestrationCommand(threadEnvironment.snooze, {
    reportFailure: false,
  });
  const unsnoozeThreadMutation = useOrchestrationCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const markThreadUnread = useMarkThreadUnread();
  const createProjectFromThread = useAtomCommand(projectEnvironment.createFromThread, {
    reportFailure: false,
  });
  const stopThreadSession = useOrchestrationCommand(threadEnvironment.stopSession);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const loadSessionState = useAtomQueryRunner(environmentSession.sessionStateAtom, {
    reportFailure: false,
  });
  const loadWorktreeThreadIds = useAtomQueryRunner(orchestrationEnvironment.worktreeThreadIds, {
    reportFailure: false,
    refresh: true,
  });
  const loadThreadFamily = useAtomQueryRunner(orchestrationEnvironment.threadFamily, {
    reportFailure: false,
    refresh: true,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const confirmThreadUnpin = useClientSettings((settings) => settings.confirmThreadUnpin);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalUiState = useTerminalUiStateStore((state) => state.clearTerminalUiState);
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();

  const resolveThreadTarget = (target: ScopedThreadRef) => {
    const thread = readThreadShell(target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  };
  const getCurrentRouteThreadRef = () => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  };

  const unarchiveThread = async (target: ScopedThreadRef, opts: { navigate?: boolean } = {}) => {
    ThreadUndo.invalidate("archive", scopedThreadKey(target));
    const result = await unarchiveThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Failure") {
      return result;
    }
    refreshArchivedThreadsForEnvironment(target.environmentId);
    if (opts.navigate) {
      return settlePromise(() =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target),
        }),
      );
    }
    return result;
  };

  const archiveThread = async (target: ScopedThreadRef, opts: { onArchived?: () => void } = {}) => {
    const resolved = resolveThreadTarget(target);
    if (!resolved) return AsyncResult.success(undefined);
    const { thread, threadRef } = resolved;
    if (!threadRuntimeCanArchive(thread.runtime)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadArchiveBlockedError({
            environmentId: threadRef.environmentId,
            threadId: threadRef.threadId,
          }),
        ),
      );
    }

    const requestingRouteHref = router.state.location.href;
    const currentRouteThreadRef = getCurrentRouteThreadRef();
    const shouldNavigateToDraft =
      currentRouteThreadRef?.threadId === threadRef.threadId &&
      currentRouteThreadRef.environmentId === threadRef.environmentId;
    const action = ThreadUndo.begin("archive", scopedThreadKey(threadRef));
    const archiveResult = await archiveThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (archiveResult._tag === "Failure") {
      action.finish();
      return archiveResult;
    }
    expireThreadUndos(threadRef, LIST_PLACEMENT_UNDO_KINDS);
    const wokeAt = threadWokeAt(thread, { now: new Date().toISOString() });
    if (wokeAt !== null) {
      markThreadVisited(scopedThreadKey(threadRef), wokeAt);
    }
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    opts.onArchived?.();
    showThreadUndoNotice({
      action: "Archived",
      claim: action,
      undo: () => unarchiveThread(threadRef, { navigate: shouldNavigateToDraft }),
      failureTitle: "无法撤销归档",
    });

    if (shouldNavigateToDraft && router.state.location.href === requestingRouteHref) {
      const navigationResult = await settlePromise(() =>
        handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (navigationResult._tag === "Failure") {
        return navigationResult;
      }
      return archiveResult;
    }

    return archiveResult;
  };

  const deleteThread = async (
    target: ScopedThreadRef,
    opts: { deletedThreadKeys?: ReadonlySet<string> } = {},
  ) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const resolved = resolveThreadTarget(target);
    if (!resolved) {
      let threads = readEnvironmentThreadRefs(target.environmentId).flatMap((ref) => {
        const shell = readThreadShell(ref);
        return shell === null ? [] : [{ id: shell.id, lineage: shell.lineage }];
      });
      if (
        appAtomRegistry.get(environmentServerConfigsAtom).get(target.environmentId)
          ?.shellThreadFamilies
      ) {
        const family = await loadThreadFamily({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
        if (family._tag === "Success") threads = [...family.value.threads];
      }
      const result = await deleteThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Success") {
        for (const ref of [
          target,
          ...threads
            .filter(
              (entry) =>
                entry.lineage.sideChat === true && entry.lineage.parentThreadId === target.threadId,
            )
            .map((entry) => scopeThreadRef(target.environmentId, entry.id)),
        ]) {
          releaseComposerDraftUploads(ref);
          clearComposerDraftForThread(ref);
        }
        expireThreadUndos(target, [...LIST_PLACEMENT_UNDO_KINDS, "archive"]);
        refreshArchivedThreadsForEnvironment(target.environmentId);
        clearTerminalUiState(target);
        clearDeletedThreadPanelState(target);
      }
      return result;
    }
    const { thread, threadRef } = resolved;
    const threads = readEnvironmentThreadRefs(threadRef.environmentId).flatMap((ref) => {
      const shell = readThreadShell(ref);
      return shell === null ? [] : [shell];
    });
    const threadProject = readProject({
      environmentId: threadRef.environmentId,
      projectId: thread.projectId,
    });
    const deletedIds =
      opts.deletedThreadKeys && opts.deletedThreadKeys.size > 0
        ? new Set<ThreadId>(
            [...opts.deletedThreadKeys].flatMap((threadKey) => {
              const ref = parseScopedThreadKey(threadKey);
              return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
            }),
          )
        : undefined;
    const survivingThreads =
      deletedIds && deletedIds.size > 0
        ? threads.filter((entry) => entry.id === threadRef.threadId || !deletedIds.has(entry.id))
        : threads;
    const environmentConfig = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(threadRef.environmentId);
    let orphanedWorktreePath = getOrphanedWorktreePathForThread(
      survivingThreads,
      threadRef.threadId,
    );
    // A shell that leaves idle subagent children out cannot prove nobody else uses the worktree,
    // so the server's list decides. A failed read keeps the worktree.
    if (orphanedWorktreePath !== null && environmentConfig?.shellThreadFamilies === true) {
      const occupants = await loadWorktreeThreadIds({
        environmentId: threadRef.environmentId,
        input: { worktreePath: orphanedWorktreePath },
      });
      if (
        occupants._tag !== "Success" ||
        occupants.value.threadIds.some(
          (threadId) => threadId !== threadRef.threadId && deletedIds?.has(threadId) !== true,
        )
      ) {
        orphanedWorktreePath = null;
      }
    }
    const displayWorktreePath = orphanedWorktreePath
      ? formatWorktreePathForDisplay(orphanedWorktreePath)
      : null;
    const localApi = readLocalApi();
    let canDeleteWorktree = false;
    if (
      orphanedWorktreePath !== null &&
      threadProject !== null &&
      !isScratchProject(threadProject, environmentConfig?.scratchWorkspaceRoot) &&
      localApi
    ) {
      const sessionResult = await loadSessionState(threadRef.environmentId);
      const permissionFailure = threadOperationFailure(threadRef);
      if (permissionFailure) return permissionFailure;
      canDeleteWorktree =
        sessionResult._tag === "Success" &&
        sessionGrantsScope(sessionResult.value, AuthSourceControlWriteScope);
    }
    let shouldDeleteWorktree = false;
    const environmentSettings = environmentConfig?.settings;
    const automaticWorktreeCleanup = environmentSettings
      ? resolveWorktreeCleanup(environmentSettings, thread.projectId).worktreeOnDelete
      : false;
    if (canDeleteWorktree && localApi && !automaticWorktreeCleanup) {
      const confirmationResult = await settlePromise(() =>
        localApi.dialogs.confirm(
          [
            "此会话是唯一关联到该工作树的会话：",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "同时删除工作树？",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      shouldDeleteWorktree = confirmationResult.value;
    }

    if (thread.runtime !== null) {
      await stopThreadSession({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
    }

    const deletedThreadIds = deletedIds ?? new Set<ThreadId>();
    const currentRouteThreadRef = getCurrentRouteThreadRef();
    const shouldNavigateToFallback =
      currentRouteThreadRef?.threadId === threadRef.threadId &&
      currentRouteThreadRef.environmentId === threadRef.environmentId;
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads,
      deletedThreadId: threadRef.threadId,
      deletedThreadIds,
      sortOrder: sidebarThreadSortOrder,
      now: new Date().toISOString(),
    });
    let navigatedDuringDelete = false;
    // The missing-thread redirect and the index draft replace this entry; any other history
    // action while the delete is pending is the user's own choice, which must win.
    const stopWatchingHistory = router.history.subscribe(({ action }) => {
      if (action.type !== "REPLACE") navigatedDuringDelete = true;
    });
    const deleteResult = await deleteThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }).finally(stopWatchingHistory);
    if (deleteResult._tag === "Failure") {
      return deleteResult;
    }
    expireThreadUndos(threadRef, [...LIST_PLACEMENT_UNDO_KINDS, "archive"]);
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    releaseComposerDraftUploads(threadRef);
    clearComposerDraftForThread(threadRef);
    // The server deletes the thread's side chats with it.
    for (const entry of threads) {
      if (entry.lineage.sideChat !== true || entry.lineage.parentThreadId !== threadRef.threadId) {
        continue;
      }
      const sideChatRef = scopeThreadRef(threadRef.environmentId, entry.id);
      releaseComposerDraftUploads(sideChatRef);
      clearComposerDraftForThread(sideChatRef);
    }
    clearProjectDraftThreadById(
      scopeProjectRef(threadRef.environmentId, thread.projectId),
      threadRef,
    );
    clearTerminalUiState(threadRef);
    clearDeletedThreadPanelState(threadRef);

    if (shouldNavigateToFallback && !navigatedDuringDelete) {
      const fallbackThread = fallbackThreadId
        ? readThreadShell(scopeThreadRef(threadRef.environmentId, fallbackThreadId))
        : null;
      await navigateAfterThreadDeletion(() =>
        fallbackThread
          ? router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
              ),
              replace: true,
            })
          : router.navigate({ to: "/", replace: true }),
      );
    }

    if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
      return deleteResult;
    }

    const removeResult = readEnvironmentScope(threadRef.environmentId, AuthSourceControlWriteScope)
      ? await removeWorktree({
          environmentId: threadRef.environmentId,
          input: {
            cwd: threadProject.workspaceRoot,
            path: orphanedWorktreePath,
            force: true,
          },
        })
      : AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              message: "此连接已无法移除工作树。",
              requiredScope: AuthSourceControlWriteScope,
            }),
          ),
        );
    const refreshResult =
      removeResult._tag === "Success"
        ? await refreshVcsStatus({
            environmentId: threadRef.environmentId,
            input: { cwd: threadProject.workspaceRoot },
          })
        : null;
    const cleanupFailure =
      removeResult._tag === "Failure"
        ? removeResult
        : refreshResult?._tag === "Failure"
          ? refreshResult
          : null;
    if (cleanupFailure) {
      const removalFailed = removeResult._tag === "Failure";
      const error = squashAtomCommandFailure(cleanupFailure);
      const message = error instanceof Error ? error.message : "发生错误。";
      console.error("Worktree cleanup failed after thread deletion", {
        threadId: threadRef.threadId,
        projectCwd: threadProject.workspaceRoot,
        worktreePath: orphanedWorktreePath,
        error,
      });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: removalFailed ? "无法删除工作树" : "工作树已删除，但刷新 Git 状态失败",
          description: removalFailed
            ? `无法移除 ${displayWorktreePath ?? orphanedWorktreePath}。${message}`
            : message,
        }),
      );
      // Cleanup has its own toast; reporting its failure would falsely imply deletion failed.
    }
    return deleteResult;
  };

  /** Batch delete across environments; mirrors deleteThread's local cleanup for every applied thread. */
  const deleteThreads = async (
    targets: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ThreadId }>,
  ): Promise<{
    readonly deletedKeys: ReadonlySet<string>;
    readonly failures: readonly string[];
  }> => {
    const failures: string[] = [];
    const deletedIds = new Set<ThreadId>();
    const shellsByEnvironment = new Map<EnvironmentId, ReadonlyArray<EnvironmentThreadShell>>();
    const groups = new Map<EnvironmentId, ThreadId[]>();
    for (const target of targets) {
      const group = groups.get(target.environmentId);
      if (group) group.push(target.id);
      else groups.set(target.environmentId, [target.id]);
    }
    for (const [environmentId, threadIds] of groups) {
      const permissionFailure = threadOperationFailure(
        scopeThreadRef(environmentId, threadIds[0]!),
      );
      if (permissionFailure) {
        const error = squashAtomCommandFailure(permissionFailure);
        failures.push(error instanceof Error ? error.message : "发生错误。");
        continue;
      }
      shellsByEnvironment.set(
        environmentId,
        readEnvironmentThreadRefs(environmentId).flatMap((ref) => {
          const shell = readThreadShell(ref);
          return shell === null ? [] : [shell];
        }),
      );
      const result = await batchThreadsMutation({
        environmentId,
        input: { operation: "delete", threadIds },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) break;
        const error = squashAtomCommandFailure(result);
        failures.push(error instanceof Error ? error.message : "请求失败");
        continue;
      }
      for (const item of result.value.batch?.items ?? []) {
        if (item.status === "applied" || item.status === "deleted" || item.status === "not_found") {
          deletedIds.add(item.threadId);
          continue;
        }
        const title =
          shellsByEnvironment.get(environmentId)?.find((shell) => shell.id === item.threadId)
            ?.title ?? item.threadId;
        if (item.status === "running") failures.push(`${title} 正在跑，未删除`);
        else if (item.status === "rejected") failures.push(`${title} 未处理`);
      }
    }

    if (deletedIds.size === 0) return { deletedKeys: deletedIds, failures };

    const deletedKeys = new Set<string>();
    const worktreeRemovals: Array<{
      environmentId: EnvironmentId;
      project: { readonly workspaceRoot: string };
      path: string;
      displayPath: string | null;
    }> = [];
    const currentRoute = getCurrentRouteThreadRef();
    let fallbackEnvironmentId: EnvironmentId | null = null;
    let fallbackThreadId: ThreadId | null = null;
    for (const [environmentId, threads] of shellsByEnvironment) {
      const environmentConfig = appAtomRegistry
        .get(environmentServerConfigsAtom)
        .get(environmentId);
      const environmentSettings = environmentConfig?.settings;
      const localApi = readLocalApi();
      const surviving = threads.filter((entry) => !deletedIds.has(entry.id));
      const sessionResult = localApi == null ? null : await loadSessionState(environmentId);
      const canDeleteWorktree =
        sessionResult !== null &&
        sessionResult._tag === "Success" &&
        sessionGrantsScope(sessionResult.value, AuthSourceControlWriteScope);
      const pendingConfirm: Array<{
        project: { readonly workspaceRoot: string };
        path: string;
        displayPath: string | null;
      }> = [];
      for (const thread of threads) {
        if (!deletedIds.has(thread.id)) continue;
        const threadId = thread.id;
        const threadRef = scopeThreadRef(environmentId, threadId);
        expireThreadUndos(threadRef, [...LIST_PLACEMENT_UNDO_KINDS, "archive"]);
        releaseComposerDraftUploads(threadRef);
        clearComposerDraftForThread(threadRef);
        clearProjectDraftThreadById(scopeProjectRef(environmentId, thread.projectId), threadRef);
        clearTerminalUiState(threadRef);
        clearDeletedThreadPanelState(threadRef);
        deletedKeys.add(scopedThreadKey(threadRef));
        for (const entry of threads) {
          if (entry.lineage.sideChat !== true || entry.lineage.parentThreadId !== threadId) {
            continue;
          }
          const sideChatRef = scopeThreadRef(environmentId, entry.id);
          releaseComposerDraftUploads(sideChatRef);
          clearComposerDraftForThread(sideChatRef);
        }
        if (currentRoute?.threadId === threadId && currentRoute.environmentId === environmentId) {
          fallbackEnvironmentId = environmentId;
          fallbackThreadId = getFallbackThreadIdAfterDelete({
            threads,
            deletedThreadId: threadId,
            deletedThreadIds: deletedIds,
            sortOrder: sidebarThreadSortOrder,
            now: new Date().toISOString(),
          });
        }
        const orphanedWorktreePath = getOrphanedWorktreePathForThread(surviving, threadId);
        if (orphanedWorktreePath === null) continue;
        const threadProject = readProject({
          environmentId,
          projectId: thread.projectId,
        });
        if (
          threadProject === null ||
          isScratchProject(threadProject, environmentConfig?.scratchWorkspaceRoot)
        )
          continue;
        let orphan: string | null = orphanedWorktreePath;
        if (environmentConfig?.shellThreadFamilies === true) {
          const occupants = await loadWorktreeThreadIds({
            environmentId,
            input: { worktreePath: orphanedWorktreePath },
          });
          if (
            occupants._tag !== "Success" ||
            occupants.value.threadIds.some(
              (occupant) => occupant !== threadId && !deletedIds.has(occupant),
            )
          ) {
            orphan = null;
          }
        }
        if (orphan === null) continue;
        const removal = {
          project: threadProject,
          path: orphan,
          displayPath: formatWorktreePathForDisplay(orphan),
        };
        if (
          environmentSettings !== undefined &&
          resolveWorktreeCleanup(environmentSettings, thread.projectId).worktreeOnDelete
        ) {
          worktreeRemovals.push({ environmentId, ...removal });
        } else if (canDeleteWorktree) {
          pendingConfirm.push(removal);
        }
      }
      refreshArchivedThreadsForEnvironment(environmentId);
      if (pendingConfirm.length > 0 && localApi != null) {
        const confirmed = await localApi.dialogs.confirm(
          [
            `这些会话独占 ${pendingConfirm.length} 个工作树：`,
            ...pendingConfirm.map((entry) => entry.displayPath ?? entry.path),
            "",
            "同时删除工作树？",
          ].join("\n"),
          { variant: "destructive" },
        );
        if (confirmed) {
          worktreeRemovals.push(
            ...pendingConfirm.map((removal) => ({ environmentId, ...removal })),
          );
        }
      }
    }

    if (fallbackEnvironmentId !== null) {
      const fallbackThread =
        fallbackThreadId !== null
          ? readThreadShell(scopeThreadRef(fallbackEnvironmentId, fallbackThreadId))
          : null;
      await navigateAfterThreadDeletion(() =>
        fallbackThread
          ? router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
              ),
              replace: true,
            })
          : router.navigate({ to: "/", replace: true }),
      );
    }

    const refreshedCwds = new Set<string>();
    for (const removal of worktreeRemovals) {
      const removeResult = readEnvironmentScope(removal.environmentId, AuthSourceControlWriteScope)
        ? await removeWorktree({
            environmentId: removal.environmentId,
            input: {
              cwd: removal.project.workspaceRoot,
              path: removal.path,
              force: true,
            },
          })
        : AsyncResult.failure(
            Cause.fail(
              new EnvironmentAuthorizationError({
                message: "此连接已无法移除工作树。",
                requiredScope: AuthSourceControlWriteScope,
              }),
            ),
          );
      const refreshResult =
        removeResult._tag === "Success" && !refreshedCwds.has(removal.project.workspaceRoot)
          ? await refreshVcsStatus({
              environmentId: removal.environmentId,
              input: { cwd: removal.project.workspaceRoot },
            })
          : null;
      if (removeResult._tag === "Success") refreshedCwds.add(removal.project.workspaceRoot);
      const cleanupFailure =
        removeResult._tag === "Failure"
          ? removeResult
          : refreshResult?._tag === "Failure"
            ? refreshResult
            : null;
      if (cleanupFailure) {
        const error = squashAtomCommandFailure(cleanupFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              removeResult._tag === "Failure"
                ? "无法删除工作树"
                : "工作树已删除，但刷新 Git 状态失败",
            description: error instanceof Error ? error.message : "发生错误。",
          }),
        );
      }
    }
    return { deletedKeys, failures };
  };

  /** Batch mark-unread; falls back to per-thread local marking while a server config is not loaded. */
  const markThreadsUnread = async (
    targets: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ThreadId }>,
  ): Promise<readonly string[]> => {
    const failures: string[] = [];
    const groups = new Map<EnvironmentId, ThreadId[]>();
    for (const target of targets) {
      const group = groups.get(target.environmentId);
      if (group) group.push(target.id);
      else groups.set(target.environmentId, [target.id]);
    }
    for (const [environmentId, threadIds] of groups) {
      if (!readEnvironmentServerConfigLoaded(environmentId)) {
        for (const threadId of threadIds) {
          markThreadUnread(scopeThreadRef(environmentId, threadId));
        }
        continue;
      }
      const result = await batchThreadsMutation({
        environmentId,
        input: { operation: "mark-unread", threadIds },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) break;
        const error = squashAtomCommandFailure(result);
        failures.push(error instanceof Error ? error.message : "请求失败");
        continue;
      }
      for (const item of result.value.batch?.items ?? []) {
        if (item.status === "rejected") {
          const title =
            readThreadShell(scopeThreadRef(environmentId, item.threadId))?.title ?? item.threadId;
          failures.push(`${title} 没有可标为未读的已完成轮次`);
        }
      }
    }
    return failures;
  };

  const unsettleThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSettlementUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    // reason "user" pins active until real activity, suppressing auto-settle.
    return unsettleThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  };

  const setThreadAutoSettle = async (target: ScopedThreadRef, enabled: boolean) => {
    if (!readEnvironmentSupportsAutoSettleOptOut(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadAutoSettleOptOutUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return setThreadAutoSettleMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, enabled },
    });
  };

  const sendPin = async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinningUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const orderKey = opts.orderKey ?? topOfPinnedRunOrderKey();
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return pinThreadMutation({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        ...(orderKey !== undefined ? { orderKey } : {}),
      },
    });
  };

  const pinThread = async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
    const result = await sendPin(target, opts);
    if (result._tag === "Success") announce("已置顶 1 个会话");
    return result;
  };

  const unpinThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinningUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const thread = readThreadShell(target);
    const undoPlan = ThreadUndo.planThreadUndo("unpin", thread);
    const action = ThreadUndo.begin("pin", scopedThreadKey(target));
    const result = await unpinThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Success" && action.isCurrent()) {
      showThreadUndoNotice({
        action: "Unpinned",
        claim: action,
        undo: () => runUndoPlan(target, undoPlan),
        failureTitle: "无法撤销取消置顶",
      });
    } else {
      action.finish();
    }
    return result;
  };

  const settleThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSettlementUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const resolved = resolveThreadTarget(target);
    // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
    const nowIso = new Date().toISOString();
    const wokeAt = resolved ? threadWokeAt(resolved.thread, { now: nowIso }) : null;
    const undoPlan = ThreadUndo.planThreadUndo("settle", resolved?.thread);
    // An older unpin/snooze Undo would re-pin or re-snooze, and the server
    // treats either as a promotion that un-settles; settling supersedes them.
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    const action = ThreadUndo.begin("settle", scopedThreadKey(target));
    const result = await settleThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag !== "Success") {
      action.finish();
      return result;
    }
    if (wokeAt !== null) {
      markThreadVisited(scopedThreadKey(target), wokeAt);
    }
    showThreadUndoNotice({
      action: "Settled",
      claim: action,
      undo: () => runUndoPlan(target, undoPlan),
      failureTitle: "无法撤销收尾",
    });
    return result;
  };

  const confirmAndUnpinThread = async (target: ScopedThreadRef) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const localApi = readLocalApi();
    const resolved = resolveThreadTarget(target);
    const confirmationResult = await requestThreadUnpinConfirmation({
      enabled: confirmThreadUnpin,
      title: resolved?.thread.title ?? "this thread",
      confirm: localApi ? (message) => localApi.dialogs.confirm(message) : null,
    });
    if (confirmationResult._tag === "Failure") {
      return confirmationResult;
    }
    if (!confirmationResult.value) {
      return AsyncResult.success(undefined);
    }
    return unpinThread(target);
  };

  const reorderPinnedThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    return reorderPinnedThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey },
    });
  };

  const reorderActiveThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadActiveReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return reorderActiveThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey },
    });
  };

  const unsnoozeThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return unsnoozeThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  };

  const snoozeThread = async (target: ScopedThreadRef, snoozedUntil: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const resolved = resolveThreadTarget(target);
    // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
    if (resolved && !canSnooze(resolved.thread, { now: new Date().toISOString() })) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeBlockedError({
            environmentId: resolved.threadRef.environmentId,
            threadId: resolved.threadRef.threadId,
          }),
        ),
      );
    }
    const action = ThreadUndo.begin("snooze", scopedThreadKey(target));
    const result = await snoozeThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil },
    });
    if (result._tag !== "Success") {
      action.finish();
      return result;
    }
    showThreadUndoNotice({
      action: "Snoozed",
      claim: action,
      undo: () => runUndoPlan(target, ThreadUndo.planThreadUndo("snooze")),
      failureTitle: "唤醒会话失败",
    });
    return result;
  };

  const runUndoPlan = (target: ScopedThreadRef, plan: ThreadUndo.ThreadUndoPlan) =>
    ThreadUndo.executeThreadUndo(
      plan,
      async (step) => {
        switch (step.action) {
          case "unsettle":
            return unsettleThread(target);
          case "unsnooze":
            return unsnoozeThread(target);
          case "pin":
            return sendPin(target, step.orderKey === undefined ? {} : { orderKey: step.orderKey });
          case "snooze":
            return snoozeThreadMutation({
              environmentId: target.environmentId,
              input: { threadId: target.threadId, snoozedUntil: step.snoozedUntil },
            });
        }
      },
      (result) => result._tag === "Success",
    );

  const confirmAndDeleteThread = async (target: ScopedThreadRef, knownTitle?: string) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const localApi = readLocalApi();
    const resolved = resolveThreadTarget(target);

    if (confirmThreadDelete && localApi) {
      const title = resolved?.thread.title ?? knownTitle ?? "this thread";
      const confirmationResult = await settlePromise(() =>
        localApi.dialogs.confirm(
          [`删除会话“${title}”？`, "这将永久清除此会话的对话历史。"].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      if (!confirmationResult.value) {
        return AsyncResult.success(undefined);
      }
    }

    return deleteThread(target);
  };

  return {
    deleteThreads,
    markThreadsUnread,
    archiveThread,
    unarchiveThread,
    deleteThread,
    confirmAndDeleteThread,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    reorderPinnedThread,
    reorderActiveThread,
    markThreadUnread,
    setThreadAutoSettle,
    turnThreadIntoProject: (target: ScopedThreadRef) =>
      createProjectFromThread({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      }),
  };
}
