import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "./chatAttachment.ts";
import { ProjectFaviconPath } from "./project.ts";
import { ToolActivityNativeAppReference } from "./providerRuntime.ts";

const ASSET_PATH_MAX_LENGTH = 1024;

/**
 * The wire tag of a source control host's credentialed media. It names GitHub because GitHub had
 * it first, and servers and clients of different releases must keep understanding each other.
 */
export const SOURCE_CONTROL_MEDIA_ASSET = "github-media" as const;

export const NativeAppIconReference = Schema.Union([
  ToolActivityNativeAppReference,
  Schema.TaggedStruct("app-path", {
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
  }),
]);
export type NativeAppIconReference = typeof NativeAppIconReference.Type;

export const AssetResource = Schema.Union([
  Schema.TaggedStruct("workspace-file", {
    threadId: ThreadId,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
  }),
  Schema.TaggedStruct("media-file", {
    threadId: ThreadId,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
    disposition: Schema.optionalKey(Schema.Literal("attachment")),
    // Written relative to the thread's workspace, so only that host's file is meant.
    hostOnly: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("draft-workspace-file", {
    cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
  }),
  Schema.TaggedStruct("attachment", {
    attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    fileName: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
    mimeType: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
    /** Defaults to download; viewers may request inline after checking the type is safe. */
    disposition: Schema.optionalKey(Schema.Literals(["inline", "attachment"])),
    renderIntent: Schema.optionalKey(Schema.Literal("mcp-app")),
  }),
  Schema.TaggedStruct("tool-output-image", {
    threadId: ThreadId,
    itemId: TurnItemId,
    index: NonNegativeInt,
  }),
  Schema.TaggedStruct("project-favicon", {
    cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
    // Cache-key hint only; the project projection supplies the authoritative path.
    path: Schema.optional(ProjectFaviconPath),
  }),
  Schema.TaggedStruct("native-app-icon", {
    app: NativeAppIconReference,
  }),
  // Media a change request body points at on its host. A private repository serves these only
  // to a request that carries a credential, which the client has none of, so the server fetches
  // them with the credential the host's driver holds for the repository at `cwd`. `repository`
  // names the change request's repository, which can differ from the checkout at `cwd`.
  Schema.TaggedStruct(SOURCE_CONTROL_MEDIA_ASSET, {
    cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
    repository: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  }),
]);
export type AssetResource = typeof AssetResource.Type;

export const AssetCreateUrlInput = Schema.Struct({
  resource: AssetResource,
});
export type AssetCreateUrlInput = typeof AssetCreateUrlInput.Type;

export const AssetImageDimensions = Schema.Struct({
  width: NonNegativeInt.check(Schema.isGreaterThanOrEqualTo(1)),
  height: NonNegativeInt.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type AssetImageDimensions = typeof AssetImageDimensions.Type;

export const AssetCreateUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
  sourcePath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
  ),
  imageDimensions: Schema.optional(AssetImageDimensions),
  /** Changes only when the file's contents or identity change, unlike `relativeUrl`, which is re-signed on every mint. */
  fileRevision: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type AssetCreateUrlResult = typeof AssetCreateUrlResult.Type;

export const ATTACHMENT_UPLOAD_URL_TTL_MS = 10 * 60_000;

const ImageAttachmentCreateUploadUrlInput = Schema.Struct({
  type: Schema.optionalKey(Schema.Literal("image")),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: Schema.Literals(PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
  ),
});

const FileAttachmentCreateUploadUrlInput = Schema.Struct({
  type: Schema.Literal("file"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  ),
});

export const AttachmentCreateUploadUrlInput = Schema.Union([
  ImageAttachmentCreateUploadUrlInput,
  FileAttachmentCreateUploadUrlInput,
]);
export type AttachmentCreateUploadUrlInput = typeof AttachmentCreateUploadUrlInput.Type;

export const AttachmentCreateUploadUrlResult = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
});
export type AttachmentCreateUploadUrlResult = typeof AttachmentCreateUploadUrlResult.Type;

export const AttachmentDeleteInput = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type AttachmentDeleteInput = typeof AttachmentDeleteInput.Type;

export class AttachmentUploadSigningKeyError extends Schema.TaggedError<AttachmentUploadSigningKeyError>()(
  "AttachmentUploadSigningKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "无法加载附件上传签名密钥。";
  }
}

export class AssetWorkspaceContextNotFoundError extends Schema.TaggedError<AssetWorkspaceContextNotFoundError>()(
  "AssetWorkspaceContextNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "找不到项目上下文。";
  }
}

export class AssetWorkspaceContextResolutionError extends Schema.TaggedError<AssetWorkspaceContextResolutionError>()(
  "AssetWorkspaceContextResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "无法解析项目上下文。";
  }
}

export class AssetWorkspaceRootNormalizationError extends Schema.TaggedError<AssetWorkspaceRootNormalizationError>()(
  "AssetWorkspaceRootNormalizationError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "无法规范化项目根路径。";
  }
}

export class AssetWorkspacePathValidationError extends Schema.TaggedError<AssetWorkspacePathValidationError>()(
  "AssetWorkspacePathValidationError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "项目文件路径必须相对于项目根目录。";
  }
}

export class AssetPreviewTypeValidationError extends Schema.TaggedError<AssetPreviewTypeValidationError>()(
  "AssetPreviewTypeValidationError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return this.resource._tag === "media-file" || this.resource._tag === "draft-workspace-file"
      ? "只能预览图片、视频、音频、HTML 和 PDF 文件。"
      : "只能预览浏览器文档和图片。";
  }
}

export class AssetWorkspaceAssetInspectionError extends Schema.TaggedError<AssetWorkspaceAssetInspectionError>()(
  "AssetWorkspaceAssetInspectionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.resource._tag === "media-file" ? "无法检查媒体文件。" : "无法检查项目资源。";
  }
}

export class AssetWorkspaceAssetNotFoundError extends Schema.TaggedError<AssetWorkspaceAssetNotFoundError>()(
  "AssetWorkspaceAssetNotFoundError",
  {
    resource: AssetResource,
    // Absolute path after home/workspace resolution; absent on older servers.
    checkedPath: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.resource._tag === "media-file"
      ? "找不到媒体文件。"
      : this.resource._tag === "tool-output-image"
        ? "找不到工具输出图片。"
        : "找不到项目资源。";
  }
}

export class AssetWorkspaceResolutionError extends Schema.TaggedError<AssetWorkspaceResolutionError>()(
  "AssetWorkspaceResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "无法解析项目。";
  }
}

export class AssetAttachmentNotFoundError extends Schema.TaggedError<AssetAttachmentNotFoundError>()(
  "AssetAttachmentNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "找不到附件。";
  }
}

export class AssetProjectFaviconResolutionError extends Schema.TaggedError<AssetProjectFaviconResolutionError>()(
  "AssetProjectFaviconResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "无法解析项目图标。";
  }
}

export class AssetProjectFaviconInspectionError extends Schema.TaggedError<AssetProjectFaviconInspectionError>()(
  "AssetProjectFaviconInspectionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "无法检查项目图标。";
  }
}

export class AssetProjectFaviconNotFoundError extends Schema.TaggedError<AssetProjectFaviconNotFoundError>()(
  "AssetProjectFaviconNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "找不到项目图标。";
  }
}

export class AssetSigningKeyLoadError extends Schema.TaggedError<AssetSigningKeyLoadError>()(
  "AssetSigningKeyLoadError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "无法加载资源签名密钥。";
  }
}

// The tag predates the rename and stays: clients on either side of an update decode it.
export class AssetSourceControlMediaUrlValidationError extends Schema.TaggedError<AssetSourceControlMediaUrlValidationError>()(
  "AssetGitHubMediaUrlValidationError",
  {},
) {
  override get message(): string {
    return "只有代码托管方凭据保护的媒体才能通过凭据获取。";
  }
}

export const AssetAccessError = Schema.Union([
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  AssetWorkspaceRootNormalizationError,
  AssetWorkspacePathValidationError,
  AssetPreviewTypeValidationError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceResolutionError,
  AssetAttachmentNotFoundError,
  AssetProjectFaviconResolutionError,
  AssetProjectFaviconInspectionError,
  AssetProjectFaviconNotFoundError,
  AssetSourceControlMediaUrlValidationError,
  AssetSigningKeyLoadError,
]);
export type AssetAccessError = typeof AssetAccessError.Type;
