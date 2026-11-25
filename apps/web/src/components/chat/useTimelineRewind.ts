import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useRef, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { newThreadId } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useComposerDraftStore } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { orchestrationEnvironment } from "../../state/orchestration";
import { waitForThreadShell } from "../../state/entities";
import { openRevertConfirm } from "./ChatOverlayHosts";
import { countRollbackTurns, type RevertRestoreAvailability } from "./revertConfirm.logic";
import { resolveRewindRoute } from "./stopAndRewind.logic";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage } from "./chatViewSend";
import { makeThreadErrorSetter } from "../ChatView.logic";
interface TimelineRewindInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: ThreadStructure | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly supportsConversationRollback: boolean;
  /** The server stops a running thread and rewinds it in one command. */
  readonly supportsStopAndRollback: boolean;
  /** The server marks cancelled and in-progress rewinds on the thread. */
  readonly supportsRollbackMarkers: boolean;
  /** A rewind is waiting on this thread for its run to stop. */
  readonly hasPendingRollback: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Going back in a thread's timeline: reverting to an earlier turn (restoring that message into
 * the composer) and forking a new thread from a run.
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const {
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    timelineMessages,
    phase,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    supportsStopAndRollback,
    supportsRollbackMarkers,
    hasPendingRollback,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
  } = input;
  const navigate = useNavigate();
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const checkCheckpointRestore = useAtomQueryRunner(
    orchestrationEnvironment.checkpointRestoreSafety,
    { reportFailure: false, reportDefect: false, refresh: true },
  );
  const pendingPrecheckRef = useRef<{
    readonly id: number;
    readonly messageId: MessageId;
  } | null>(null);

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const stopAndRollbackThread = useOrchestrationCommand(threadEnvironment.stopAndRollback, {
    reportFailure: false,
  });
  const cancelPendingRollbackCommand = useOrchestrationCommand(
    threadEnvironment.cancelPendingRollback,
    { reportFailure: false },
  );
  // The wait of the rewind this client started, so Cancel can end it without a message.
  const rewindAbortRef = useRef<AbortController | null>(null);
  // True while this client waits on a rewind that stops a running thread first.
  const [stopRewindActive, setStopRewindActive] = useState(false);
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });

  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    restoreFiles?: boolean,
  ) => {
    const localApi = readLocalApi();
    if (
      !localApi ||
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const message = timelineMessages.find((message) => message.id === messageId);
    if (!message || message.role !== "user") return;

    if (!supportsConversationRollback) {
      setThreadError(activeThread.id, "这个智能体不支持回退会话记录。请改为新建会话。");
      return;
    }
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `请先重新连接 ${activeEnvironmentUnavailableLabel}，再回退。`,
      );
      return;
    }
    const route = resolveRewindRoute({
      runActive: phase === "running",
      sendBusy: isSendBusy,
      supportsStopAndRollback,
      pendingRollback: hasPendingRollback,
    });
    if (route.kind === "blocked") {
      setThreadError(activeThread.id, route.message);
      return;
    }
    const whileRunning = route.kind === "stop-and-rollback";
    if (restoreFiles === undefined) {
      if (pendingPrecheckRef.current?.messageId === messageId) return;
      const precheckId = (pendingPrecheckRef.current?.id ?? 0) + 1;
      pendingPrecheckRef.current = { id: precheckId, messageId };
      const fallbackTurnCount = countRollbackTurns(serverProjection?.runs ?? [], turnCount);
      const result = await checkCheckpointRestore({
        environmentId,
        input: { threadId: activeThread.id, turnCount },
      });
      if (pendingPrecheckRef.current?.id !== precheckId) return;
      pendingPrecheckRef.current = null;
      if (currentRouteThreadKeyRef.current !== routeThreadKey) return;
      const availability: RevertRestoreAvailability =
        result._tag === "Success"
          ? result.value.canRestoreFiles
            ? { status: "ready" }
            : {
                status: "blocked",
                reason: result.value.reason,
                ...(result.value.inProjectDirectory === undefined
                  ? {}
                  : { inProjectDirectory: result.value.inProjectDirectory }),
              }
          : { status: "unavailable" };
      const removedTurnCount =
        result._tag === "Success" ? result.value.removedTurnCount : fallbackTurnCount;
      openRevertConfirm(routeThreadKey, {
        turnCount,
        messageId,
        availability,
        removedTurnCount,
        whileRunning,
      });
      return;
    }

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const abort = whileRunning ? new AbortController() : null;
    rewindAbortRef.current = abort;
    setStopRewindActive(whileRunning);
    const rewind = await rewindToMessage({
      message,
      environmentId,
      routeThreadRef,
      threadId: activeThread.id,
      turnCount,
      restoreFiles,
      // Keep the live checkpoint identity when command context refetches a bounded window.
      checkpoint: findRevertCheckpoint(serverProjection?.checkpoints ?? [], turnCount),
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      ...(abort === null
        ? {}
        : {
            stopAndRollback: {
              send: stopAndRollbackThread,
              signal: abort.signal,
              markers: supportsRollbackMarkers,
            },
          }),
      revertThreadCheckpoint,
    });
    if (rewindAbortRef.current === abort) {
      rewindAbortRef.current = null;
      setStopRewindActive(false);
    }
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
    if (rewind.error !== null) {
      setThreadError(activeThread.id, rewind.error);
      return;
    }
    if (rewind.cancelled === true) return;
    if (currentRouteThreadKeyRef.current === routeThreadKey) {
      const nextPrompt = rewind.prompt;
      promptRef.current = nextPrompt;
      composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
      requestAnimationFrame(() => {
        if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
      });
    }
  };
  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);
  const onConfirmRevert = (turnCount: number, messageId: MessageId, restoreFiles: boolean) => {
    void onRevertToTurnCount(turnCount, messageId, restoreFiles);
  };
  const onConfirmRevertStable = useStableCallback(onConfirmRevert);

  const onCancelRollback = async () => {
    if (!activeThread) return;
    // End our own wait first, so an outcome that lands after Cancel shows nothing.
    rewindAbortRef.current?.abort();
    const result = await cancelPendingRollbackCommand({
      environmentId,
      input: { threadId: activeThread.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "无法取消回退。请重试。",
      );
    }
  };
  const onCancelRollbackStable = useStableCallback(onCancelRollback);

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${activeThread.title}（分叉）`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "无法从这条回复分叉。",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "分叉已创建，但会话数据没有同步到此客户端。请重新连接，然后从侧边栏打开。",
      );
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  return {
    stopRewindActive,
    onCancelRollbackStable,
    onConfirmRevertStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
  };
}
