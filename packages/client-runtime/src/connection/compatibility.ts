import {
  CLIENT_CAPABILITIES_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

import { ConnectionBlockedError } from "./model.ts";

export function orchestrationProtocolCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  // Servers shipped before negotiation use the original wire protocol.
  const serverProtocolVersion = descriptor.orchestrationProtocolVersion ?? 1;
  if (serverProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) {
    return null;
  }
  return serverProtocolVersion > ORCHESTRATION_PROTOCOL_VERSION
    ? new ConnectionBlockedError({
        reason: "unsupported",
        detail: `此服务器不支持这个客户端。请更新应用或使用兼容的版本以连接到 ${descriptor.label}。`,
      })
    : new ConnectionBlockedError({
        reason: "unsupported",
        detail: `此客户端需要更新的服务器。请更新 ${descriptor.label} 上的 Fleet ADE 后再连接。`,
        ...(canSelfUpdate(descriptor) ? { serverUpdateRequired: true } : {}),
      });
}

function canSelfUpdate(descriptor: ExecutionEnvironmentDescriptor): boolean {
  const { serverSelfUpdate } = descriptor.capabilities;
  return serverSelfUpdate !== undefined && serverSelfUpdate !== "desktop-managed";
}

export function appendOrchestrationProtocol(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set(CLIENT_CAPABILITIES_QUERY_PARAM, SETTINGS_SECRET_REFERENCES_CAPABILITY);
  return url.toString();
}
