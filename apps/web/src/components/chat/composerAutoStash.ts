import {
  type ComposerContextRecord,
  type EnvironmentContextRecord,
  type EnvironmentId,
  type PreviewAnnotationPayload,
  type ResponseContextRecord,
  type ThreadContextRecord,
} from "@t3tools/contracts";

import { collectComposerPromptInlineTokens } from "../../composer-editor-mentions";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type PersistedComposerFileAttachment,
  type PersistedComposerImageAttachment,
  composerFileNeedsReattach,
} from "../../composerDraftStore";
import { readAttachmentUpload } from "../../lib/attachmentUploadQueue";
import type { AttachmentUploadState } from "../../lib/attachmentUploadState";
import {
  previewAnnotationContextRecord,
  reviewCommentContextRecord,
  terminalContextRecord,
} from "../../lib/composerContextRecords";
import { type CompressStashImageResult, compressImageForStash } from "../../lib/imageCompression";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { randomUUID } from "../../lib/utils";
import {
  MAX_STASH_ENTRIES,
  type PromptStashEntry,
  partitionStashAttachments,
  usePromptStashStore,
} from "../../promptStashStore";
import type { ReviewCommentContext } from "../../reviewCommentContext";

const MAX_CLAIMED_DEDUPE_KEYS = 200;
const claimedDedupeKeys = new Set<string>();

export function resetAutoStashDedupeForTest(): void {
  claimedDedupeKeys.clear();
}

function claimDedupeKey(dedupeKey: string): boolean {
  if (claimedDedupeKeys.has(dedupeKey)) {
    return false;
  }
  claimedDedupeKeys.add(dedupeKey);
  if (claimedDedupeKeys.size > MAX_CLAIMED_DEDUPE_KEYS) {
    const oldest = claimedDedupeKeys.values().next().value;
    if (oldest !== undefined) {
      claimedDedupeKeys.delete(oldest);
    }
  }
  return true;
}

export interface AutoStashPayload {
  /** Identity of the failure/withdrawal/displaced-edit operation; never content-based. */
  readonly dedupeKey: string;
  readonly environmentId: EnvironmentId;
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly terminalContexts?: ReadonlyArray<TerminalContextDraft>;
  readonly previewAnnotations?: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments?: ReadonlyArray<ReviewCommentContext>;
  readonly threadContexts?: ReadonlyArray<ThreadContextRecord>;
  readonly environmentContexts?: ReadonlyArray<EnvironmentContextRecord>;
  readonly replyTo?: ResponseContextRecord | null;
  readonly extraRecords?: ReadonlyArray<ComposerContextRecord>;
}

export interface AutoStashDeps {
  readonly readUpload?: (imageId: string) => AttachmentUploadState | undefined;
  readonly compressImage?: (file: File) => Promise<CompressStashImageResult>;
  readonly createId?: () => string;
  readonly now?: () => string;
}

export type AutoStashResult =
  | {
      readonly status: "stashed";
      readonly entryId: string;
      readonly overflowed: boolean;
      readonly durable: boolean;
      readonly unsavedFileNames: ReadonlyArray<string>;
      readonly droppedImageNames: ReadonlyArray<string>;
      readonly unreadableImageNames: ReadonlyArray<string>;
    }
  | { readonly status: "duplicate" }
  | { readonly status: "empty" }
  | {
      readonly status: "unsaved-attachments-only";
      readonly unsavedFileNames: ReadonlyArray<string>;
    };

function preserveTrailingChipSpace(rawPrompt: string): string {
  const trimmedPrompt = rawPrompt.trim();
  if (trimmedPrompt.length === 0) return "";
  const endsWithChip =
    collectComposerPromptInlineTokens(rawPrompt).at(-1)?.end === rawPrompt.trimEnd().length;
  return endsWithChip ? `${trimmedPrompt} ` : trimmedPrompt;
}

function collectAutoStashRecords(payload: AutoStashPayload): ComposerContextRecord[] {
  const imageIds = new Set(payload.images.map((image) => image.id));
  const rawRecords: ComposerContextRecord[] = [
    ...(payload.replyTo ? [payload.replyTo] : []),
    ...(payload.threadContexts ?? []),
    ...(payload.environmentContexts ?? []),
    ...(payload.terminalContexts ?? []).map(terminalContextRecord),
    ...(payload.reviewComments ?? []).map(reviewCommentContextRecord),
    ...(payload.previewAnnotations ?? []).map((annotation) =>
      previewAnnotationContextRecord(annotation, {
        screenshotContextId: imageIds.has(annotation.id) ? annotation.id : undefined,
      }),
    ),
    ...(payload.extraRecords ?? []),
  ];
  const deduped = new Map<string, ComposerContextRecord>();
  for (const record of rawRecords) {
    if (!deduped.has(record.contextId)) {
      deduped.set(record.contextId, record);
    }
  }
  return Array.from(deduped.values());
}

/**
 * Saves an unsubmitted draft/message into the prompt stash synchronously before awaiting
 * image re-encoding, deduplicating strictly by operation key (`dedupeKey`).
 */
export async function autoStashDraftContent(
  payload: AutoStashPayload,
  deps?: AutoStashDeps,
): Promise<AutoStashResult> {
  const prompt = preserveTrailingChipSpace(payload.prompt);
  const hasAnyContent =
    prompt.length > 0 ||
    payload.images.length > 0 ||
    payload.files.length > 0 ||
    payload.replyTo != null;
  if (!hasAnyContent) {
    return { status: "empty" };
  }
  if (!claimDedupeKey(payload.dedupeKey)) {
    return { status: "duplicate" };
  }

  const readUpload = deps?.readUpload ?? readAttachmentUpload;
  const compressImage = deps?.compressImage ?? compressImageForStash;
  const createId = deps?.createId ?? randomUUID;
  const now = deps?.now ?? (() => new Date().toISOString());

  const stashedFiles: PersistedComposerFileAttachment[] = [];
  const unsavedFileNames: string[] = [];
  for (const file of payload.files) {
    if (composerFileNeedsReattach(file)) {
      unsavedFileNames.push(file.name);
      continue;
    }
    const upload = readUpload(file.id);
    const attachmentId =
      upload?.status === "ready" && upload.environmentId === payload.environmentId
        ? upload.attachmentId
        : file.uploadEnvironmentId === payload.environmentId
          ? file.uploadedAttachmentId
          : undefined;
    if (!attachmentId) {
      unsavedFileNames.push(file.name);
      continue;
    }
    stashedFiles.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      attachmentId,
      environmentId: payload.environmentId,
      ...(file.source ? { source: file.source } : {}),
    });
  }

  if (
    prompt.length === 0 &&
    payload.images.length === 0 &&
    stashedFiles.length === 0 &&
    payload.replyTo == null
  ) {
    return { status: "unsaved-attachments-only", unsavedFileNames };
  }

  const records = collectAutoStashRecords(payload);
  const entryId = createId();
  const entry: PromptStashEntry = {
    id: entryId,
    createdAt: now(),
    prompt,
    attachments: [],
    ...(stashedFiles.length > 0 ? { files: stashedFiles } : {}),
    droppedImageNames: [],
    unreadableImageNames: [],
    pendingImageCount: payload.images.length,
    ...(records.length > 0 ? { records } : {}),
  };

  const { overflowed, durable } = usePromptStashStore.getState().stashEntry(entry, {
    overflow: "keep",
    keepInMemoryOnWriteFailure: true,
  });

  if (payload.images.length === 0) {
    return {
      status: "stashed",
      entryId,
      overflowed,
      durable,
      unsavedFileNames,
      droppedImageNames: [],
      unreadableImageNames: [],
    };
  }

  const candidateAttachments: PersistedComposerImageAttachment[] = [];
  const oversizedImageNames: string[] = [];
  const unreadableImageNames: string[] = [];
  for (const image of payload.images) {
    const result = await compressImage(image.file);
    if (!result.ok) {
      (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(image.name);
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
  const droppedImageNames = [...oversizedImageNames, ...droppedNames];

  const { durable: imagesDurable } = usePromptStashStore.getState().finalizeEntryImages(entryId, {
    attachments: kept,
    droppedImageNames,
    unreadableImageNames,
  });

  return {
    status: "stashed",
    entryId,
    overflowed,
    durable: durable && imagesDurable,
    unsavedFileNames,
    droppedImageNames,
    unreadableImageNames,
  };
}

export function formatAutoStashNoticeDescription(input: {
  readonly prefix: string;
  readonly unsavedFileNames: ReadonlyArray<string>;
  readonly droppedImageNames: ReadonlyArray<string>;
  readonly unreadableImageNames: ReadonlyArray<string>;
  readonly overflowed: boolean;
  readonly durable: boolean;
}): string {
  const parts = [input.prefix];
  if (input.unsavedFileNames.length > 0) {
    parts.push(`未能存入暂存的文件：${input.unsavedFileNames.join("、")}（需重新添加）。`);
  }
  if (input.droppedImageNames.length > 0) {
    parts.push(`超出暂存大小限制的图片：${input.droppedImageNames.join("、")}。`);
  }
  if (input.unreadableImageNames.length > 0) {
    parts.push(`无法读取的图片：${input.unreadableImageNames.join("、")}。`);
  }
  if (input.overflowed) {
    parts.push(`暂存已超过 ${MAX_STASH_ENTRIES} 条，已为你保留全部记录。`);
  }
  if (!input.durable) {
    parts.push("浏览器存储已满或不可用，当前仅保留在内存中（刷新页面后会丢失）。");
  }
  return parts.join(" ");
}
