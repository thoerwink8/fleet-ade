import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "./settings.ts";

export const OMP_ACP_INSTANCE_ID = ProviderInstanceId.make("omp");

export const OMP_ACP_BUILTIN = {
  id: "omp",
  name: "omp",
  commandPath: "omp",
  commandArgs: ["acp"],
} as const;

const decodeOmpAcpSettings = Schema.decodeSync(AcpRegistrySettings);

/** Local ACP settings for the built-in omp entry. `commandPath` is the editable override. */
export function ompAcpSettings(commandPath: string = OMP_ACP_BUILTIN.commandPath) {
  return decodeOmpAcpSettings({
    source: "local",
    enabled: true,
    commandPath,
    commandArgs: [...OMP_ACP_BUILTIN.commandArgs],
  });
}

export function ompAcpProviderInstance(
  commandPath: string = OMP_ACP_BUILTIN.commandPath,
): ProviderInstanceConfig {
  return {
    driver: ProviderDriverKind.make("acpRegistry"),
    displayName: OMP_ACP_BUILTIN.name,
    enabled: true,
    config: ompAcpSettings(commandPath),
  };
}

/**
 * Bare `omp` on Windows is usually a batch shim. Local ACP will not spawn one,
 * so the caller may use the installer binary instead.
 */
export function ompNeedsInstallerExecutable(input: {
  readonly commandPath: string;
  readonly resolvedPath: string | undefined;
}): boolean {
  if (input.commandPath.trim() !== OMP_ACP_BUILTIN.commandPath) return false;
  return input.resolvedPath === undefined || /\.(?:cmd|bat)$/i.test(input.resolvedPath);
}

export function isConfiguredOmpAcp(
  instances: Readonly<Record<string, { readonly driver: string; readonly config?: unknown }>>,
): boolean {
  return Object.entries(instances).some(([instanceId, instance]) => {
    if (instance.driver !== "acpRegistry") return false;
    if (instanceId === OMP_ACP_INSTANCE_ID) return true;
    if (instance.config === null || typeof instance.config !== "object") return false;
    const config = instance.config as Record<string, unknown>;
    const commandArgs = config.commandArgs;
    return (
      config.source === "local" &&
      config.commandPath === OMP_ACP_BUILTIN.commandPath &&
      Array.isArray(commandArgs) &&
      commandArgs[0] === OMP_ACP_BUILTIN.commandArgs[0]
    );
  });
}
