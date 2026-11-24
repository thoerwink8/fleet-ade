import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { pickSnoozePreset, resolveSnoozePresets } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { titleRegenerationToast } from "../components/threadTitleRegenerationToast";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { copyThreadReference } from "../lib/copyThreadReference";
import { threadArchiveConfirmCopy } from "../lib/threadConfirmCopy";
import { exportThreadMarkdown } from "../lib/exportThreadMarkdown";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope } from "../state/session";
import {
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsAutoSettleOptOut,
  readThreadShell,
  useProjects,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readLocalApi } from "../localApi";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { canTurnThreadIntoProject, useThreadActions } from "./useThreadActions";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "发生错误。",
    }),
  );
}

export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectCwd: string | null;
  readonly onStartRename: () => void;
  readonly onFind?: ((threadRef: ScopedThreadRef) => void) | undefined;
}) {
  const { threadRef, projectCwd, onStartRename, onFind } = input;
  const router = useRouter();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const logicalProjectKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
    projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
  });
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    markCommanderThread,
    unmarkCommanderThread,
    setThreadAutoSettle,
    archiveThread,
    deleteThread,
    markThreadUnread,
    turnThreadIntoProject,
  } = useThreadActions();
  const regenerateThreadTitle = useOrchestrationCommand(threadEnvironment.regenerateTitle, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "路径已复制", description: path });
    },
    onError: (error) => failureToast("复制路径失败", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "分支名已复制", description: branch });
    },
    onError: (error) => failureToast("复制分支名失败", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({ type: "success", title: "会话 ID 已复制", description: threadId });
    },
    onError: (error) => failureToast("复制会话 ID 失败", error),
  });

  const openMenu = (position: { x: number; y: number }) => {
    if (threadRef === null) return;
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const thread = readThreadShell(threadRef);
      if (!thread) {
        failureToast("会话操作不可用", new Error("这个会话还没有加载。"));
        return;
      }
      const now = new Date();
      const configLoaded = readEnvironmentServerConfigLoaded(threadRef.environmentId);
      const supports = {
        settlement: configLoaded,
        autoSettleOptOut: readEnvironmentSupportsAutoSettleOptOut(threadRef.environmentId),
        snooze: configLoaded,
        pinning: configLoaded,
        commander: configLoaded,
        titleRegeneration: configLoaded,
      };
      const isRegeneratingTitle = thread.titleRegeneration != null;
      const snoozePresets = resolveSnoozePresets(now, timestampFormat, threadRef.environmentId);
      const items = buildThreadActionMenuItems({
        canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
        canFind: onFind !== undefined,
        canExport: true,
        branch: thread.branch ?? null,
        projectFilter: null,
        isPinned: thread.pinnedAt != null,
        isCommander: thread.commander === true,
        isSettled: supports.settlement && thread.settledOverride === "settled",
        autoSettleEnabled: thread.autoSettleDisabledAt == null,
        isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
        canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
        isRegeneratingTitle,
        isRunning: !threadRuntimeCanArchive(thread.runtime),
        supports,
        snoozePresets,
        canTurnIntoProject: canTurnThreadIntoProject(threadRef),
      });
      const clicked = await settlePromise(() => api.contextMenu.show(items, position));
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const action: ThreadActionMenuId = clicked.value;
      if (
        threadActionRequiresOperate(action) &&
        !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
      ) {
        failureToast("无法执行会话操作", new Error("此连接无法修改会话。"));
        return;
      }
      if (action.startsWith("snooze:")) {
        const preset =
          action === "snooze:custom"
            ? await requestCustomSnooze()
            : pickSnoozePreset(
                snoozePresets,
                action.slice("snooze:".length),
                timestampFormat,
                threadRef.environmentId,
              );
        if (!preset) return;
        const result = await snoozeThread(threadRef, preset.snoozedUntil);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast("暂缓会话失败", squashAtomCommandFailure(result));
        }
        return;
      }
      const reportFailure = async (
        title: string,
        run: () => Promise<AtomCommandResult<unknown, unknown>>,
      ) => {
        const result = await run();
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast(title, squashAtomCommandFailure(result));
        }
      };
      switch (action) {
        case "find":
          onFind?.(threadRef);
          return;
        case "project-settings": {
          const project = projects.find(
            (candidate) =>
              candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
          );
          if (!project) return;
          const projectKey =
            logicalProjectKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
            deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings);
          void router.navigate({
            to: "/projects/$projectKey",
            params: { projectKey },
          });
          return;
        }
        case "new-thread-on-branch": {
          const result = await settlePromise(() =>
            handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              envMode: thread.worktreePath ? "worktree" : "local",
              startFromOrigin: false,
            }),
          );
          if (result._tag === "Failure") {
            failureToast("无法创建会话", squashAtomCommandFailure(result));
          }
          return;
        }
        case "settle":
          await reportFailure("收尾会话失败", () => settleThread(threadRef));
          return;
        case "unsettle":
          await reportFailure("取消会话收尾失败", () => unsettleThread(threadRef));
          return;
        case "unsnooze":
          await reportFailure("唤醒会话失败", () => unsnoozeThread(threadRef));
          return;
        case "pin":
          await reportFailure("置顶会话失败", () => pinThread(threadRef));
          return;
        case "unpin": {
          await reportFailure("取消置顶会话失败", () => confirmAndUnpinThread(threadRef));
          return;
        }
        case "mark-commander":
          await reportFailure("标成指挥失败", () => markCommanderThread(threadRef));
          return;
        case "unmark-commander":
          await reportFailure("取消指挥失败", () => unmarkCommanderThread(threadRef));
          return;
        case "auto-settle:enabled":
        case "auto-settle:disabled":
          await reportFailure("更新自动收尾设置失败", () =>
            setThreadAutoSettle(threadRef, action === "auto-settle:enabled"),
          );
          return;
        case "rename":
          onStartRename();
          return;
        case "regenerate-title": {
          if (isRegeneratingTitle) return;
          const toast = titleRegenerationToast([
            await regenerateThreadTitle({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId },
            }),
          ]);
          if (toast) toastManager.add(toast);
          return;
        }
        case "mark-unread":
          markThreadUnread(threadRef);
          return;
        case "turn-into-project": {
          const result = await turnThreadIntoProject(threadRef);
          if (result._tag === "Success") {
            toastManager.add({
              type: "success",
              title: "项目已创建",
              description: thread.title,
            });
          } else if (!isAtomCommandInterrupted(result)) {
            failureToast("无法将会话转换为项目", squashAtomCommandFailure(result));
          }
          return;
        }
        case "export-markdown": {
          const project = projects.find(
            (candidate) =>
              candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
          );
          await exportThreadMarkdown({
            threadRef,
            title: thread.title,
            projectName: project?.title ?? null,
          });
          return;
        }
        case "copy-path": {
          const workspacePath = thread.worktreePath ?? projectCwd;
          if (!workspacePath) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "路径不可用",
                description: "此会话没有可复制的工作区路径。",
              }),
            );
            return;
          }
          copyPathToClipboard(workspacePath, { path: workspacePath });
          return;
        }
        case "copy-branch":
          if (thread.branch) {
            copyBranchToClipboard(thread.branch, { branch: thread.branch });
          }
          return;
        case "copy-thread":
          void copyThreadReference(threadChipCopyTarget(threadRef, thread.title));
          return;
        case "copy-thread-id":
          copyThreadIdToClipboard(thread.id, { threadId: thread.id });
          return;
        case "archive": {
          if (confirmThreadArchive) {
            const copy = threadArchiveConfirmCopy(thread.title);
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(copy.message, copy.options),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return;
          }
          let didArchive = false;
          const result = await archiveThread(threadRef, {
            onArchived: () => {
              didArchive = true;
            },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(
              didArchive ? "会话已归档，但页面跳转失败" : "归档会话失败",
              squashAtomCommandFailure(result),
            );
          }
          return;
        }
        case "delete": {
          const deleted = await deleteThread(threadRef, {
            confirmDeletion: { threadTitle: thread.title, always: confirmThreadDelete },
          });
          if (
            deleted._tag === "Failure" &&
            !isAtomCommandInterrupted(deleted) &&
            // A missing thread means cleanup failed after deletion; deleteThread already toasted that failure.
            readThreadShell(threadRef) !== null
          ) {
            failureToast("删除会话失败", squashAtomCommandFailure(deleted));
          }
          return;
        }
        default:
          return;
      }
    })();
  };

  const closeMenu = () => {
    void readLocalApi()?.contextMenu.close();
  };

  return { openMenu, closeMenu };
}
