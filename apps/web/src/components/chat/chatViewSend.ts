import { useSyncExternalStore } from "react";
import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ScopedThreadRef,
  type ThreadId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "@t3tools/client-runtime/errors";
import { Atom } from "effect/reactivity";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { awaitAttachmentUploads, getUploadedAttachments } from "../../lib/attachmentUploadQueue";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { randomUUID } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { newThreadId } from "~/lib/utils";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
  DraftId,
} from "../../composerDraftStore";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { createModelSelection } from "@t3tools/shared/model";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { getComposerPromptInjectionState, getComposerProviderState } from "./composerProviderState";
import { evaluateProviderInstanceReadiness } from "./composerProviderReadiness";
import {
  formatOutgoingPrompt,
  cloneComposerImageForRetry,
  type ComposerSendSnapshot,
  readFileAsDataUrl,
  prepareRevertedMessageAttachments,
  isRewindCancelledError,
  REWIND_SETTLE_MS,
  REWIND_SETTLE_WITH_FILES_MS,
  waitForRevertedMessage,
  waitForRollbackOutcome,
} from "../ChatView.logic";
import { readPreparedConnection } from "../../state/session";
import { recallableComposerPrompt } from "./composerPromptHistory";
import { formatRollbackFailureMessage } from "./revertConfirm.logic";

// Kept per route so a send in flight, and the multiple-model selections, survive
// ChatView remounting while the user navigates.
export const draftFanoutSelectionsAtom = Atom.family((_routeKey: string) =>
  Atom.make<ReadonlyArray<ModelSelection> | null>(null).pipe(Atom.keepAlive),
);
export interface DraftSendFailure {
  readonly sequence: number;
  readonly reason: string;
}

interface DraftSendEntry {
  readonly sendInFlight: { current: boolean };
  readonly uncertainSubmissions: { current: Map<string, ThreadId> };
  readonly listeners: Set<() => void>;
  inFlight: boolean;
  lastFailure: DraftSendFailure | null;
}

const draftSendStateByRouteKey = new Map<string, DraftSendEntry>();
let nextDraftSendFailureSequence = 0;

function getOrCreateDraftSendEntry(routeKey: string): DraftSendEntry {
  let entry = draftSendStateByRouteKey.get(routeKey);
  if (!entry) {
    const created: DraftSendEntry = {
      inFlight: false,
      lastFailure: null,
      listeners: new Set(),
      uncertainSubmissions: { current: new Map() },
      sendInFlight: {
        get current() {
          return created.inFlight;
        },
        set current(next: boolean) {
          if (created.inFlight === next) return;
          created.inFlight = next;
          for (const listener of created.listeners) listener();
        },
      },
    };
    draftSendStateByRouteKey.set(routeKey, created);
    entry = created;
  }
  return entry;
}

export function draftSendState(routeKey: string): {
  readonly sendInFlight: { current: boolean };
  readonly uncertainSubmissions: { current: Map<string, ThreadId> };
} {
  return getOrCreateDraftSendEntry(routeKey);
}

export function recordDraftSendFailure(routeKey: string, reason: string): void {
  const entry = getOrCreateDraftSendEntry(routeKey);
  entry.lastFailure = { sequence: ++nextDraftSendFailureSequence, reason };
  for (const listener of entry.listeners) listener();
}

export function useDraftSendInFlight(routeKey: string): boolean {
  const entry = getOrCreateDraftSendEntry(routeKey);
  return useSyncExternalStore(
    (listener) => {
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    () => entry.inFlight,
  );
}

export function useDraftSendFailure(routeKey: string): DraftSendFailure | null {
  const entry = getOrCreateDraftSendEntry(routeKey);
  return useSyncExternalStore(
    (listener) => {
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    () => entry.lastFailure,
  );
}

/**
 * Starts one thread of a multiple-model send. A request that may have
 * reached the server before failing is remembered by `retryKey`, so sending
 * again cannot silently create a duplicate thread; its failure toast offers
 * to open that thread or to allow the retry.
 */
export async function startFanoutThread(input: {
  readonly retryKey: string;
  readonly model: string;
  readonly uncertainSubmissions: Map<string, ThreadId>;
  readonly start: (threadId: ThreadId) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly openThread: (threadId: ThreadId) => void;
}): Promise<boolean> {
  const { retryKey, uncertainSubmissions } = input;
  const uncertainThreadId = uncertainSubmissions.get(retryKey);
  const targetThreadId = uncertainThreadId ?? newThreadId();
  let requestMayHaveStarted = false;
  try {
    if (uncertainThreadId) {
      throw new Error("上一次请求可能已经开始。请先打开它的会话确认，再重新发送。");
    }
    requestMayHaveStarted = true;
    const result = await input.start(targetThreadId);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      if (wasBootstrapThreadDeleted(error) || wasBootstrapThreadNotCreated(error)) {
        requestMayHaveStarted = false;
      }
      throw error;
    }
    return true;
  } catch (error) {
    if (requestMayHaveStarted && !uncertainSubmissions.has(retryKey)) {
      uncertainSubmissions.set(retryKey, targetThreadId);
    }
    const retainedThreadId = uncertainSubmissions.get(retryKey);
    const failureToastId = toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `无法启动 ${input.model}`,
        description: error instanceof Error ? error.message : "无法发送消息。",
        ...(retainedThreadId
          ? {
              timeout: 0,
              data: {
                secondaryActionProps: {
                  children: "允许重试",
                  onClick: () => {
                    void readLocalApi()
                      ?.dialogs.confirm(
                        "上一次请求可能已经在运行，请先查看它的会话。再发送一次可能会产生重复的会话。",
                        { title: "再发送一次？", confirmLabel: "仍要发送" },
                      )
                      .then(
                        (confirmed) => {
                          if (
                            confirmed &&
                            uncertainSubmissions.get(retryKey) === retainedThreadId
                          ) {
                            uncertainSubmissions.delete(retryKey);
                            toastManager.close(failureToastId);
                          }
                        },
                        () => undefined,
                      );
                  },
                },
              },
              actionProps: {
                children: "打开会话",
                onClick: () => input.openThread(retainedThreadId),
              },
            }
          : {}),
      }),
    );
    return false;
  }
}

/**
 * Reverts the thread to before `message` and puts that message's text and
 * attachments back in the composer draft. Returns the restored prompt, or the
 * error to show; on error the draft is untouched.
 */
export async function rewindToMessage(input: {
  readonly message: ChatMessage;
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly restoreFiles: boolean;
  readonly checkpoint: ReturnType<typeof findRevertCheckpoint>;
  readonly draftTarget: ScopedThreadRef | DraftId;
  readonly composerHasPendingAttachments: boolean;
  readonly createAssetUrl: Parameters<
    typeof prepareRevertedMessageAttachments
  >[0]["createAssetUrl"];
  /** Set when the thread is running: one command stops it and rewinds it. */
  readonly stopAndRollback?: {
    readonly send: (value: {
      environmentId: EnvironmentId;
      input: { commandId: CommandId; threadId: ThreadId; turnCount: number; restoreFiles: boolean };
    }) => Promise<AtomCommandResult<unknown, unknown>>;
    /** Aborted when the person cancels; the wait then ends without an error or a prompt. */
    readonly signal: AbortSignal;
  };
  readonly revertThreadCheckpoint: (value: {
    environmentId: EnvironmentId;
    input: {
      commandId: CommandId;
      threadId: ThreadId;
      turnCount: number;
      restoreFiles: boolean;
      checkpointId?: string;
      scopeId?: string;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<
  | { readonly error: string; readonly prompt?: never; readonly cancelled?: never }
  | { readonly error: null; readonly prompt: string; readonly cancelled?: never }
  | { readonly error: null; readonly cancelled: true; readonly prompt?: never }
> {
  const { message, environmentId, draftTarget } = input;
  try {
    if (input.composerHasPendingAttachments) {
      throw new Error("请等附件准备完成后再回退。");
    }
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error("电脑未连接。");
    const files = await prepareRevertedMessageAttachments({
      message,
      environmentId,
      httpBaseUrl: connection.httpBaseUrl,
      createAssetUrl: input.createAssetUrl,
    });
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(draftTarget);
    if (
      (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + files.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      throw new Error("回退前请在输入框中为这条消息的附件腾出位置。");
    }
    const commandId = CommandId.make(randomUUID());
    const stopAndRollback = input.stopAndRollback;
    if (stopAndRollback !== undefined) {
      await waitForRollbackOutcome(
        input.routeThreadRef,
        commandId,
        async () => {
          const result = await stopAndRollback.send({
            environmentId,
            input: {
              commandId,
              threadId: input.threadId,
              turnCount: input.turnCount,
              restoreFiles: input.restoreFiles,
            },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
        {
          signal: stopAndRollback.signal,
          settleMs: input.restoreFiles ? REWIND_SETTLE_WITH_FILES_MS : REWIND_SETTLE_MS,
        },
      );
    } else
      await waitForRevertedMessage(input.routeThreadRef, input.turnCount, commandId, async () => {
        const result = await input.revertThreadCheckpoint({
          environmentId,
          input: {
            commandId,
            threadId: input.threadId,
            turnCount: input.turnCount,
            restoreFiles: input.restoreFiles,
            ...(input.checkpoint === undefined
              ? {}
              : { checkpointId: input.checkpoint.id, scopeId: input.checkpoint.scopeId }),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      });
    const currentPrompt = store.getComposerDraft(draftTarget)?.prompt ?? "";
    const restoredPrompt = recallableComposerPrompt(message.text);
    const nextPrompt =
      restoredPrompt.length === 0
        ? currentPrompt
        : currentPrompt.length > 0
          ? `${currentPrompt}\n\n${restoredPrompt}`
          : restoredPrompt;
    store.setPrompt(draftTarget, nextPrompt);
    const images: ComposerImageAttachment[] = [];
    const restoredFiles: ComposerFileAttachment[] = [];
    files.forEach((file, index) => {
      const attachment = {
        id: randomUUID(),
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      };
      if (message.attachments?.[index]?.type === "image") {
        images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
      } else {
        restoredFiles.push({ ...attachment, type: "file" });
      }
    });
    store.addImages(draftTarget, images, { allowDuplicates: true });
    store.addFiles(draftTarget, restoredFiles, { allowDuplicates: true });
    return { error: null, prompt: nextPrompt };
  } catch (error) {
    if (isRewindCancelledError(error)) return { error: null, cancelled: true };
    return { error: formatRollbackFailureMessage(error) };
  }
}

/**
 * Writes a failed send's composer contents back into its draft. Returns the
 * restored images, which are fresh copies so their preview URLs outlive the
 * optimistic row that held the originals.
 */
export function restoreComposerDraft(
  draftTarget: ScopedThreadRef | DraftId,
  snapshot: ComposerSendSnapshot,
): ComposerImageAttachment[] {
  const store = useComposerDraftStore.getState();
  const images = snapshot.images.map(cloneComposerImageForRetry);
  store.setPrompt(draftTarget, snapshot.draftText);
  store.setReplyTo(draftTarget, snapshot.replyTo);
  store.addImages(draftTarget, images);
  store.addFiles(draftTarget, snapshot.files);
  store.setTerminalContexts(draftTarget, snapshot.terminalContexts);
  store.setPreviewAnnotations(draftTarget, snapshot.previewAnnotations);
  store.setReviewComments(draftTarget, snapshot.reviewComments);
  store.setThreadContexts(draftTarget, snapshot.threadContexts);
  store.setEnvironmentContexts(draftTarget, snapshot.environmentContexts);
  return images;
}

export interface MultipleModelTarget {
  readonly selection: ModelSelection;
  readonly text: string;
}

/**
 * The thread each selected model starts for a multiple-model send, in
 * selection order, or why that model cannot take the message.
 */
export function resolveMultipleModelTargets(input: {
  readonly selections: ReadonlyArray<ModelSelection>;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly messageText: string;
}): Array<MultipleModelTarget | { readonly error: string }> {
  const { messageText } = input;
  return input.selections.map((selection) => {
    const provider = input.providerInstanceEntries.find(
      (entry) => entry.instanceId === selection.instanceId,
    );
    if (!provider) {
      return { error: `${selection.model} 对应的智能体暂不可用。` };
    }
    const readinessBlock = evaluateProviderInstanceReadiness(provider.snapshot, selection.model);
    if (readinessBlock) {
      return { error: readinessBlock.reason };
    }
    if (!provider.enabled || !provider.isAvailable || provider.status === "disabled") {
      return { error: `${selection.model} 对应的智能体暂不可用。` };
    }
    const providerState = getComposerProviderState({
      provider: provider.driverKind,
      model: selection.model,
      models: provider.models,
      modelOptions: selection.options,
      promptInjectionState: getComposerPromptInjectionState(messageText),
    });
    return {
      selection: createModelSelection(
        selection.instanceId,
        selection.model,
        providerState.modelOptionsForDispatch,
      ),
      text: formatOutgoingPrompt({
        provider: provider.driverKind,
        model: selection.model,
        models: provider.models,
        effort: providerState.promptEffort,
        text: messageText || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      }),
    };
  });
}

/**
 * The attachments a turn sends: the server's upload records when it takes uploads, otherwise
 * images inlined as data URLs. Waits for in-flight uploads; rejects when one cannot go out.
 */
export function prepareTurnAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  readonly usesAttachmentUploads: boolean;
}) {
  const { environmentId, usesAttachmentUploads } = input;
  return Promise.all(
    input.attachments.map(async (attachment) => {
      if (usesAttachmentUploads) {
        await awaitAttachmentUploads([attachment.id]);
        const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
        if (!uploaded) {
          throw new Error(`附件“${attachment.name}”上传失败。`);
        }
        return uploaded;
      }
      if (attachment.type !== "image") {
        throw new Error("这个后台服务不支持文件附件。");
      }
      return {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: await readFileAsDataUrl(attachment.file),
      };
    }),
  );
}
