import { ManagedRelay, relayRequestFailureDetail } from "@t3tools/client-runtime/relay";
import * as Schema from "effect/Schema";

const isRequestFailed = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);
const isRequestTimeout = Schema.is(ManagedRelay.ManagedRelayRequestTimeoutError);

/** One short line for an error toast saying why a T3 Connect request failed. */
export function relayFailureReason(cause: unknown): string | null {
  for (let current = cause, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (isRequestTimeout(current)) return "T3 Connect 超时，请重试。";
    if (isRequestFailed(current)) {
      if (current.transportFailed) return "无法连接 T3 Connect，请检查网络。";
      if (current.relayError) {
        return current.relayError._tag === "RelayInternalError"
          ? "T3 Connect 暂时不可用，请重试。"
          : relayRequestFailureDetail(current);
      }
      if (current.status === 504) return "T3 Connect 超时，请重试。";
      if ((current.status ?? 0) >= 500) return "T3 Connect 暂时不可用，请重试。";
      return relayRequestFailureDetail(current);
    }
    current = current.cause;
  }
  return null;
}
