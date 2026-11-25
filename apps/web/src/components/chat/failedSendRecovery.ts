import type { EnvironmentId, MessageId } from "@t3tools/contracts";

import {
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { releaseAttachmentUpload } from "../../lib/attachmentUploadQueue";
import type { AttachmentUploadState } from "../../lib/attachmentUploadState";
import type { CompressStashImageResult } from "../../lib/imageCompression";
import type { ComposerSendSnapshot } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { restoreComposerDraft } from "./chatViewSend";
import { autoStashDraftContent, formatAutoStashNoticeDescription } from "./composerAutoStash";

export interface RecoverFailedComposerSendInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly messageId: MessageId;
  readonly sendSnapshot: ComposerSendSnapshot;
  readonly interrupted: boolean;
  readonly onRestoredToComposer?: (retryImages: ComposerImageAttachment[]) => void;
  readonly onRestoreStashEntry?: (entryId: string) => void | Promise<void>;
}

export interface RecoverFailedComposerSendDeps {
  readonly readUpload?: (attachmentId: string) => AttachmentUploadState | undefined;
  readonly compressImage?: (file: File) => Promise<CompressStashImageResult>;
  readonly releaseUpload?: (attachmentId: string) => void;
  readonly createId?: () => string;
  readonly now?: () => string;
}

export type RecoverFailedComposerSendResult =
  | { readonly outcome: "restored-to-composer" }
  | { readonly outcome: "stashed"; readonly entryId: string }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "empty" }
  | { readonly outcome: "unsaved-attachments-only" };

/**
 * Recovers a failed composer send: puts it back into an empty draft directly, or into the
 * prompt stash (including attachments and contexts) when the user has already started a new draft.
 */
export async function recoverFailedComposerSend(
  input: RecoverFailedComposerSendInput,
  deps?: RecoverFailedComposerSendDeps,
): Promise<RecoverFailedComposerSendResult> {
  const currentDraft = useComposerDraftStore.getState().getComposerDraft(input.composerDraftTarget);
  if (!composerDraftHasUserContent(currentDraft)) {
    const retryImages = restoreComposerDraft(input.composerDraftTarget, input.sendSnapshot);
    input.onRestoredToComposer?.(retryImages);
    return { outcome: "restored-to-composer" };
  }

  const releaseUpload = deps?.releaseUpload ?? releaseAttachmentUpload;
  const result = await autoStashDraftContent(
    {
      dedupeKey: `failed-send:${input.routeThreadKey}:${input.messageId}`,
      environmentId: input.environmentId,
      prompt: input.sendSnapshot.draftText,
      images: input.sendSnapshot.images,
      files: input.sendSnapshot.files,
      terminalContexts: input.sendSnapshot.terminalContexts,
      previewAnnotations: input.sendSnapshot.previewAnnotations,
      reviewComments: input.sendSnapshot.reviewComments,
      threadContexts: input.sendSnapshot.threadContexts,
      environmentContexts: input.sendSnapshot.environmentContexts,
      replyTo: input.sendSnapshot.replyTo,
    },
    {
      ...(deps?.readUpload ? { readUpload: deps.readUpload } : {}),
      ...(deps?.compressImage ? { compressImage: deps.compressImage } : {}),
      ...(deps?.createId ? { createId: deps.createId } : {}),
      ...(deps?.now ? { now: deps.now } : {}),
    },
  );

  if (result.status === "duplicate") {
    return { outcome: "duplicate" };
  }
  if (result.status === "empty") {
    return { outcome: "empty" };
  }

  // Stashed images persist as inline compressed dataUrls; only stashed uploaded files keep their server lease.
  for (const image of input.sendSnapshot.images) {
    releaseUpload(image.id);
  }
  const unsavedFileNames = new Set(result.unsavedFileNames);
  for (const file of input.sendSnapshot.files) {
    if (result.status === "unsaved-attachments-only" || unsavedFileNames.has(file.name)) {
      releaseUpload(file.id);
    }
  }

  if (result.status === "unsaved-attachments-only") {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: input.interrupted
          ? "消息可能没发出去，附件未能存入暂存"
          : "消息没发出去，附件未能存入暂存",
        description: `未能存入暂存的文件：${result.unsavedFileNames.join("、")}（需重新添加）。`,
        data: { hideCopyButton: true },
      }),
    );
    return { outcome: "unsaved-attachments-only" };
  }

  const hasWarnings =
    input.interrupted ||
    result.unsavedFileNames.length > 0 ||
    result.droppedImageNames.length > 0 ||
    result.unreadableImageNames.length > 0 ||
    result.overflowed ||
    !result.durable;

  let toastId: string | null = null;
  toastId =
    toastManager.add(
      stackedThreadToast({
        type: hasWarnings ? "warning" : "info",
        title: input.interrupted ? "消息可能没发出去，已放进暂存" : "消息没发出去，已放进暂存",
        description: formatAutoStashNoticeDescription({
          prefix: "输入框里已有新草稿，点「恢复」或打开输入框上方的「暂存」即可取回。",
          unsavedFileNames: result.unsavedFileNames,
          droppedImageNames: result.droppedImageNames,
          unreadableImageNames: result.unreadableImageNames,
          overflowed: result.overflowed,
          durable: result.durable,
        }),
        data: { hideCopyButton: true },
        ...(input.onRestoreStashEntry
          ? {
              actionProps: {
                children: "恢复",
                onClick: () => {
                  if (toastId) toastManager.close(toastId);
                  void input.onRestoreStashEntry?.(result.entryId);
                },
              },
            }
          : {}),
      }),
    ) ?? null;

  return { outcome: "stashed", entryId: result.entryId };
}
