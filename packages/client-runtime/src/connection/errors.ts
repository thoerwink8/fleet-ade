import type { EnvironmentId } from "@t3tools/contracts";

import { pairingRejectionMessage } from "@t3tools/shared/remote";
import type { RemoteEnvironmentAuthError } from "../authorization/remote.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
} from "./model.ts";

export function profileMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `连接配置 ${connectionId} 不可用。`,
    hop: "device",
  });
}

export function credentialMissingError(connectionId: string): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "authentication",
    detail: `连接配对信息 ${connectionId} 不可用。`,
    hop: "device",
  });
}

export function environmentMismatchError(input: {
  readonly expected: EnvironmentId;
  readonly actual: EnvironmentId;
}): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `已连接的电脑 ${input.actual} 与 ${input.expected} 不一致。`,
  });
}

export function mapRemoteEnvironmentError(
  error: RemoteEnvironmentAuthError,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return new ConnectionBlockedError({
        reason: "authentication",
        detail:
          error.credentialFailureReason !== undefined
            ? pairingRejectionMessage(error.credentialFailureReason, "that")
            : error.reason === "invalid_credential"
              ? pairingRejectionMessage(undefined, "that")
              : "电脑配对信息无效。",
        traceId: error.traceId,
        hop: "server",
      });
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: "电脑配对信息未授予所需的访问权限。",
        traceId: error.traceId,
        hop: "server",
      });
    case "EnvironmentRequestInvalidError":
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: "电脑拒绝了身份验证请求。",
        traceId: error.traceId,
        hop: "server",
      });
    case "EnvironmentResourceNotFoundError":
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: "找不到电脑端点。",
        traceId: error.traceId,
        hop: "server",
      });
    case "RemoteEnvironmentAuthTimeoutError":
      return new ConnectionTransientError({
        reason: "timeout",
        detail: error.message,
        hop: "server",
      });
    case "RemoteEnvironmentAuthFetchError":
      return new ConnectionTransientError({
        reason: "network",
        detail: error.message,
        hop: "server",
      });
    case "EnvironmentInternalError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "电脑无法授权此连接。",
        traceId: error.traceId,
        hop: "server",
      });
    case "RemoteEnvironmentAuthInvalidJsonError":
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: error.message,
        hop: "server",
      });
  }
}
