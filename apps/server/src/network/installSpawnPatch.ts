import * as NodeModule from "node:module";

import {
  applyAgentNetworkEnvironment,
  type AgentNetworkSettings,
  type KnownAgentBinary,
  type SystemProxyRead,
} from "@t3tools/provider-core/server/networkEnvironment";

export interface AgentNetworkSpawnSnapshot {
  readonly settings: AgentNetworkSettings;
  readonly system: SystemProxyRead;
  readonly agents: readonly KnownAgentBinary[];
}

const DIRECT_UNTIL_READY: AgentNetworkSpawnSnapshot = {
  settings: {
    line: "auto",
    proxyUrl: "",
    noProxy: "",
    extraCaCertPath: "",
    agentOverrides: {},
  },
  system: {
    proxyUrl: null,
    noProxy: "",
    detail: "读不到系统代理，按直连",
    available: false,
  },
  agents: [],
};

let readSnapshot = (): AgentNetworkSpawnSnapshot => DIRECT_UNTIL_READY;

export function setAgentNetworkSnapshotReader(reader: () => AgentNetworkSpawnSnapshot): void {
  readSnapshot = reader;
}

interface SpawnOptions {
  env?: Record<string, string | undefined> | undefined;
  [key: string]: unknown;
}

interface Spawn {
  (command: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions): unknown;
  networkPatched?: boolean;
}

function isSpawnOptions(
  value: readonly string[] | SpawnOptions | undefined,
): value is SpawnOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// createRequire, not an ESM import: Effect snapshots spawn when it first imports the module.
const nodeRequire = NodeModule.createRequire(import.meta.url);

function installAgentNetworkSpawnPatch(): void {
  const childProcess = nodeRequire("node:child_process") as { spawn: Spawn };
  if (childProcess.spawn.networkPatched) return;
  const original = childProcess.spawn;
  const patched: Spawn = function (this: unknown, command, args, options) {
    const argv = Array.isArray(args) ? [...args] : undefined;
    const spawnOptions = isSpawnOptions(args) ? args : (options ?? {});
    const snapshot = readSnapshot();
    const hostEnv: Record<string, string | undefined> = spawnOptions.env
      ? { ...spawnOptions.env }
      : { ...process.env };
    const env = applyAgentNetworkEnvironment({
      hostEnv,
      settings: snapshot.settings,
      systemProxy: snapshot.system,
      target: {
        command: String(command),
        args: (argv ?? []).map((arg) => String(arg)),
      },
      agents: snapshot.agents,
    });
    const next: SpawnOptions = { ...spawnOptions, env };
    if (argv) return original.call(this, command, argv, next);
    return original.call(this, command, next);
  };
  patched.networkPatched = true;
  childProcess.spawn = patched;
}

installAgentNetworkSpawnPatch();
