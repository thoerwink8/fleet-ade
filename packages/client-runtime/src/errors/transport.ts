import * as Cause from "effect/Cause";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Schema from "effect/Schema";

import { ConnectionTransientError } from "../connection/model.ts";
import { NETWORK_BLOCKING_HINT, UNRESPONSIVE_HOST_HINT } from "./network.ts";

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isConnectionTransientError = Schema.is(ConnectionTransientError);

/**
 * The sentence shown when a request never reached a result because the connection dropped or the
 * request was cancelled. Effect reports that as an interrupt-only cause, which `Cause.squash`
 * turns into the internal "All fibers interrupted without error".
 */
const INTERRUPTED_REQUEST_MESSAGE = "连接已断开，内容已保留，恢复后再试。";

const TRANSPORT_REASON_TAGS: Record<string, true> = {
  SocketReadError: true,
  SocketWriteError: true,
  SocketOpenError: true,
  SocketUpgradeError: true,
  SocketCloseError: true,
  WorkerSpawnError: true,
  WorkerSendError: true,
  WorkerReceiveError: true,
  WorkerUnknownError: true,
};

/** A transport failure: the socket, worker, or HTTP connection itself broke, not the server. */
function isTransportFailure(error: unknown): boolean {
  if (isConnectionTransientError(error)) return error.reason === "transport";
  if (!isRpcClientError(error)) return false;
  const reason = error.reason;
  if (reason._tag in TRANSPORT_REASON_TAGS) return true;
  return reason._tag === "HttpError" && reason.kind === "TransportError";
}

/**
 * The user-facing failure for a request that never produced a result: the request was
 * interrupted, or the connection carrying it broke. `null` for every other failure, which keeps
 * its own reason.
 */
function interruptedRequestFailure(error: unknown): Error | null {
  if (Cause.isCause(error)) {
    return Cause.hasInterruptsOnly(error) ||
      (error.reasons.length > 0 &&
        error.reasons.every((reason) => reason._tag === "Fail" && isTransportFailure(reason.error)))
      ? new Error(INTERRUPTED_REQUEST_MESSAGE)
      : null;
  }
  return isTransportFailure(error) ? new Error(INTERRUPTED_REQUEST_MESSAGE) : null;
}

/** Replaces an interrupted or dropped request with the shared sentence; everything else is kept. */
export function describeRequestFailure(error: unknown): unknown {
  return interruptedRequestFailure(error) ?? (Cause.isCause(error) ? Cause.squash(error) : error);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocket is not connected\b/i,
  /Unable to connect to the T3 server WebSocket\./i,
  // The RPC session appends the network hint for relay connections. Any other
  // trailing text means a different error that the user should still see.
  new RegExp(
    `\\b(?:is not connected|disconnected|stopped responding|could not establish a WebSocket connection)\\.(?: ${escapeRegExp(NETWORK_BLOCKING_HINT)})?$`,
    "i",
  ),
  new RegExp(`\\bstopped responding for \\d+s\\. ${escapeRegExp(UNRESPONSIVE_HOST_HINT)}$`, "i"),
  // Localized variants of the same messages.
  /(?:已断开连接|无法建立 WebSocket 连接|连接已断开)。?/,
  new RegExp(`已 \\d+ 秒无响应。${escapeRegExp(UNRESPONSIVE_HOST_HINT)}$`),
  /\bClientProtocolError\b/i,
  /\bRpcClientError\b/i,
  /\bping timeout\b/i,
] as const;

export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  return isTransportConnectionErrorMessage(message) ? null : (message ?? null);
}
