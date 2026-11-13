import type { DpopFailureReason } from "@t3tools/contracts";
import {
  T3CHAT_PLAN_TUNNEL_LIMITS,
  type RelayEnvironmentStatusResponse,
  type RelayProtectedError,
} from "@t3tools/contracts/relay";

export const DPOP_CLOCK_HINT = "提示：请确认两台设备都已开启自动设置日期和时间，然后重试。";

/** Older servers omit the DPoP category, but newer servers can also omit it for
 * a credential failure that happens after proof verification. */
export const DPOP_UNKNOWN_HINT =
  "提示：请重试。如果仍然失败，可能是时钟偏差导致的；请确认两台设备都已开启自动设置日期和时间。";

export const DPOP_RETRY_HINT = "提示：请重试。如果问题持续出现，请复制追踪 ID。";

function dpopFailureHint(reason: DpopFailureReason | undefined): string {
  if (reason === "time_window") return DPOP_CLOCK_HINT;
  if (reason === undefined) return DPOP_UNKNOWN_HINT;
  return DPOP_RETRY_HINT;
}

export function dpopFailureMessage(message: string, reason: DpopFailureReason | undefined): string {
  return `${message} ${dpopFailureHint(reason)}`;
}

export function relayProtectedErrorMessage(error: RelayProtectedError): string {
  switch (error._tag) {
    case "RelayAuthInvalidError":
      switch (error.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return "中继拒绝了云端会话 token。";
        case "invalid_dpop":
          return dpopFailureMessage("中继拒绝了 DPoP 证明。", error.dpopFailureReason);
        case "not_authorized":
          return "中继拒绝了已验证身份的请求。";
      }
    case "RelayEnvironmentLinkProofExpiredError":
      return "中继拒绝了已过期的环境关联证明。";
    case "RelayEnvironmentLinkProofInvalidError":
      return `中继拒绝了环境关联证明（${error.reason}）。`;
    case "RelayEnvironmentConnectNotAuthorizedError":
      // "Not authorized" covers non-auth causes too; surface the reason so a
      // missing link does not read as a credential problem.
      if (error.reason === "environment_link_not_found") {
        return "中继没有此环境的有效关联。如果它已从 T3 Connect 注销，请在那台机器上重新关联。";
      }
      if (error.reason === "managed_endpoint_allocation_not_ready") {
        return "此环境的 T3 Connect 隧道仍在设置中。";
      }
      if (error.reason === "endpoint_provider_not_managed") {
        return "This environment is linked only to publish agent activity, so it cannot accept connections. On that computer, open Settings > Sharing & access and turn T3 Connect on.";
      }
      return error.reason
        ? `中继拒绝了环境连接请求（${error.reason}）。`
        : "中继拒绝了环境连接请求。";
    case "RelayEnvironmentEndpointUnavailableError":
      return `中继无法访问环境端点（${error.reason}）。`;
    case "RelayEnvironmentEndpointTimedOutError":
      return "中继连接环境端点超时。";
    case "RelayEnvironmentLinkFailedError":
      return `中继无法关联环境（${error.reason}）。`;
    case "RelayEnvironmentLinkUnavailableError":
      return `Relay cannot provision the managed endpoint (${error.reason}).${
        error.provisioningStage ? ` Failed stage: ${error.provisioningStage}.` : ""
      }`;
    case "RelayEnvironmentLinkLimitExceededError":
      return error.maxTunnels < T3CHAT_PLAN_TUNNEL_LIMITS.premier
        ? `中继拒绝了关联：此账户已达到 ${error.maxTunnels} 条托管隧道的上限。请取消关联一个环境，或在网页端或桌面端的 T3 Connect 账户设置中关联付费 T3 Chat 账户。Pro 将默认上限提升至 ${T3CHAT_PLAN_TUNNEL_LIMITS.pro} 条，Premier 提升至 ${T3CHAT_PLAN_TUNNEL_LIMITS.premier} 条。`
        : `中继拒绝了关联：此账户已达到 ${error.maxTunnels} 条托管隧道的上限。请取消关联一个环境以释放名额。`;
    case "RelayAgentActivityPublishProofExpiredError":
      return "中继拒绝了已过期的智能体活动发布证明。";
    case "RelayAgentActivityPublishProofInvalidError":
      return `中继拒绝了智能体活动发布证明（${error.reason}）。`;
    case "RelayInternalError":
      return `中继发生了内部错误（${error.reason}）。`;
  }
}

// The relay cuts off a request it cannot finish in time with a 504 that no
// endpoint declares, so the client sees only the status.
export const RELAY_GATEWAY_TIMEOUT_MESSAGE =
  "中继未能及时完成请求（HTTP 504）。请稍后重试。如果持续失败，请在报告问题时附上复制的追踪 ID。";

export function relayRequestFailureDetail(error: {
  readonly relayError?: RelayProtectedError | undefined;
  readonly status?: number | undefined;
}): string | null {
  if (error.relayError) return relayProtectedErrorMessage(error.relayError);
  if (error.status === 504) return RELAY_GATEWAY_TIMEOUT_MESSAGE;
  if (error.status !== undefined) return `中继返回了意外的 HTTP ${error.status}。`;
  return null;
}

const RELAY_TUNNEL_RELEASED_MESSAGE =
  "离线时间较长，其 T3 Connect 隧道已被移除。请在那台电脑上启动 T3 Code 并更新到最新版本，即可重新连接。";

export function relayOfflineReasonMessage(
  status: Pick<RelayEnvironmentStatusResponse, "offlineReason">,
): string | null {
  switch (status.offlineReason) {
    case "tunnel_released":
      return RELAY_TUNNEL_RELEASED_MESSAGE;
    case undefined:
      return null;
  }
}
