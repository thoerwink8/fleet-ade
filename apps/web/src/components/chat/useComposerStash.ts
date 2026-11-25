import type { ChatComposerProps } from "./ChatComposer";
import {
  type ComposerContextRecord,
  type EnvironmentContextRecord,
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type PreviewAnnotationPayload,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import {
  type ComposerFileAttachment,
  type ComposerThreadDraftState,
  type PersistedComposerFileAttachment,
  type PersistedComposerImageAttachment,
  composerFileDedupKey,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  composerTargetKey,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";
import {
  MAX_STASH_ENTRIES,
  type PromptStashEntry,
  partitionStashAttachments,
  usePromptStashStore,
} from "../../promptStashStore";
import { deleteStashEntryWithUndo, registerEvictedStashUndo } from "./composerStashUndo";
import { type PendingUserInput } from "../../session-logic";
import { type ReviewCommentContext } from "../../reviewCommentContext";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { collectComposerPromptInlineTokens } from "../../composer-editor-mentions";
import { compressImageForStash } from "../../lib/imageCompression";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { pendingDraftWork } from "./pendingDraftWork";
import {
  isResponseContextRecord,
  previewAnnotationContextRecord,
  reviewCommentContextRecord,
  terminalContextRecord,
} from "~/lib/composerContextRecords";
import { randomUUID } from "~/lib/utils";
import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  releaseAttachmentUpload,
  releasePersistedAttachmentUpload,
  verifyStashedAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import {
  countPreparingComposerImages,
  getPreparingComposerImageFailure,
  whenPreparingComposerImagesIdle,
} from "./preparingComposerImages";
import { cancelPendingComposerSend, PENDING_SEND_STASH_NOTICE } from "./pendingComposerSend.logic";
import { stashWaitReason, waitForStashReadiness } from "./composerStashReadiness.logic";
import { remainingComposerAttachmentSlots } from "./composerThreadImport";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { registerCommands } from "../../shortcuts/dispatcher";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { toastManager } from "../ui/toast";
import type { useComposerTriggerState } from "./useComposerTriggerState";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { isInSideChatPane } from "../../lib/sideChatPane";
import { useStableCallback } from "../../hooks/useStableCallback";

/**
 * The prompt stash: saving the draft aside, restoring or deleting an entry, the badge pulse,
 * and the stash shortcut. Its state lives here so the composer body only wires it up.
 */
export function useComposerStash(input: {
  readonly environmentId: EnvironmentId;
  readonly composerDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly promptRef: ChatComposerProps["promptRef"];
  readonly readAttachmentDraft: () => Pick<ComposerThreadDraftState, "images" | "files">;
  readonly readTerminalContexts: () => ComposerThreadDraftState["terminalContexts"];
  readonly routeThreadRef: ChatComposerProps["routeThreadRef"];
  readonly projectSelectionRequired: boolean;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly activePendingProgress: ChatComposerProps["activePendingProgress"];
  readonly prompt: string;
  readonly composerMenuOpen: boolean;
  readonly isComposerCollapsedMobile: boolean;
  readonly composerPreviewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly composerReviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly composerThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly composerEnvironmentContexts: ReadonlyArray<EnvironmentContextRecord>;
  readonly attachmentTargetKey: string;
  readonly isComposerDraftTargetOpen: (targetKey: string) => boolean;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly isRevertingCheckpoint: () => boolean;
  readonly pendingThreadImportsRef: RefObject<Map<string, number>>;
  readonly setComposerCursor: Dispatch<SetStateAction<number>>;
  readonly setComposerTrigger: ReturnType<typeof useComposerTriggerState>["setTrigger"];
  readonly importContextRecords: (
    records: ReadonlyArray<ComposerContextRecord>,
    sourceEnvironmentId: EnvironmentId | null,
    threadDraftTarget?: ChatComposerProps["composerDraftTarget"],
  ) => ReadonlyMap<string, string>;
  readonly expandMobileComposer: () => void;
}) {
  const {
    environmentId,
    composerDraftTarget,
    promptRef,
    readAttachmentDraft,
    readTerminalContexts,
    routeThreadRef,
    projectSelectionRequired,
    pendingUserInputs,
    activePendingProgress,
    prompt,
    composerMenuOpen,
    isComposerCollapsedMobile,
    composerPreviewAnnotations,
    composerReviewComments,
    composerThreadContexts,
    composerEnvironmentContexts,
    attachmentTargetKey,
    isComposerDraftTargetOpen,
    composerEditorRef,
    isRevertingCheckpoint,
    pendingThreadImportsRef,
    setComposerCursor,
    setComposerTrigger,
    importContextRecords,
    expandMobileComposer,
  } = input;
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftReplyTo = useComposerDraftStore((store) => store.setReplyTo);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.clearTerminalContexts,
  );
  const clearComposerDraftPromptAndImages = useComposerDraftStore(
    (store) => store.clearComposerPromptAndImages,
  );
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const setComposerDraftEnvironmentContexts = useComposerDraftStore(
    (store) => store.setEnvironmentContexts,
  );
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  const stashInFlightRef = useRef<Set<string>>(new Set());
  const pendingStashAbortRef = useRef<{
    readonly targetKey: string;
    readonly controller: AbortController;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts a pending stash wait if the composer switches drafts or unmounts
  useEffect(() => {
    return () => {
      if (pendingStashAbortRef.current?.targetKey === attachmentTargetKey) {
        pendingStashAbortRef.current.controller.abort();
        pendingStashAbortRef.current = null;
      }
    };
  }, [attachmentTargetKey]);

  const stashQueue = usePromptStashStore((state) => state.entries);
  const stashPulseKey = usePromptStashStore((state) => state.stashSeq);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);

  const restoreStashEntry = async (menuEntry: PromptStashEntry) => {
    const filesToVerify = menuEntry.files ?? [];
    if (filesToVerify.some((file) => file.environmentId !== environmentId)) {
      toastManager.add({
        type: "error",
        title: "暂存的文件属于另一台电脑",
        description: "请在收到这些文件的电脑上恢复这条提示词。",
      });
      return;
    }
    cancelPendingComposerSend(composerTargetKey(composerDraftTarget), PENDING_SEND_STASH_NOTICE);
    setIsStashMenuOpen(false);

    // An expired upload restores as a needs-reattach row instead of a reference
    // the next send would fail to verify. Verify BEFORE taking: the take
    // removes the entry from durable storage, and a tab closed during this
    // await must still find it there after reload.
    const verifications = await Promise.all(
      filesToVerify.map((file) =>
        verifyStashedAttachmentUpload({ environmentId, attachmentId: file.attachmentId }),
      ),
    );
    const expiredAttachmentIds = new Set(
      filesToVerify
        .filter((_, index) => verifications[index]?.status === "missing")
        .map((file) => file.attachmentId),
    );

    // A thread switch during the verify await would mix the new thread's
    // prompt with this invocation's captured target. Nothing was taken yet,
    // so abort and leave the entry restorable where the user now is.
    if (
      isRevertingCheckpoint() ||
      !isComposerDraftTargetOpen(composerTargetKey(composerDraftTarget))
    ) {
      return;
    }
    cancelPendingComposerSend(composerTargetKey(composerDraftTarget), PENDING_SEND_STASH_NOTICE);

    const { entry, durable } = takeStashEntry(menuEntry.id);
    if (!entry) return;
    if (!durable) {
      toastManager.add({
        type: "warning",
        title: "已恢复的提示词可能会再次出现在暂存中",
        description: "浏览器存储拒绝了这次更新，所以刷新后这条记录可能仍在。",
        data: { hideCopyButton: true },
      });
    }

    const rewrittenContextIds = entry.records
      ? importContextRecords(entry.records, null, composerDraftTarget)
      : new Map<string, string>();
    // A reply only makes sense in the thread that holds the response, and one already pending wins.
    const stashedReply = entry.records?.find(isResponseContextRecord);
    if (
      stashedReply &&
      !getComposerDraft(composerDraftTarget)?.replyTo &&
      typeof composerDraftTarget !== "string" &&
      stashedReply.citation.threadId === composerDraftTarget.threadId &&
      stashedReply.citation.environmentId === composerDraftTarget.environmentId
    ) {
      setComposerDraftReplyTo(composerDraftTarget, stashedReply);
    }
    const restoredPrompt = replaceComposerContextReferences(entry.prompt, (reference) => {
      const contextId = rewrittenContextIds.get(reference.contextId);
      return contextId
        ? formatInlineContextReference({
            ...reference,
            contextId,
            kind: reference.kind === "element" ? "preview-annotation" : reference.kind,
          })
        : reference.source;
    });
    const currentPrompt = promptRef.current;
    const nextPrompt =
      restoredPrompt.length === 0
        ? currentPrompt
        : currentPrompt.trim().length
          ? `${currentPrompt.replace(/\s+$/, "")}\n\n${restoredPrompt}`
          : restoredPrompt;
    let promptChanged = nextPrompt !== currentPrompt;
    if (promptChanged) {
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(null);
    }

    let unrestoredFileNames: string[] = [];
    const expiredFileNames: string[] = [];
    let restoredFileCount = 0;
    const stashedFiles = entry.files ?? [];
    if (stashedFiles.length > 0) {
      const composerFilesNow = readAttachmentDraft().files;
      const existingFileIds = new Set(composerFilesNow.map((file) => file.id));
      const retainedUploadIds = new Set(
        composerFilesNow.flatMap((file) =>
          file.uploadedAttachmentId ? [file.uploadedAttachmentId] : [],
        ),
      );
      const existingFileKeys = new Set(composerFilesNow.map(composerFileDedupKey));
      const reattachMarkers = composerFilesNow.filter(composerFileNeedsReattach);
      const restoredMarkerIds = new Set<string>();
      const duplicateFiles: PersistedComposerFileAttachment[] = [];
      const markerReplacements: ComposerFileAttachment[] = [];
      const appendedFiles: ComposerFileAttachment[] = [];
      for (const file of stashedFiles) {
        const expired = expiredAttachmentIds.has(file.attachmentId);
        const key = composerFileDedupKey(file);
        const restored: ComposerFileAttachment = {
          type: "file",
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          file: null,
          ...(file.source ? { source: file.source } : {}),
          ...(expired
            ? {}
            : { uploadedAttachmentId: file.attachmentId, uploadEnvironmentId: environmentId }),
        };
        if (existingFileIds.has(file.id)) {
          if (!expired && !retainedUploadIds.has(file.attachmentId)) {
            duplicateFiles.push(file);
          }
          continue;
        }
        const reattachMarker = reattachMarkers.find(
          (marker) =>
            !restoredMarkerIds.has(marker.id) && composerFileMatchesReattachMarker(marker, file),
        );
        if (reattachMarker) {
          restoredMarkerIds.add(reattachMarker.id);
          existingFileIds.add(file.id);
          existingFileKeys.add(key);
          if (expired) {
            expiredFileNames.push(file.name);
          } else {
            retainedUploadIds.add(file.attachmentId);
            markerReplacements.push(restored);
          }
          continue;
        }
        if (existingFileKeys.has(key)) {
          if (!expired && !retainedUploadIds.has(file.attachmentId)) {
            duplicateFiles.push(file);
          }
          continue;
        }
        existingFileIds.add(file.id);
        existingFileKeys.add(key);
        if (expired) {
          expiredFileNames.push(file.name);
        } else {
          retainedUploadIds.add(file.attachmentId);
        }
        appendedFiles.push(restored);
      }
      const capacity = remainingComposerAttachmentSlots(
        readAttachmentDraft().images.length + composerFilesNow.length,
        pendingThreadImportsRef.current.get(composerTargetKey(composerDraftTarget)) ?? 0,
      );
      const filesToAppend = appendedFiles.slice(0, capacity);
      const skippedFiles = appendedFiles.slice(capacity);
      unrestoredFileNames = skippedFiles.map((file) => file.name);
      // A non-durable take can resurrect the stash entry after a reload;
      // deleting these uploads would leave it pointing at nothing.
      if (durable) {
        for (const file of duplicateFiles) {
          releasePersistedAttachmentUpload({
            id: file.id,
            environmentId,
            attachmentId: file.attachmentId,
          });
        }
        for (const file of skippedFiles) {
          if (file.uploadedAttachmentId) {
            releasePersistedAttachmentUpload({
              id: file.id,
              environmentId,
              attachmentId: file.uploadedAttachmentId,
            });
          }
        }
      }
      const restoredFiles = [...markerReplacements, ...filesToAppend];
      if (restoredFiles.length > 0) {
        addComposerDraftFiles(composerDraftTarget, restoredFiles, { appendReference: true });
        const restoredFilePrompt = getComposerDraft(composerDraftTarget)?.prompt;
        if (restoredFilePrompt !== undefined && restoredFilePrompt !== promptRef.current) {
          promptRef.current = restoredFilePrompt;
          setComposerCursor(
            collapseExpandedComposerCursor(restoredFilePrompt, restoredFilePrompt.length),
          );
          setComposerTrigger(null);
          promptChanged = true;
        }
        restoredFileCount = filesToAppend.length;
      }
    }

    let unrestoredImageNames: string[] = [];
    if (entry.attachments.length > 0) {
      const attachmentDraft = readAttachmentDraft();
      const existingIds = new Set(attachmentDraft.images.map((image) => image.id));
      // The draft store also dedupes by mimeType+sizeBytes+name, so filter
      // on the same key here. Counting a duplicate against capacity would
      // burn a slot the store then refuses to fill, pushing a genuinely
      // unique image into the overflow list for nothing.
      const existingDedupKeys = new Set(
        attachmentDraft.images.map(
          (image) => `${image.mimeType}\0${image.sizeBytes}\0${image.name}`,
        ),
      );
      const capacity = remainingComposerAttachmentSlots(
        attachmentDraft.images.length + attachmentDraft.files.length + restoredFileCount,
        pendingThreadImportsRef.current.get(composerTargetKey(composerDraftTarget)) ?? 0,
      );
      const pending = entry.attachments.filter(
        (attachment) =>
          !existingIds.has(attachment.id) &&
          !existingDedupKeys.has(
            `${attachment.mimeType}\0${attachment.sizeBytes}\0${attachment.name}`,
          ),
      );
      unrestoredImageNames = pending.slice(capacity).map((attachment) => attachment.name);
      const restoredImages = hydrateImagesFromPersisted(pending.slice(0, capacity));
      if (restoredImages.length > 0) {
        addComposerDraftImages(composerDraftTarget, restoredImages);
      }
    }

    const missingImageReasons: string[] = [];
    if (entry.droppedImageNames.length > 0) {
      missingImageReasons.push(
        `保存这条提示词时，${entry.droppedImageNames.join(", ")} 超出了暂存大小限制。`,
      );
    }
    if (entry.unreadableImageNames && entry.unreadableImageNames.length > 0) {
      missingImageReasons.push(
        `保存这条提示词时，无法读取 ${entry.unreadableImageNames.join(", ")}。`,
      );
    }
    if (unrestoredImageNames.length > 0) {
      missingImageReasons.push(
        `无法恢复 ${unrestoredImageNames.join(", ")}：输入框已达到 ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} 个附件的上限。`,
      );
    }
    if (unrestoredFileNames.length > 0) {
      missingImageReasons.push(
        `无法恢复 ${unrestoredFileNames.join(", ")}：输入框已达到 ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} 个附件的上限。`,
      );
    }
    if (expiredFileNames.length > 0) {
      missingImageReasons.push(
        `${expiredFileNames.join(", ")}：暂存的文件只保留 24 小时，这次上传已过期，请重新添加文件。`,
      );
    }
    if (missingImageReasons.length > 0) {
      toastManager.add({
        type: "warning",
        title: "无法恢复部分附件",
        description: missingImageReasons.join(" "),
      });
    }

    if (promptChanged) {
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAtEnd();
      });
    }
  };
  const restoreStashEntryStable = useStableCallback(restoreStashEntry);

  const restoreStashEntryById = async (entryId: string) => {
    const entry = usePromptStashStore
      .getState()
      .entries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      toastManager.add({
        type: "info",
        title: "这条暂存已不在列表中",
        description: "它可能已经被恢复或删除了。",
        data: { hideCopyButton: true },
      });
      return;
    }
    await restoreStashEntry(entry);
  };
  const restoreStashEntryByIdStable = useStableCallback(restoreStashEntryById);

  const deleteStashEntry = (entry: PromptStashEntry) => {
    const { deleted, remainingCount } = deleteStashEntryWithUndo(entry);
    if (deleted && remainingCount === 0) {
      setIsStashMenuOpen(false);
    }
  };
  const deleteStashEntryStable = useStableCallback(deleteStashEntry);

  const stashCurrentPrompt = async () => {
    const stashTarget = composerDraftTarget;
    cancelPendingComposerSend(composerTargetKey(stashTarget), PENDING_SEND_STASH_NOTICE);
    if (pendingStashAbortRef.current?.targetKey === attachmentTargetKey) return;

    const readUploadingFileIds = () =>
      readAttachmentDraft()
        .files.filter((file) => {
          if (composerFileNeedsReattach(file)) return false;
          const upload = readAttachmentUpload(file.id);
          return (
            upload === undefined ||
            (upload.status === "uploading" && upload.environmentId === environmentId)
          );
        })
        .map((file) => file.id);

    const waitReason = stashWaitReason({
      preparingImages: countPreparingComposerImages(attachmentTargetKey) > 0,
      loadingContext: pendingDraftWork.has(attachmentTargetKey),
      uploadingFiles: readUploadingFileIds().length > 0,
    });
    if (waitReason !== null) {
      const contextFailureBaseline =
        pendingDraftWork.lastFailure(attachmentTargetKey)?.sequence ?? 0;
      const imageFailureBaseline =
        getPreparingComposerImageFailure(attachmentTargetKey)?.sequence ?? 0;
      const controller = new AbortController();
      pendingStashAbortRef.current = { targetKey: attachmentTargetKey, controller };
      const waitingToastId = toastManager.add({
        type: "loading",
        title: "正在准备暂存…",
        description: waitReason,
        timeout: 0,
        data: { hideCopyButton: true },
        actionProps: {
          children: "取消",
          onClick: () => controller.abort(),
        },
      });
      const ready = await waitForStashReadiness({
        isLoadingContext: () => pendingDraftWork.has(attachmentTargetKey),
        waitForContextIdle: (signal) => pendingDraftWork.whenIdle(attachmentTargetKey, signal),
        isPreparingImages: () => countPreparingComposerImages(attachmentTargetKey) > 0,
        waitForImagesIdle: (signal) => whenPreparingComposerImagesIdle(attachmentTargetKey, signal),
        readUploadingFileIds,
        waitForFileUploads: (ids) => awaitAttachmentUploads(ids),
        signal: controller.signal,
      });
      toastManager.close(waitingToastId);
      if (pendingStashAbortRef.current?.controller === controller) {
        pendingStashAbortRef.current = null;
      }
      if (!ready || !isComposerDraftTargetOpen(composerTargetKey(stashTarget))) {
        return;
      }
      const nextContextFailure = pendingDraftWork.lastFailure(attachmentTargetKey);
      const nextImageFailure = getPreparingComposerImageFailure(attachmentTargetKey);
      if (
        (nextContextFailure && nextContextFailure.sequence > contextFailureBaseline) ||
        (nextImageFailure && nextImageFailure.sequence > imageFailureBaseline)
      ) {
        toastManager.add({
          type: "error",
          title: "附件未准备完成，未能暂存",
          description: "内容还在输入框里，请处理失败的附件或上下文后重试。",
        });
        return;
      }
    }

    const latestDraft = getComposerDraft(stashTarget);
    const replyTo = latestDraft?.replyTo;
    const trimmedPrompt = promptRef.current.trim();
    // A trailing chip only parses with whitespace after it, so keep one space to restore it.
    const endsWithChip =
      collectComposerPromptInlineTokens(promptRef.current).at(-1)?.end ===
      promptRef.current.trimEnd().length;
    const prompt = endsWithChip ? `${trimmedPrompt} ` : trimmedPrompt;
    const attachmentDraft = readAttachmentDraft();
    const images = [...attachmentDraft.images];
    const files = [...attachmentDraft.files];
    const latestThreadContexts = latestDraft?.threadContexts ?? composerThreadContexts;
    const latestEnvironmentContexts =
      latestDraft?.environmentContexts ?? composerEnvironmentContexts;
    const latestReviewComments = latestDraft?.reviewComments ?? composerReviewComments;
    const latestPreviewAnnotations = latestDraft?.previewAnnotations ?? composerPreviewAnnotations;
    const stashedRecords: ComposerContextRecord[] = [
      ...(replyTo ? [replyTo] : []),
      ...latestThreadContexts,
      ...latestEnvironmentContexts,
      ...readTerminalContexts().map(terminalContextRecord),
      ...latestReviewComments.map(reviewCommentContextRecord),
      ...latestPreviewAnnotations.map((annotation) =>
        previewAnnotationContextRecord(annotation, {
          screenshotContextId: images.some((image) => image.id === annotation.id)
            ? annotation.id
            : undefined,
        }),
      ),
    ];
    if (prompt.length === 0 && images.length === 0 && files.length === 0) {
      const entries = usePromptStashStore.getState().entries;
      const entry = entries.length === 1 ? entries[0] : undefined;
      if (entry && !entry.pendingImageCount) {
        await restoreStashEntry(entry);
      } else {
        setIsStashMenuOpen((open) => !open);
      }
      return;
    }
    const stashedFiles: PersistedComposerFileAttachment[] = [];
    for (const file of files) {
      if (composerFileNeedsReattach(file)) {
        toastManager.add({
          type: "error",
          title: "暂存前请重新添加丢失的文件，或将其移除",
        });
        return;
      }
      const upload = readAttachmentUpload(file.id);
      if (upload?.status !== "ready" || upload.environmentId !== environmentId) {
        toastManager.add({
          type: "error",
          title: "文件上传未完成，无法暂存",
          description: "内容还在输入框里。请确认电脑已连接并重试上传，或移除该文件后再暂存。",
        });
        return;
      }
      stashedFiles.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        attachmentId: upload.attachmentId,
        environmentId,
        ...(file.source ? { source: file.source } : {}),
      });
    }
    // Deduplicate the snapshot while encoding, not all stashes: new drafts or
    // thread switches must still be able to create their own entries.
    const attachmentKey = images
      .map((image) => `image:${image.id}`)
      .concat(files.map((file) => `file:${file.id}`))
      .join(",");
    const snapshotKey = [String(stashTarget), prompt, attachmentKey].join("\n");
    if (stashInFlightRef.current.has(snapshotKey)) return;
    stashInFlightRef.current.add(snapshotKey);

    const entryId = randomUUID();
    const stashAndEncode = async () => {
      // Ordering matters in both directions: writing before clearing means a
      // crash or closed tab mid-encode still leaves the prompt recoverable,
      // while clearing before the async image work means edits typed during
      // encoding are not wiped.
      const { evicted, written, durable } = stashEntryToQueue({
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt,
        attachments: [],
        ...(stashedFiles.length > 0 ? { files: stashedFiles } : {}),
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
        ...(stashedRecords.length > 0 ? { records: stashedRecords } : {}),
      });

      // If it was rejected (quota) the store has already rolled itself back,
      // so leave the composer untouched rather than making it the second
      // casualty of a reload.
      if (!written) {
        toastManager.add({
          type: "error",
          title: "无法暂存这条提示词",
          description: "浏览器存储拒绝了写入，输入框保持原样。请清理网站数据后重试。",
          data: { hideCopyButton: true },
        });
        return;
      }
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "刷新后暂存的提示词将会丢失",
          description: "浏览器存储不可用，这次暂存只保存在内存中，关闭页面后就会丢失。",
          data: { hideCopyButton: true },
        });
      }

      promptRef.current = "";
      clearComposerDraftPromptAndImages(stashTarget);
      clearComposerDraftTerminalContexts(stashTarget);
      setComposerDraftThreadContexts(stashTarget, []);
      setComposerDraftEnvironmentContexts(stashTarget, []);
      setComposerDraftReplyTo(stashTarget, null);
      for (const comment of latestReviewComments) {
        removeComposerDraftReviewComment(stashTarget, comment.id);
      }
      for (const annotation of latestPreviewAnnotations) {
        releaseAttachmentUpload(annotation.id);
        removeComposerDraftPreviewAnnotation(stashTarget, annotation.id);
      }
      setComposerDraftPrompt(stashTarget, "");
      for (const image of images) {
        releaseAttachmentUpload(image.id);
      }
      setComposerCursor(0);
      setComposerTrigger(null);

      if (evicted) {
        const lastRemaining = usePromptStashStore.getState().entries.at(-1);
        registerEvictedStashUndo(evicted, {
          index: MAX_STASH_ENTRIES,
          beforeId: null,
          afterId: lastRemaining?.id ?? null,
        });
      }

      // Images are re-encoded for the stash rather than stored verbatim: the
      // composer allows up to 10MB per image, but localStorage gives the whole
      // origin ~5MB.
      const candidateAttachments: PersistedComposerImageAttachment[] = [];
      const oversizedImageNames: string[] = [];
      const unreadableImageNames: string[] = [];
      for (const image of images) {
        const result = await compressImageForStash(image.file);
        if (!result.ok) {
          (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(
            image.name,
          );
          continue;
        }
        candidateAttachments.push({
          id: image.id,
          name: image.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
        });
      }
      const { kept, droppedNames } = partitionStashAttachments(candidateAttachments);

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...oversizedImageNames, ...droppedNames],
        unreadableImageNames,
      });
      if (attached) {
        if (!imagesDurable && durable && images.length > 0) {
          toastManager.add({
            type: "warning",
            title: "无法保存暂存的图片",
            description: "提示词已暂存，但浏览器存储拒绝了其中的图片，刷新后图片会丢失。",
            data: { hideCopyButton: true },
          });
        }
      } else if (kept.length > 0) {
        toastManager.add({
          type: "warning",
          title: "无法附加暂存的图片",
          description: `在 ${kept.length} 张图片保存完成前，该提示词已被恢复或删除。如仍需要，请重新附加。`,
          data: { hideCopyButton: true },
        });
      }
    };
    await stashAndEncode().finally(() => stashInFlightRef.current.delete(snapshotKey));
  };
  const stashCurrentPromptStable = useStableCallback(stashCurrentPrompt);

  const toggleStashMenu = () => {
    if (isComposerCollapsedMobile) {
      expandMobileComposer();
      setIsStashMenuOpen(true);
      return;
    }
    setIsStashMenuOpen((open) => !open);
  };
  const toggleStashMenuStable = useStableCallback(toggleStashMenu);

  const [stashMenuClosesOn, setStashMenuClosesOn] = useState({ prompt, composerMenuOpen });
  if (
    stashMenuClosesOn.prompt !== prompt ||
    stashMenuClosesOn.composerMenuOpen !== composerMenuOpen
  ) {
    setStashMenuClosesOn({ prompt, composerMenuOpen });
    if (stashMenuClosesOn.prompt !== prompt || composerMenuOpen) setIsStashMenuOpen(false);
  }

  // Read at event time, so the scope registers once per mounted composer instead of
  // re-registering (and reshuffling capture-scope priority) whenever a guard flips.
  const handleStashShortcut = useStableCallback((event: KeyboardEvent) => {
    // Always claim the shortcut so the browser save dialog never opens,
    // even when the composer is in a state that can't stash.
    event.preventDefault();
    event.stopPropagation();
    if (isCommandPaletteOpen() || isRevertingCheckpoint()) return;
    if (pendingUserInputs.length > 0) {
      setIsStashMenuOpen((open) => !open);
      return;
    }
    if (projectSelectionRequired || activePendingProgress !== null) return;
    void stashCurrentPromptStable();
  });
  // Capture phase while the composer is mounted, so Mod+S never reaches the browser's save
  // dialog even when a focused widget (the model picker search) stops the key.
  const backgroundThread = use(BackgroundThreadContext);
  const readShortcutContext = useStableCallback(() => ({
    terminalOpen: Boolean(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        routeThreadRef,
      ).terminalOpen,
    ),
  }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the capture-phase stash shortcut with the command registry while the composer is mounted
  useEffect(() => {
    if (backgroundThread) return;
    return registerCommands(
      { "composer.stash": handleStashShortcut },
      {
        capture: true,
        context: readShortcutContext,
        when: (event) => !isInSideChatPane(event.target),
      },
    );
  }, [backgroundThread, handleStashShortcut, readShortcutContext]);

  return {
    stashQueue,
    isStashMenuOpen,
    setIsStashMenuOpen,
    stashPulseKey,
    restoreStashEntryStable,
    restoreStashEntryByIdStable,
    deleteStashEntryStable,
    toggleStashMenuStable,
  };
}
