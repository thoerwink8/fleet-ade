import { type ChatAttachment, type EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import { resolveAssetUrl } from "../../assets/assetUrls";
import type { ComposerFileAttachment } from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import type { AttachmentUploadState } from "../../lib/attachmentUploadState";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { readPreparedConnection } from "../../state/session";

const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Downloads a committed/queued server attachment back into a browser `File` so it can be
 * restored into the composer or re-uploaded as a pending stash attachment.
 */
export async function downloadServerAttachment(
  attachment: ChatAttachment,
  environmentId: EnvironmentId,
): Promise<File | null> {
  const connection = readPreparedConnection(environmentId);
  if (!connection) return null;

  try {
    const result = await executeAtomQuery(
      appAtomRegistry,
      assetEnvironment.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
          },
        },
      }),
      {
        label: "queued-attachment.create-url",
        reportFailure: false,
      },
    );
    if (result._tag === "Failure") return null;
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
    if (url === null) return null;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    const mimeType = attachment.mimeType || blob.type || "application/octet-stream";
    return new File([blob], attachment.name, { type: mimeType });
  } catch {
    return null;
  }
}

/**
 * Uploads a recovered `File` into a fresh `pending-*` attachment lease suitable for prompt stash
 * storage (24-hour TTL instead of thread-scoped message storage).
 */
export async function uploadFileAttachmentForStash(
  file: ComposerFileAttachment,
  environmentId: EnvironmentId,
): Promise<AttachmentUploadState | undefined> {
  if (!file.file) {
    return readAttachmentUpload(file.id);
  }
  startAttachmentUpload({
    environmentId,
    image: file,
  });
  await awaitAttachmentUploads([file.id]);
  return readAttachmentUpload(file.id);
}
