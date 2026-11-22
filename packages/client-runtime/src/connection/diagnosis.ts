import {
  t3ConnectTroubleshootingUrl,
  type T3ConnectTroubleshootingSection,
} from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";

import type {
  ConnectionAttemptError,
  ConnectionFailureCause,
  ConnectionHop,
  SupervisorConnectionState,
} from "./model.ts";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Mac mini's tunnel is offline". */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  /** The troubleshooting guide section for this failure. Null for direct routes, except a pending T3 Connect sign-in. */
  readonly moreInfoUrl: string | null;
}

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  /** The environment's usual route, used when the failure does not name one. */
  readonly via: "relay" | "direct";
  /** The relay's last health check, which can name a cause before any connect attempt. */
  readonly relayStatus?: Pick<
    RelayEnvironmentStatusResponse,
    "status" | "endpointFailure" | "endpointStatus" | "offlineReason"
  > | null;
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
}

interface Located {
  readonly hop: ConnectionHop;
  readonly cause:
    | ConnectionFailureCause
    | "offline"
    | "outdated"
    | "released"
    | "session_pending"
    | null;
  /** The failure named no hop, so the hops before this one were never probed. */
  readonly guessed?: true;
}

const NOT_ANSWERING: ReadonlySet<ConnectionFailureCause> = new Set([
  "origin_unreachable",
  "invalid_response",
]);

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.reason === "session-pending") {
    return { hop: "device", cause: "session_pending" };
  }
  if (failure?.hop !== undefined) {
    return { hop: failure.hop, cause: failure.failureCause ?? null };
  }
  if (failure !== null) {
    const unreachable =
      failure.reason === "network" ||
      failure.reason === "timeout" ||
      failure.reason === "transport";
    const via = failure.via ?? input.via;
    return {
      hop: unreachable && via === "relay" ? "tunnel" : "server",
      cause: null,
      guessed: true,
    };
  }
  const status = input.relayStatus;
  if (status?.status !== "offline") return null;
  if (status.offlineReason === "tunnel_released") return { hop: "tunnel", cause: "released" };
  const cause = status.endpointFailure ?? null;
  return { hop: cause !== null && NOT_ANSWERING.has(cause) ? "server" : "tunnel", cause };
}

function headline(host: string, located: Located, failure: ConnectionAttemptError | null): string {
  switch (located.cause) {
    case "offline":
      return "此设备离线";
    case "session_pending":
      return "此设备仍在加载 T3 Connect 登录状态";
    case "outdated":
      return `${host} 运行的 Fleet ADE 版本较旧`;
    case "clock_skew":
      return "此设备的时钟不准确";
    case "not_linked":
      return `${host} 未关联到你的 T3 Connect 账户`;
    case "relay_error":
      return "T3 Connect 返回了错误";
    case "tunnel_pending":
      return `${host} 的隧道仍在设置中`;
    case "tunnel_not_enabled":
      return `${host} 尚未开启 T3 Connect`;
    case "released":
    case "tunnel_down":
      return `${host} 的隧道离线`;
    case "origin_unreachable":
      return `隧道正常，但 ${host} 上的 Fleet ADE 没有响应`;
    case "invalid_response":
      return `${host} 上的 Fleet ADE 返回了异常响应`;
    case "dns":
      return `无法解析 ${host} 的隧道地址`;
    case "tls":
      return `无法与 ${host} 的隧道建立安全连接`;
    case "refused":
      return `${host} 的隧道拒绝了连接`;
    case "timeout":
      return `${host} 未及时响应`;
    case "unknown":
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return "此设备无法准备连接";
    case "relay":
      return failure?.reason === "authentication"
        ? "T3 Connect 未接受此设备的登录"
        : "此设备无法访问 T3 Connect";
    case "tunnel":
      // The relay already reached the host when this device fails on its own.
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? `此设备无法访问 ${host} 的隧道`
        : `T3 Connect 无法访问 ${host} 的隧道`;
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? `${host} 上的 Fleet ADE 未接受此设备`
        : `${host} 上的 Fleet ADE 没有响应`;
  }
}

function steps(host: string, located: Located, failure: ConnectionAttemptError | null): string[] {
  const checkHost = `请在 ${host} 上查看“设置 > 连接”，或运行 \`t3 connect status\`。`;
  switch (located.cause) {
    case "offline":
      return ["请将此设备连接到互联网。Fleet ADE 会自动重新连接。"];
    case "session_pending":
      return [
        "请稍等。Fleet ADE 会自动重试。",
        "如果一直没有进展，请在此设备上重新加载或重启 Fleet ADE。",
      ];
    case "outdated":
      return [`请更新 ${host} 上的 Fleet ADE。`];
    case "clock_skew":
      return [`请在此设备和 ${host} 上开启自动日期与时间，然后重试。`];
    case "not_linked":
      return [
        "请确认此设备与主机登录了同一个 T3 Connect 账户。",
        `请在 ${host} 上打开“设置 > 连接”，并开启 T3 Connect。`,
      ];
    case "tunnel_pending":
      return ["请稍等片刻。Fleet ADE 会自动重试。", checkHost];
    case "relay_error":
      return ["请等几分钟。Fleet ADE 会自动重试。", "如果仍然失败，请复制诊断信息并反馈。"];
    case "tunnel_not_enabled":
      return [`请在 ${host} 上打开“设置 > 连接”，并开启 T3 Connect。`];
    case "released":
    case "tunnel_down":
      return [
        `请确认 ${host} 未休眠，且 Fleet ADE 正在运行。`,
        checkHost,
        `${host} 上的 VPN 或 Tailscale 出口节点可能会阻止隧道连接（端口 7844）。请关闭它们或允许隧道连接。`,
      ];
    case "origin_unreachable":
    case "invalid_response":
      return [`请在 ${host} 上打开或重启 Fleet ADE。`, checkHost];
    // The relay saw these on its way to the host, so the fix is on the host.
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return [`请确认 ${host} 未休眠且已联网。`, checkHost];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        "请在此设备上重启 Fleet ADE。",
        `如果仍然失败，请从此设备移除 ${host}，然后重新添加。`,
      ];
    case "relay":
      return failure?.reason === "authentication"
        ? ["请退出 T3 Connect 后重新登录。"]
        : [
            "请检查此设备的互联网连接。",
            "此设备上的 VPN、防火墙或广告拦截器可能会阻止 T3 Connect 连接。",
          ];
    case "tunnel":
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? [
            "此设备上的 VPN、防火墙或 DNS 过滤器可能会阻止隧道连接。",
            "请尝试其他网络，或添加 Tailscale 地址等直连线路。",
          ]
        : [`请确认 ${host} 未休眠且已联网。`, checkHost];
    case "server":
      return [`请确认 ${host} 上的 Fleet ADE 正在运行。`, "请重试。如果仍然失败，请复制诊断信息。"];
  }
}

function helpSection(
  located: Located,
  failure: ConnectionAttemptError | null,
): T3ConnectTroubleshootingSection {
  switch (located.cause) {
    case "offline":
      return "this-device-cant-reach-t3-connect";
    case "outdated":
      return "the-host-runs-an-older-t3-code";
    case "clock_skew":
      return "the-clock-is-off";
    case "session_pending":
    case "not_linked":
    case "tunnel_not_enabled":
      return "sign-in-account-or-link-problems";
    case "relay_error":
      return "t3-connect-returned-an-error";
    case "released":
    case "tunnel_down":
    case "tunnel_pending":
      return "the-hosts-tunnel-is-offline";
    case "origin_unreachable":
    case "invalid_response":
      return "the-tunnel-works-but-t3-code-does-not-answer";
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return "the-t3-connect-address-does-not-resolve-or-answer";
    case null:
      break;
  }
  const onThisDevice =
    failure?.reason === "network" ||
    failure?.reason === "transport" ||
    failure?.reason === "timeout";
  switch (located.hop) {
    case "device":
      return "this-device-cant-reach-t3-connect";
    case "relay":
      return failure?.reason === "authentication"
        ? "sign-in-account-or-link-problems"
        : "this-device-cant-reach-t3-connect";
    case "tunnel":
      return onThisDevice ? "this-device-cant-reach-t3-connect" : "the-hosts-tunnel-is-offline";
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? "sign-in-account-or-link-problems"
        : "the-tunnel-works-but-t3-code-does-not-answer";
  }
}

const HOP_ORDER = {
  relay: ["device", "relay", "tunnel", "server"],
  direct: ["device", "server"],
} as const;

function hopLabel(hop: ConnectionHop, host: string): string {
  switch (hop) {
    case "device":
      return "此设备";
    case "relay":
      return "T3 Connect";
    case "tunnel":
      return `${host} 的隧道`;
    case "server":
      return `${host} 上的 Fleet ADE`;
  }
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Web and mobile render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const failure = input.state.lastFailure;
  const relayPath =
    located.hop === "relay" ||
    located.hop === "tunnel" ||
    (failure === null && input.relayStatus?.status === "offline") ||
    (failure?.via ?? input.via) === "relay";
  const order: ReadonlyArray<ConnectionHop> = HOP_ORDER[relayPath ? "relay" : "direct"];
  const failedIndex = order.indexOf(located.hop);
  const hops = order.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(hop, host),
    result:
      index === failedIndex
        ? "failed"
        : index < failedIndex && located.guessed !== true
          ? "ok"
          : "unchecked",
  }));

  // The relay health check only explains the state when no attempt has failed yet.
  const httpStatus = failure !== null ? failure.httpStatus : input.relayStatus?.endpointStatus;
  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add("Cause", located.cause ?? failure?.reason);
  add("HTTP 状态", httpStatus);
  add("Attempts", input.state.attempt > 0 ? input.state.attempt : null);
  add(
    "下次重试",
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add("Route", relayPath ? "T3 Connect" : "Direct");
  add("应用版本", input.clientVersion);
  add("主机版本", input.serverVersion);
  add("Error", failure?.detail);
  add("追踪 ID", failure?.traceId);

  return {
    headline: headline(host, located, failure),
    hops,
    steps: steps(host, located, failure),
    facts,
    moreInfoUrl:
      relayPath || located.cause === "session_pending"
        ? t3ConnectTroubleshootingUrl(helpSection(located, failure))
        : null,
  };
}

const HOP_MARK = { ok: "ok", failed: "FAILED", unchecked: "not checked" } as const;

/** One plain-text block for bug reports. */
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `Fleet ADE connection to ${hostLabel}: ${diagnosis.headline}`,
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${HOP_MARK[hop.result]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
    ...(diagnosis.moreInfoUrl ? ["", `More info: ${diagnosis.moreInfoUrl}`] : []),
  ].join("\n");
}
