import { resolveQueuedEditExit } from "@t3tools/client-runtime/queued-run-edit";
import type {
  ChatAttachment,
  EnvironmentId,
  OrchestrationMessageContext,
} from "@t3tools/contracts";
import {
  composerDraftHasUserContent,
  composerFileNeedsReattach,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { readAttachmentUpload } from "../../lib/attachmentUploadQueue";
import type { AttachmentUploadState } from "../../lib/attachmentUploadState";
import { isResponseContextRecord } from "../../lib/composerContextRecords";
import { producerIdFromComposerContextId } from "../../lib/composerContextReferences";
import type { CompressStashImageResult } from "../../lib/imageCompression";
import { randomUUID } from "../../lib/utils";
import { autoStashDraftContent } from "./composerAutoStash";
import { downloadServerAttachment, uploadFileAttachmentForStash } from "./queuedAttachmentTransfer";

export interface RecoverQueuedMessageEditInput {
  readonly environmentId: EnvironmentId;
  readonly editTarget: ComposerThreadTarget;
  readonly dedupeKey: string;
  readonly originalText: string;
  readonly removedExistingAttachment?: boolean;
  readonly existingAttachments?: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}

export interface RecoverQueuedMessageEditDeps {
  readonly downloadAttachment?: (attachment: ChatAttachment) => Promise<File | null>;
  readonly uploadFileForStash?: (
    file: ComposerFileAttachment,
  ) => Promise<AttachmentUploadState | undefined>;
  readonly readUpload?: (attachmentId: string) => AttachmentUploadState | undefined;
  readonly compressImage?: (file: File) => Promise<CompressStashImageResult>;
  readonly createId?: () => string;
  readonly now?: () => string;
}

export type RecoverQueuedMessageEditResult =
  | { readonly outcome: "clean" }
  | { readonly outcome: "duplicate" }
  | {
      readonly outcome: "unsaved-attachments-only";
      readonly unsavedFileNames: ReadonlyArray<string>;
    }
  | {
      readonly outcome: "stashed";
      readonly entryId: string;
      readonly overflowed: boolean;
      readonly durable: boolean;
      readonly unsavedFileNames: ReadonlyArray<string>;
      readonly droppedImageNames: ReadonlyArray<string>;
      readonly unreadableImageNames: ReadonlyArray<string>;
    };

/**
 * Recovers an unsaved displaced queued-message edit by moving it into the prompt stash,
 * leaving any separate thread draft intact.
 */
export async function recoverQueuedMessageEdit(
  input: RecoverQueuedMessageEditInput,
  deps?: RecoverQueuedMessageEditDeps,
): Promise<RecoverQueuedMessageEditResult> {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(input.editTarget);
  const existingAttachments = input.existingAttachments ?? [];
  const recovery = resolveQueuedEditExit({
    editChanged:
      input.removedExistingAttachment === true ||
      (draft !== null &&
        (draft.prompt !== input.originalText ||
          draft.images.length > 0 ||
          draft.files.length > 0 ||
          draft.terminalContexts.length > 0 ||
          draft.reviewComments.length > 0 ||
          draft.previewAnnotations.length > 0)),
    hasRecoverableContent: composerDraftHasUserContent(draft) || existingAttachments.length > 0,
  });
  store.clearComposerContent(input.editTarget);
  if (recovery === "clean") {
    return { outcome: "clean" };
  }

  const createId = deps?.createId ?? randomUUID;
  const readUpload = deps?.readUpload ?? readAttachmentUpload;
  const downloadAttachment =
    deps?.downloadAttachment ??
    ((attachment: ChatAttachment) => downloadServerAttachment(attachment, input.environmentId));
  const uploadFileForStash =
    deps?.uploadFileForStash ??
    ((file: ComposerFileAttachment) => uploadFileAttachmentForStash(file, input.environmentId));

  const records = input.context?.records ?? [];
  const localIdByAttachmentId = new Map<string, string>();
  for (const record of records) {
    if ((record.kind === "image" || record.kind === "file") && "attachmentId" in record) {
      localIdByAttachmentId.set(
        record.attachmentId,
        producerIdFromComposerContextId(record.kind, record.contextId),
      );
    }
  }

  const downloadedExisting = await Promise.all(
    existingAttachments.map(async (attachment) => ({
      attachment,
      file: await downloadAttachment(attachment).catch(() => null),
    })),
  );

  const recoveredImages: ComposerImageAttachment[] = [];
  const recoveredFiles: ComposerFileAttachment[] = [];
  const failedDownloadNames: string[] = [];
  for (const { attachment, file } of downloadedExisting) {
    if (!file) {
      failedDownloadNames.push(attachment.name);
      continue;
    }
    const localId = localIdByAttachmentId.get(attachment.id) ?? createId();
    if (attachment.type === "image") {
      recoveredImages.push({
        type: "image",
        id: localId,
        name: attachment.name,
        mimeType: attachment.mimeType || file.type || "image/png",
        sizeBytes: file.size || attachment.sizeBytes,
        previewUrl: "",
        file,
      });
    } else {
      recoveredFiles.push({
        type: "file",
        id: localId,
        name: attachment.name,
        mimeType: attachment.mimeType || file.type || "application/octet-stream",
        sizeBytes: file.size || attachment.sizeBytes,
        file,
      });
    }
  }

  const allImages = [...recoveredImages, ...(draft?.images ?? [])];
  const allFiles = [...recoveredFiles, ...(draft?.files ?? [])];

  const uploadedById = new Map<string, AttachmentUploadState>();
  await Promise.all(
    allFiles.map(async (file) => {
      if (composerFileNeedsReattach(file)) return;
      const existing = readUpload(file.id);
      const alreadyUploaded =
        (existing?.status === "ready" && existing.environmentId === input.environmentId) ||
        (file.uploadEnvironmentId === input.environmentId && Boolean(file.uploadedAttachmentId));
      if (alreadyUploaded) return;
      const upload = await uploadFileForStash(file).catch(() => undefined);
      if (upload) {
        uploadedById.set(file.id, upload);
      }
    }),
  );

  const extraRecords = records.filter(
    (record) =>
      record.kind !== "thread" &&
      record.kind !== "environment" &&
      !("attachmentId" in record) &&
      !isResponseContextRecord(record),
  );

  const stashResult = await autoStashDraftContent(
    {
      dedupeKey: `displaced-edit:${input.dedupeKey}`,
      environmentId: input.environmentId,
      prompt: draft?.prompt ?? "",
      images: allImages,
      files: allFiles,
      terminalContexts: draft?.terminalContexts ?? [],
      previewAnnotations: draft?.previewAnnotations ?? [],
      reviewComments: draft?.reviewComments ?? [],
      threadContexts: draft?.threadContexts ?? [],
      environmentContexts: draft?.environmentContexts ?? [],
      replyTo: draft?.replyTo ?? null,
      extraRecords,
    },
    {
      readUpload: (fileId) => uploadedById.get(fileId) ?? readUpload(fileId),
      ...(deps?.compressImage ? { compressImage: deps.compressImage } : {}),
      createId,
      ...(deps?.now ? { now: deps.now } : {}),
    },
  );

  if (stashResult.status === "duplicate") {
    return { outcome: "duplicate" };
  }
  if (stashResult.status === "empty") {
    return failedDownloadNames.length > 0
      ? { outcome: "unsaved-attachments-only", unsavedFileNames: [...new Set(failedDownloadNames)] }
      : { outcome: "clean" };
  }
  if (stashResult.status === "unsaved-attachments-only") {
    return {
      outcome: "unsaved-attachments-only",
      unsavedFileNames: [...new Set([...failedDownloadNames, ...stashResult.unsavedFileNames])],
    };
  }

  return {
    outcome: "stashed",
    entryId: stashResult.entryId,
    overflowed: stashResult.overflowed,
    durable: stashResult.durable,
    unsavedFileNames: [...new Set([...failedDownloadNames, ...stashResult.unsavedFileNames])],
    droppedImageNames: stashResult.droppedImageNames,
    unreadableImageNames: stashResult.unreadableImageNames,
  };
}

export async function prepareQueuedEditAttachments(input: {
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly uploadFiles: (
    files: ReadonlyArray<ComposerFileAttachment>,
  ) => Promise<ReadonlyArray<ChatAttachment>>;
  readonly readImage: (file: File) => Promise<string>;
}) {
  const files = input.files.length === 0 ? [] : await input.uploadFiles(input.files);
  if (files.length !== input.files.length) throw new Error("保存前请重试或移除上传失败的附件。");
  const images = await Promise.all(
    input.images.map(async (image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await input.readImage(image.file),
    })),
  );
  return [...input.existingAttachments, ...images, ...files];
}
