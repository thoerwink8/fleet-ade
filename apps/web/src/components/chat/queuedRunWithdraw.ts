import {
  type ChatAttachment,
  type EnvironmentContextRecord,
  type EnvironmentId,
  type MessageId,
  type OrchestrationMessageContext,
  type PreviewAnnotationPayload,
  type ResponseContextRecord,
  type RunId,
  type ThreadContextRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { stripAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { readAttachmentUpload } from "../../lib/attachmentUploadQueue";
import type { AttachmentUploadState } from "../../lib/attachmentUploadState";
import {
  isResponseContextRecord,
  previewAnnotationFromRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
} from "../../lib/composerContextRecords";
import {
  collectInlineContextIds,
  producerIdFromComposerContextId,
  removeInlineContextReference,
} from "../../lib/composerContextReferences";
import type { CompressStashImageResult } from "../../lib/imageCompression";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { randomUUID } from "../../lib/utils";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { autoStashDraftContent, formatAutoStashNoticeDescription } from "./composerAutoStash";
import { downloadServerAttachment, uploadFileAttachmentForStash } from "./queuedAttachmentTransfer";

export interface WithdrawQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}

export interface WithdrawnComposerDraftPayload {
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
}

export interface RecoverWithdrawnQueuedRunInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadDraftTarget: ComposerThreadTarget;
  /** True when something else owns the composer (e.g., editing another queued run or open question). */
  readonly isComposerOccupied: boolean;
  readonly request: WithdrawQueuedRunRequest;
  readonly onRestoredToComposer?: (restored: WithdrawnComposerDraftPayload) => void;
  readonly onRestoreStashEntry?: (entryId: string) => void | Promise<void>;
}

export interface RecoverWithdrawnQueuedRunDeps {
  readonly downloadAttachment?: (attachment: ChatAttachment) => Promise<File | null>;
  readonly uploadFileForStash?: (
    file: ComposerFileAttachment,
  ) => Promise<AttachmentUploadState | undefined>;
  readonly compressImage?: (file: File) => Promise<CompressStashImageResult>;
  readonly createId?: () => string;
  readonly now?: () => string;
}

export type RecoverWithdrawnQueuedRunResult =
  | {
      readonly destination: "composer";
      readonly failedAttachmentNames: ReadonlyArray<string>;
    }
  | {
      readonly destination: "stash";
      readonly entryId: string;
      readonly failedAttachmentNames: ReadonlyArray<string>;
    }
  | {
      readonly destination: "duplicate";
      readonly failedAttachmentNames: ReadonlyArray<string>;
    }
  | {
      readonly destination: "empty";
      readonly failedAttachmentNames: ReadonlyArray<string>;
    };

function createBlobPreviewUrl(file: File): string {
  return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
}

function uniqueNames(names: ReadonlyArray<string>): string[] {
  return [...new Set(names)];
}

/**
 * Recovers a withdrawn queued message into the composer when it is empty and unoccupied,
 * or into the prompt stash (preserving text, attachments, and contexts) otherwise.
 */
export async function recoverWithdrawnQueuedRun(
  input: RecoverWithdrawnQueuedRunInput,
  deps?: RecoverWithdrawnQueuedRunDeps,
): Promise<RecoverWithdrawnQueuedRunResult> {
  const createId = deps?.createId ?? randomUUID;
  const downloadAttachment =
    deps?.downloadAttachment ??
    ((attachment: ChatAttachment) => downloadServerAttachment(attachment, input.environmentId));
  const uploadFileForStash =
    deps?.uploadFileForStash ??
    ((file: ComposerFileAttachment) => uploadFileAttachmentForStash(file, input.environmentId));

  const rawPrompt = stripAttachmentOnlyBootstrapPrompt(input.request.text);
  const records = input.request.context?.records ?? [];
  const referencedIds = new Set(collectInlineContextIds(rawPrompt));

  const replyTo: ResponseContextRecord | null =
    records.filter((record) => referencedIds.has(record.contextId)).find(isResponseContextRecord) ??
    null;
  const prompt = replyTo
    ? removeInlineContextReference(rawPrompt, replyTo.contextId).prompt
    : rawPrompt;

  const localIdByAttachmentId = new Map<string, string>();
  const threadContexts: ThreadContextRecord[] = [];
  const environmentContexts: EnvironmentContextRecord[] = [];
  const terminalContexts: TerminalContextDraft[] = [];
  const reviewComments: ReviewCommentContext[] = [];
  const previewAnnotations: PreviewAnnotationPayload[] = [];

  for (const record of records) {
    if ((record.kind === "image" || record.kind === "file") && "attachmentId" in record) {
      localIdByAttachmentId.set(
        record.attachmentId,
        producerIdFromComposerContextId(record.kind, record.contextId),
      );
      continue;
    }
    if (record.kind === "thread" && referencedIds.has(record.contextId)) {
      threadContexts.push(record);
      continue;
    }
    if (record.kind === "environment" && referencedIds.has(record.contextId)) {
      environmentContexts.push(record);
      continue;
    }
    if (record.kind === "terminal") {
      terminalContexts.push(terminalContextDraftFromRecord(record, input.threadId));
      continue;
    }
    if (record.kind === "review-comment") {
      reviewComments.push(reviewCommentFromRecord(record));
      continue;
    }
    if (record.kind === "preview-annotation") {
      previewAnnotations.push(previewAnnotationFromRecord(record));
    }
  }

  const downloadedFiles = await Promise.all(
    input.request.attachments.map(async (attachment) => ({
      attachment,
      file: await downloadAttachment(attachment).catch(() => null),
    })),
  );

  const images: ComposerImageAttachment[] = [];
  const files: ComposerFileAttachment[] = [];
  const failedAttachmentNames: string[] = [];

  for (const { attachment, file } of downloadedFiles) {
    if (!file) {
      failedAttachmentNames.push(attachment.name);
      continue;
    }
    const localId = localIdByAttachmentId.get(attachment.id) ?? createId();
    if (attachment.type === "image") {
      images.push({
        type: "image",
        id: localId,
        name: attachment.name,
        mimeType: attachment.mimeType || file.type || "image/png",
        sizeBytes: file.size || attachment.sizeBytes,
        previewUrl: createBlobPreviewUrl(file),
        file,
      });
    } else {
      files.push({
        type: "file",
        id: localId,
        name: attachment.name,
        mimeType: attachment.mimeType || file.type || "application/octet-stream",
        sizeBytes: file.size || attachment.sizeBytes,
        file,
      });
    }
  }

  const draftStore = useComposerDraftStore.getState();
  const shouldStash =
    input.isComposerOccupied ||
    composerDraftHasUserContent(draftStore.getComposerDraft(input.threadDraftTarget));

  if (!shouldStash) {
    const hasAnything =
      prompt.trim().length > 0 || images.length > 0 || files.length > 0 || replyTo !== null;
    if (!hasAnything) {
      if (failedAttachmentNames.length > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "已撤回排队消息，但附件未能取回",
            description: `未能取回的附件：${uniqueNames(failedAttachmentNames).join("、")}（需重新添加）。`,
            data: { hideCopyButton: true },
          }),
        );
      }
      return { destination: "empty", failedAttachmentNames };
    }

    if (prompt.length > 0) {
      draftStore.setPrompt(input.threadDraftTarget, prompt);
    }
    if (images.length > 0) {
      draftStore.addImages(input.threadDraftTarget, images);
    }
    if (files.length > 0) {
      draftStore.addFiles(input.threadDraftTarget, files, { appendReference: false });
    }
    if (terminalContexts.length > 0) {
      draftStore.addTerminalContexts(input.threadDraftTarget, terminalContexts, {
        appendReference: false,
      });
    }
    for (const annotation of previewAnnotations) {
      draftStore.addPreviewAnnotation(input.threadDraftTarget, annotation, {
        appendReference: false,
      });
    }
    for (const comment of reviewComments) {
      draftStore.addReviewComment(input.threadDraftTarget, comment, {
        appendReference: false,
      });
    }
    if (threadContexts.length > 0) {
      draftStore.setThreadContexts(input.threadDraftTarget, threadContexts);
    }
    if (environmentContexts.length > 0) {
      draftStore.setEnvironmentContexts(input.threadDraftTarget, environmentContexts);
    }
    if (replyTo) {
      draftStore.setReplyTo(input.threadDraftTarget, replyTo);
    }

    input.onRestoredToComposer?.({ prompt, images, files, terminalContexts });

    toastManager.add(
      stackedThreadToast({
        type: failedAttachmentNames.length > 0 ? "warning" : "info",
        title: "已撤回排队消息，已放回输入框",
        ...(failedAttachmentNames.length > 0
          ? {
              description: `未能取回的附件：${uniqueNames(failedAttachmentNames).join("、")}（需重新添加）。`,
            }
          : {}),
        data: { hideCopyButton: true },
      }),
    );

    return { destination: "composer", failedAttachmentNames };
  }

  // Re-upload recovered files as pending attachments so stashed entries have a 24h pending lease
  // rather than referencing a message whose queued run was just cancelled.
  const uploadedById = new Map<string, AttachmentUploadState>();
  await Promise.all(
    files.map(async (file) => {
      const upload = await uploadFileForStash(file).catch(() => undefined);
      if (upload) {
        uploadedById.set(file.id, upload);
      }
    }),
  );

  const stashResult = await autoStashDraftContent(
    {
      dedupeKey: `withdraw-queued:${input.environmentId}:${input.threadId}:${input.request.runId}`,
      environmentId: input.environmentId,
      prompt,
      images,
      files,
      terminalContexts,
      previewAnnotations,
      reviewComments,
      threadContexts,
      environmentContexts,
      replyTo,
    },
    {
      readUpload: (fileId) => uploadedById.get(fileId) ?? readAttachmentUpload(fileId),
      ...(deps?.compressImage ? { compressImage: deps.compressImage } : {}),
      createId,
      ...(deps?.now ? { now: deps.now } : {}),
    },
  );

  // Release temporary object URLs created only to populate composer-shaped objects before stashing.
  if (typeof URL.revokeObjectURL === "function") {
    for (const image of images) {
      if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
    }
  }

  if (stashResult.status === "duplicate") {
    return { destination: "duplicate", failedAttachmentNames: [] };
  }
  if (stashResult.status === "empty" || stashResult.status === "unsaved-attachments-only") {
    const allFailed = uniqueNames([
      ...failedAttachmentNames,
      ...(stashResult.status === "unsaved-attachments-only" ? stashResult.unsavedFileNames : []),
    ]);
    if (allFailed.length > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "已撤回排队消息，但附件未能存入暂存",
          description: `未能存入暂存的附件：${allFailed.join("、")}（需重新添加）。`,
          data: { hideCopyButton: true },
        }),
      );
    }
    return { destination: "empty", failedAttachmentNames: allFailed };
  }

  const downloadWarning =
    failedAttachmentNames.length > 0
      ? `未能取回的附件：${uniqueNames(failedAttachmentNames).join("、")}（需重新添加）。`
      : "";
  const prefix = downloadWarning
    ? `${downloadWarning} 输入框里已有内容，点「恢复」或打开输入框上方的「暂存」即可取回其余内容。`
    : "输入框里已有内容，点「恢复」或打开输入框上方的「暂存」即可取回。";

  const hasWarnings =
    failedAttachmentNames.length > 0 ||
    stashResult.unsavedFileNames.length > 0 ||
    stashResult.droppedImageNames.length > 0 ||
    stashResult.unreadableImageNames.length > 0 ||
    stashResult.overflowed ||
    !stashResult.durable;

  let toastId: string | null = null;
  toastId =
    toastManager.add(
      stackedThreadToast({
        type: hasWarnings ? "warning" : "info",
        title: "已撤回排队消息，已放进暂存",
        description: formatAutoStashNoticeDescription({
          prefix,
          unsavedFileNames: stashResult.unsavedFileNames,
          droppedImageNames: stashResult.droppedImageNames,
          unreadableImageNames: stashResult.unreadableImageNames,
          overflowed: stashResult.overflowed,
          durable: stashResult.durable,
        }),
        data: { hideCopyButton: true },
        ...(input.onRestoreStashEntry
          ? {
              actionProps: {
                children: "恢复",
                onClick: () => {
                  if (toastId) toastManager.close(toastId);
                  void input.onRestoreStashEntry?.(stashResult.entryId);
                },
              },
            }
          : {}),
      }),
    ) ?? null;

  return {
    destination: "stash",
    entryId: stashResult.entryId,
    failedAttachmentNames,
  };
}
