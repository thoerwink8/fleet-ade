import {
  DEV_REPLAY_INSTANCE_ID,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

export type AgentSetupState = "not_installed" | "signed_out" | "error" | "disabled";

export interface AgentSetupProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName?: string | undefined;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: ServerProvider["status"];
  readonly authStatus: ServerProvider["auth"]["status"];
  readonly availability?: string | undefined;
  readonly message?: string | undefined;
  readonly canAuthenticate?: boolean | undefined;
  readonly canInstall?: boolean | undefined;
}

export interface AgentSetupRow {
  readonly instanceId: string;
  readonly driver: string;
  readonly name: string;
  readonly state: AgentSetupState;
  readonly settingsHash: string;
}

export interface AgentSetupCardModel {
  readonly title: string;
  readonly rows: readonly AgentSetupRow[];
}

export const AGENT_SETUP_STATUS_LABEL: Readonly<Record<AgentSetupState, string>> = {
  not_installed: "没装",
  signed_out: "没登录",
  error: "出错",
  disabled: "已停用",
};

export const AGENT_SETUP_ACTION_LABEL: Readonly<Record<AgentSetupState, string>> = {
  not_installed: "去设置",
  signed_out: "去登录",
  error: "去查看",
  disabled: "去启用",
};

const DRIVER_ORDER = ["codex", "claudeAgent", "grok", "antigravity", "acpRegistry"] as const;

export function toAgentSetupProvider(provider: ServerProvider): AgentSetupProvider {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName ? { displayName: provider.displayName } : {}),
    enabled: provider.enabled,
    installed: provider.installed,
    status: provider.status,
    authStatus: provider.auth.status,
    ...(provider.availability ? { availability: provider.availability } : {}),
    ...(provider.message ? { message: provider.message } : {}),
    ...(provider.setup
      ? {
          canAuthenticate: provider.setup.canAuthenticate,
          canInstall: provider.setup.canInstall,
        }
      : {}),
  };
}

function isChecking(provider: AgentSetupProvider): boolean {
  if (!provider.enabled || provider.status === "disabled") return false;
  const message = provider.message ?? "";
  return message.includes("正在检查") || message.includes("还没有检查");
}

function isUsable(provider: AgentSetupProvider): boolean {
  if (isChecking(provider) || !provider.enabled || provider.status === "disabled") return false;
  if (provider.status === "error" || !provider.installed) return false;
  if (provider.availability === "unavailable") return false;
  if (provider.authStatus === "unauthenticated") return false;
  if (provider.status === "ready") return true;
  return (
    provider.status === "warning" &&
    (provider.authStatus === "authenticated" || provider.driver === "antigravity")
  );
}

function setupState(provider: AgentSetupProvider): AgentSetupState {
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (!provider.installed) return "not_installed";
  if (provider.authStatus === "unauthenticated") return "signed_out";
  return "error";
}

function settingsHash(provider: AgentSetupProvider, state: AgentSetupState): string {
  const opensSetup =
    (provider.canAuthenticate === true || provider.canInstall === true) &&
    (state === "not_installed" || state === "signed_out");
  return `provider-instance-${provider.instanceId}-${opensSetup ? "setup" : "status"}`;
}

function providerName(provider: AgentSetupProvider): string {
  const displayName = provider.displayName?.trim();
  if (displayName) return displayName;
  return PROVIDER_DISPLAY_NAMES[provider.driver as ProviderDriverKind] ?? provider.driver;
}

function driverRank(driver: string): number {
  const index = DRIVER_ORDER.indexOf(driver as (typeof DRIVER_ORDER)[number]);
  return index === -1 ? DRIVER_ORDER.length : index;
}

export function resolveAgentSetupCard(input: {
  readonly providers: readonly AgentSetupProvider[];
  readonly catalogKnown: boolean;
  readonly computerName: string | null;
}): AgentSetupCardModel | null {
  if (!input.catalogKnown) return null;
  const real = input.providers.filter((provider) => provider.instanceId !== DEV_REPLAY_INSTANCE_ID);
  if (real.some(isUsable) || real.some(isChecking)) return null;
  const rows = real
    .map((provider) => {
      const state = setupState(provider);
      return {
        instanceId: provider.instanceId,
        driver: provider.driver,
        name: providerName(provider),
        state,
        settingsHash: settingsHash(provider, state),
      };
    })
    .sort(
      (left, right) =>
        driverRank(left.driver) - driverRank(right.driver) ||
        left.name.localeCompare(right.name, "zh"),
    );
  return {
    title: input.computerName
      ? `先在「${input.computerName}」上装或登录一个智能体`
      : "先装或登录一个智能体",
    rows,
  };
}
