import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { attentionDismissVisitedAt } from "../components/Sidebar.logic";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import {
  pickSnoozePreset,
  resolveSnoozePresets,
  type SnoozePreset,
} from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
  type ThreadActionMenuState,
  type ThreadActionMenuSurface,
} from "../components/threadActionMenu.logic";
import { titleRegenerationToast } from "../components/threadTitleRegenerationToast";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { copyThreadReference } from "../lib/copyThreadReference";
import { exportThreadMarkdown } from "../lib/exportThreadMarkdown";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope } from "../state/session";
import {
  readEnvironmentHasCommanderConfig,
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsVisitedTracking,
  readThreadShell,
  readThreadShells,
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
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import {
  canTurnThreadIntoProject,
  useAcknowledgeThreadWoke,
  useThreadActions,
} from "./useThreadActions";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "发生错误。",
    }),
  );
}

export interface ThreadActionMenuOpenOverride {
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly thread?: EnvironmentThreadShell | undefined;
  readonly projectCwd?: string | null | undefined;
  readonly projectFilter?: ThreadActionMenuState["projectFilter"] | undefined;
  readonly attentionDismissible?: boolean | undefined;
  readonly isSettled?: boolean | undefined;
  readonly isSnoozed?: boolean | undefined;
  readonly supports?: ThreadActionMenuState["supports"] | undefined;
  readonly hasAnyCommanderThread?: boolean | undefined;
  readonly hasCommanderConfig?: boolean | undefined;
  readonly supportsVisitedTracking?: boolean | undefined;
  readonly onStartRename?: (() => void) | undefined;
  readonly onFilterByProject?: (() => void) | undefined;
  readonly onOpenProjectSettings?: (() => void) | undefined;
}

export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectCwd: string | null;
  readonly surface?: ThreadActionMenuSurface | undefined;
  readonly onStartRename: () => void;
  readonly onFind?: ((threadRef: ScopedThreadRef) => void) | undefined;
  readonly onFilterByProject?: ((threadRef: ScopedThreadRef) => void) | undefined;
  readonly onOpenProjectSettings?: ((threadRef: ScopedThreadRef) => void) | undefined;
  readonly onSettle?: ((threadRef: ScopedThreadRef) => void) | undefined;
  readonly onSnooze?:
    | ((threadRef: ScopedThreadRef, preset: Pick<SnoozePreset, "snoozedUntil">) => void)
    | undefined;
}) {
  const {
    threadRef,
    projectCwd,
    surface = "chat-header",
    onStartRename,
    onFind,
    onFilterByProject,
    onOpenProjectSettings,
    onSettle,
    onSnooze,
  } = input;
  const router = useRouter();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const logicalProjectKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
    projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
  });
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
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
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "路径已复制", description: path });
    },
    onError: (error) => failureToast("无法复制路径", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "分支名已复制", description: branch });
    },
    onError: (error) => failureToast("无法复制分支名", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({ type: "success", title: "会话 ID 已复制", description: threadId });
    },
    onError: (error) => failureToast("无法复制会话 ID", error),
  });

  const openMenu = (
    position: { x: number; y: number },
    override?: ThreadActionMenuOpenOverride,
  ) => {
    const targetRef = override?.threadRef ?? threadRef;
    if (targetRef === null) return;
    const effectiveProjectCwd =
      override?.projectCwd !== undefined ? override.projectCwd : projectCwd;
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const thread = override?.thread ?? readThreadShell(targetRef);
      if (!thread) {
        failureToast("会话操作不可用", new Error("这个会话还没有加载。"));
        return;
      }
      const now = new Date();
      const configLoaded = readEnvironmentServerConfigLoaded(targetRef.environmentId);
      const supports = override?.supports ?? {
        settlement: configLoaded,
        autoSettleOptOut: readEnvironmentSupportsAutoSettleOptOut(targetRef.environmentId),
        snooze: configLoaded,
        pinning: configLoaded,
        commander: configLoaded,
        titleRegeneration: configLoaded,
      };
      const hasAnyCommanderThread =
        override?.hasAnyCommanderThread ??
        (thread.commander === true ||
          readThreadShells().some(
            (candidate) => candidate.archivedAt === null && candidate.commander === true,
          ));
      const hasCommanderConfig =
        override?.hasCommanderConfig ?? readEnvironmentHasCommanderConfig(targetRef.environmentId);
      const isRegeneratingTitle = thread.titleRegeneration != null;
      const snoozePresets = resolveSnoozePresets(now, timestampFormat, targetRef.environmentId);
      const items = buildThreadActionMenuItems({
        surface,
        canOperate: readEnvironmentScope(targetRef.environmentId, AuthOrchestrationOperateScope),
        canFind: onFind !== undefined,
        canExport: true,
        branch: thread.branch ?? null,
        projectFilter: override?.projectFilter ?? null,
        isPinned: thread.pinnedAt != null,
        isCommander: thread.commander === true,
        hasAnyCommanderThread,
        hasCommanderConfig,
        isSettled:
          override?.isSettled ?? (supports.settlement && thread.settledOverride === "settled"),
        autoSettleEnabled: thread.autoSettleDisabledAt == null,
        isSnoozed:
          override?.isSnoozed ??
          (supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() })),
        canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
        isRegeneratingTitle,
        attentionDismissible: override?.attentionDismissible ?? false,
        isRunning: !threadRuntimeCanArchive(thread.runtime),
        supports,
        snoozePresets,
        canTurnIntoProject: canTurnThreadIntoProject(targetRef),
      });
      const clicked = await settlePromise(() => api.contextMenu.show(items, position));
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const action: ThreadActionMenuId = clicked.value;
      if (
        threadActionRequiresOperate(action) &&
        !readEnvironmentScope(targetRef.environmentId, AuthOrchestrationOperateScope)
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
                targetRef.environmentId,
              );
        if (!preset) return;
        if (onSnooze) {
          onSnooze(targetRef, preset);
          return;
        }
        const result = await snoozeThread(targetRef, preset.snoozedUntil);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast("无法暂缓会话", squashAtomCommandFailure(result));
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
          onFind?.(targetRef);
          return;
        case "filter-by-project":
          if (override?.onFilterByProject) {
            override.onFilterByProject();
          } else {
            onFilterByProject?.(targetRef);
          }
          return;
        case "project-settings": {
          if (override?.onOpenProjectSettings) {
            override.onOpenProjectSettings();
            return;
          }
          if (onOpenProjectSettings) {
            onOpenProjectSettings(targetRef);
            return;
          }
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
            handleNewThread(scopeProjectRef(targetRef.environmentId, thread.projectId), {
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
          if (onSettle) {
            onSettle(targetRef);
            return;
          }
          await reportFailure("无法标为完成", () => settleThread(targetRef));
          return;
        case "unsettle":
          await reportFailure("无法取消完成", () => unsettleThread(targetRef));
          return;
        case "unsnooze":
          await reportFailure("无法取消暂缓", () => unsnoozeThread(targetRef));
          return;
        case "pin":
          await reportFailure("无法置顶会话", () => pinThread(targetRef));
          return;
        case "unpin": {
          await reportFailure("无法取消置顶会话", () => unpinThread(targetRef));
          return;
        }
        case "mark-commander":
          await reportFailure("无法标成指挥", () => markCommanderThread(targetRef));
          return;
        case "unmark-commander":
          await reportFailure("无法取消指挥", () => unmarkCommanderThread(targetRef));
          return;
        case "auto-settle:enabled":
        case "auto-settle:disabled":
          await reportFailure("无法更新自动标为完成设置", () =>
            setThreadAutoSettle(targetRef, action === "auto-settle:enabled"),
          );
          return;
        case "rename":
          if (override?.onStartRename) {
            override.onStartRename();
          } else {
            onStartRename();
          }
          return;
        case "regenerate-title": {
          if (isRegeneratingTitle) return;
          const toast = titleRegenerationToast([
            await regenerateThreadTitle({
              environmentId: targetRef.environmentId,
              input: { threadId: targetRef.threadId },
            }),
          ]);
          if (toast) toastManager.add(toast);
          return;
        }
        case "dismiss-attention": {
          acknowledgeWoke(
            targetRef,
            attentionDismissVisitedAt(
              thread,
              threadWokeAt(thread, { now: new Date().toISOString() }),
            ),
          );
          const canUndo =
            override?.supportsVisitedTracking ??
            readEnvironmentSupportsVisitedTracking(targetRef.environmentId);
          if (canUndo) {
            const claim = ThreadUndo.begin("dismiss-attention", scopedThreadKey(targetRef));
            showThreadUndoNotice({
              action: "DismissedAttention",
              title: thread.title,
              claim,
              undo: () => markThreadUnread(targetRef),
              failureTitle: "无法撤销移出等你处理",
            });
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "已移出等你处理",
              description: "已把这条会话标记为看过，所有设备同步。",
            }),
          );
          return;
        }
        case "mark-unread":
          void markThreadUnread(targetRef);
          return;
        case "turn-into-project": {
          const result = await turnThreadIntoProject(targetRef);
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
            threadRef: targetRef,
            title: thread.title,
            projectName: project?.title ?? null,
          });
          return;
        }
        case "copy-path": {
          const workspacePath = thread.worktreePath ?? effectiveProjectCwd;
          if (!workspacePath) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "路径不可用",
                description: "此会话没有可复制的目录路径。",
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
          void copyThreadReference(threadChipCopyTarget(targetRef, thread.title));
          return;
        case "copy-thread-id":
          copyThreadIdToClipboard(thread.id, { threadId: thread.id });
          return;
        case "archive": {
          let didArchive = false;
          const result = await archiveThread(targetRef, {
            onArchived: () => {
              didArchive = true;
            },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(
              didArchive ? "会话已归档，但无法跳转页面" : "无法归档会话",
              squashAtomCommandFailure(result),
            );
          }
          return;
        }
        case "delete": {
          const deleted = await deleteThread(targetRef, {
            confirmDeletion: { threadTitle: thread.title, always: confirmThreadDelete },
          });
          if (
            deleted._tag === "Failure" &&
            !isAtomCommandInterrupted(deleted) &&
            // A missing thread means cleanup failed after deletion; deleteThread already toasted that failure.
            readThreadShell(targetRef) !== null
          ) {
            failureToast("无法删除会话", squashAtomCommandFailure(deleted));
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
