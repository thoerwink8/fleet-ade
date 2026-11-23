import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DEFAULT_NETWORK_SETTINGS,
  isUnconfiguredDefaultInstanceEnabled,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type NetworkSettings,
  type ServerSettings,
} from "@t3tools/contracts";
import type {
  KnownAgentBinary,
  SystemProxyRead,
} from "@t3tools/provider-core/server/networkEnvironment";

import { setAgentNetworkSnapshotReader } from "./installSpawnPatch.ts";
import { readSystemProxy, refreshSystemProxy } from "./systemProxy.ts";

export interface NetworkSnapshot {
  readonly settings: NetworkSettings;
  readonly system: SystemProxyRead;
  readonly agents: readonly KnownAgentBinary[];
}

const DEFAULT_AGENTS: readonly KnownAgentBinary[] = ["codex", "claudeAgent"]
  .filter((driver) => isUnconfiguredDefaultInstanceEnabled(ProviderInstanceId.make(driver)))
  .map((driver) => ({ driver }));

let current: NetworkSnapshot = {
  settings: DEFAULT_NETWORK_SETTINGS,
  system: {
    proxyUrl: null,
    noProxy: "",
    detail: "读不到系统代理，按直连",
    available: false,
  },
  agents: DEFAULT_AGENTS,
};

function binaryPathFromConfig(config: unknown): string | undefined {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const binaryPath = (config as { readonly binaryPath?: unknown }).binaryPath;
  return typeof binaryPath === "string" && binaryPath.trim() ? binaryPath : undefined;
}

function agentsFromSettings(
  providerInstances: ServerSettings["providerInstances"],
): readonly KnownAgentBinary[] {
  const byDriver = new Map<string, KnownAgentBinary & { readonly enabled: boolean }>();
  for (const instance of Object.values(providerInstances)) {
    const enabled = resolveProviderInstanceEnabled(instance);
    const previous = byDriver.get(instance.driver);
    if (previous?.enabled && !enabled) continue;
    byDriver.set(instance.driver, {
      driver: instance.driver,
      binaryPath: binaryPathFromConfig(instance.config) ?? previous?.binaryPath,
      enabled,
    });
  }
  for (const agent of DEFAULT_AGENTS) {
    if (!byDriver.has(agent.driver)) byDriver.set(agent.driver, { ...agent, enabled: true });
  }
  return [...byDriver.values()].flatMap((agent) =>
    agent.enabled ? [{ driver: agent.driver, binaryPath: agent.binaryPath }] : [],
  );
}

export function publishNetworkSettings(
  settings: Pick<ServerSettings, "network" | "providerInstances">,
): void {
  current = {
    settings: settings.network,
    system: readSystemProxy(),
    agents: agentsFromSettings(settings.providerInstances),
  };
  void refreshSystemProxy();
}

export async function refreshNetworkSystemProxy(force = false): Promise<NetworkSnapshot> {
  const system = await refreshSystemProxy(HostProcess.Platform.defaultValue(), force);
  current = { ...current, system };
  return current;
}

export function currentNetworkSnapshot(): NetworkSnapshot {
  void refreshSystemProxy();
  return current;
}

setAgentNetworkSnapshotReader(() => currentNetworkSnapshot());
