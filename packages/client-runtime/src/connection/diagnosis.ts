import * as DateTime from "effect/DateTime";

import type { ConnectionAttemptError, ConnectionHop, SupervisorConnectionState } from "./model.ts";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Mac mini did not answer". */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  /** The troubleshooting guide section for this failure. */
  readonly moreInfoUrl: string | null;
}

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
}

interface Located {
  readonly hop: ConnectionHop;
  readonly cause: "offline" | "outdated" | null;
  /** The failure named no hop, so the hops before this one were never probed. */
  readonly guessed?: true;
}

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.hop !== undefined) {
    return { hop: failure.hop, cause: null };
  }
  if (failure !== null) {
    return { hop: "server", cause: null, guessed: true };
  }
  return null;
}

function headline(host: string, located: Located, failure: ConnectionAttemptError | null): string {
  switch (located.cause) {
    case "offline":
      return "此设备离线";
    case "outdated":
      return `${host} 运行的 Fleet ADE 版本较旧`;
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return "此设备无法准备连接";
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? `${host} 上的 Fleet ADE 未接受此设备`
        : `${host} 上的 Fleet ADE 没有响应`;
  }
}

function steps(host: string, located: Located): string[] {
  switch (located.cause) {
    case "offline":
      return ["请将此设备连接到互联网。Fleet ADE 会自动重新连接。"];
    case "outdated":
      return [`请更新 ${host} 上的 Fleet ADE。`];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        "请在此设备上重启 Fleet ADE。",
        `如果仍然失败，请从此设备移除 ${host}，然后重新添加。`,
      ];
    case "server":
      return [
        `请确认 ${host} 未休眠，且 Fleet ADE 正在运行。`,
        "请重试。如果仍然失败，请复制诊断信息。",
      ];
  }
}

const HOP_ORDER: ReadonlyArray<ConnectionHop> = ["device", "server"];

function hopLabel(hop: ConnectionHop, host: string): string {
  switch (hop) {
    case "device":
      return "此设备";
    case "server":
      return `${host} 上的 Fleet ADE`;
  }
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Clients render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const failure = input.state.lastFailure;
  const failedIndex = HOP_ORDER.indexOf(located.hop);
  const hops = HOP_ORDER.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(hop, host),
    result:
      index === failedIndex
        ? "failed"
        : index < failedIndex && located.guessed !== true
          ? "ok"
          : "unchecked",
  }));

  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add("Cause", failure?.reason);
  add("HTTP 状态", failure?.httpStatus);
  add("Attempts", input.state.attempt > 0 ? input.state.attempt : null);
  add(
    "下次重试",
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add("Route", "Direct");
  add("应用版本", input.clientVersion);
  add("后台服务版本", input.serverVersion);
  add("Error", failure?.detail);
  add("追踪 ID", failure?.traceId);

  return {
    headline: headline(host, located, failure),
    hops,
    steps: steps(host, located),
    facts,
    moreInfoUrl: null,
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
