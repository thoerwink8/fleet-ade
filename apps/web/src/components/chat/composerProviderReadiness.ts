import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";

export type ProviderReadinessBlockKind =
  | "no_agent"
  | "disabled"
  | "not_installed"
  | "unauthenticated"
  | "model_missing"
  | "models_empty"
  | "model_unavailable";

export interface ProviderReadinessBlock {
  readonly kind: ProviderReadinessBlockKind;
  readonly agentName: string;
  readonly instanceId: ProviderInstanceId | null;
  readonly reason: string;
  readonly primaryActionLabel: string | null;
  readonly primaryActionMode: "sign_in" | "install_help" | "setup" | null;
  readonly supportsInAppSetup: boolean;
}

export interface AlternativeReadyAgentOption {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly model: string;
}

export interface ComposerProviderReadiness {
  readonly block: ProviderReadinessBlock | null;
  readonly alternativeAgent: AlternativeReadyAgentOption | null;
}

type ProviderReadinessSnapshot = Pick<
  ServerProvider,
  "instanceId" | "driver" | "displayName" | "enabled" | "installed" | "auth" | "models" | "status"
> &
  Partial<Pick<ServerProvider, "setup">>;

function providerDisplayLabel(provider: Pick<ServerProvider, "displayName" | "driver">): string {
  const custom = provider.displayName?.trim();
  if (custom) return custom;
  switch (provider.driver) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "antigravity":
      return "Antigravity";
    case "grok":
      return "Grok";
    default:
      return "智能体";
  }
}

function hasInAppSetup(provider: ProviderReadinessSnapshot): boolean {
  return (
    provider.driver === "antigravity" ||
    provider.setup?.canAuthenticate === true ||
    provider.setup?.canInstall === true
  );
}

export function evaluateProviderInstanceReadiness(
  provider: ProviderReadinessSnapshot | null | undefined,
  selectedModel?: string | null,
): ProviderReadinessBlock | null {
  if (!provider) return null;
  const agentName = providerDisplayLabel(provider);
  const inAppSetup = hasInAppSetup(provider);

  if (!provider.enabled || provider.status === "disabled") {
    return {
      kind: "disabled",
      agentName,
      instanceId: provider.instanceId,
      reason: `${agentName} 已停用，无法发送消息。`,
      primaryActionLabel: "打开智能体设置",
      primaryActionMode: "setup",
      supportsInAppSetup: inAppSetup,
    };
  }
  if (!provider.installed) {
    return {
      kind: "not_installed",
      agentName,
      instanceId: provider.instanceId,
      reason: `这台电脑上没装 ${agentName}，无法发送消息。`,
      primaryActionLabel: "查看安装方法",
      primaryActionMode: "install_help",
      supportsInAppSetup: inAppSetup,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      kind: "unauthenticated",
      agentName,
      instanceId: provider.instanceId,
      reason: `${agentName} 还没登录，无法发送消息。`,
      primaryActionLabel: "去登录",
      primaryActionMode: "sign_in",
      supportsInAppSetup: inAppSetup,
    };
  }
  if (provider.driver === "antigravity") {
    const slug = (selectedModel ?? "").trim();
    if (slug.length === 0) {
      return {
        kind: "model_missing",
        agentName,
        instanceId: provider.instanceId,
        reason: `发送前请先选择 ${agentName} 模型。`,
        primaryActionLabel: null,
        primaryActionMode: null,
        supportsInAppSetup: inAppSetup,
      };
    }
    if (provider.auth.status === "unknown") {
      return null;
    }
    if (provider.models.length === 0) {
      return {
        kind: "models_empty",
        agentName,
        instanceId: provider.instanceId,
        reason: `发送前请先在智能体设置中刷新 ${agentName} 模型。`,
        primaryActionLabel: "去设置",
        primaryActionMode: "setup",
        supportsInAppSetup: inAppSetup,
      };
    }
    if (
      provider.status === "ready" &&
      slug !== ANTIGRAVITY_DEFAULT_MODEL &&
      !provider.models.some((entry) => entry.slug === slug || entry.aliases?.includes(slug))
    ) {
      return {
        kind: "model_unavailable",
        agentName,
        instanceId: provider.instanceId,
        reason: `该 ${agentName} 模型已不可用。请选择其他模型。`,
        primaryActionLabel: null,
        primaryActionMode: null,
        supportsInAppSetup: inAppSetup,
      };
    }
  }
  return null;
}

function isProviderEntryReadyToSend(entry: ProviderInstanceEntry): boolean {
  if (!entry.enabled || !entry.isAvailable) return false;
  if (!entry.snapshot.installed) return false;
  if (entry.snapshot.auth.status === "unauthenticated") return false;
  if (entry.snapshot.status === "disabled") return false;
  return true;
}

export function findAlternativeReadyProvider(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly currentInstanceId: ProviderInstanceId | null | undefined;
  readonly lockedProvider?: ProviderDriverKind | null;
  readonly lockedInstanceId?: ProviderInstanceId | null;
  readonly supportsProviderSwitchingViaHandoff?: boolean;
  readonly isTargetModelDisabled?: (instanceId: ProviderInstanceId, model: string) => boolean;
}): AlternativeReadyAgentOption | null {
  const lockedEntry =
    input.lockedInstanceId != null
      ? input.entries.find((entry) => entry.instanceId === input.lockedInstanceId)
      : undefined;
  const lockedGroupKey = lockedEntry?.continuationGroupKey ?? null;
  const requiresExactInstance =
    input.lockedProvider === "antigravity" &&
    input.lockedInstanceId != null &&
    lockedGroupKey === null;

  for (const entry of input.entries) {
    if (entry.instanceId === input.currentInstanceId) continue;
    if (!isProviderEntryReadyToSend(entry)) continue;
    if (!input.supportsProviderSwitchingViaHandoff && input.lockedProvider) {
      if (entry.driverKind !== input.lockedProvider) continue;
      if (lockedGroupKey !== null && entry.continuationGroupKey !== lockedGroupKey) continue;
      if (requiresExactInstance && entry.instanceId !== input.lockedInstanceId) continue;
    }
    const candidateModel =
      entry.models[0]?.slug ??
      (entry.driverKind === "antigravity" ? ANTIGRAVITY_DEFAULT_MODEL : "");
    if (
      candidateModel.length > 0 &&
      input.isTargetModelDisabled?.(entry.instanceId, candidateModel) === true
    ) {
      continue;
    }
    return {
      instanceId: entry.instanceId,
      driverKind: entry.driverKind,
      displayName: entry.displayName,
      model: candidateModel,
    };
  }
  return null;
}

export function evaluateComposerProviderReadiness(input: {
  readonly selectedEntry: ProviderInstanceEntry | undefined;
  readonly selectedModel: string | null | undefined;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly lockedProvider?: ProviderDriverKind | null;
  readonly lockedInstanceId?: ProviderInstanceId | null;
  readonly supportsProviderSwitchingViaHandoff?: boolean;
  readonly isTargetModelDisabled?: (instanceId: ProviderInstanceId, model: string) => boolean;
  readonly providersHydrated?: boolean;
}): ComposerProviderReadiness {
  if (input.providersHydrated === false) {
    return { block: null, alternativeAgent: null };
  }
  if (!input.selectedEntry) {
    const alternativeAgent = findAlternativeReadyProvider({
      entries: input.entries,
      currentInstanceId: null,
      lockedProvider: input.lockedProvider ?? null,
      lockedInstanceId: input.lockedInstanceId ?? null,
      ...(input.supportsProviderSwitchingViaHandoff === undefined
        ? {}
        : { supportsProviderSwitchingViaHandoff: input.supportsProviderSwitchingViaHandoff }),
      ...(input.isTargetModelDisabled === undefined
        ? {}
        : { isTargetModelDisabled: input.isTargetModelDisabled }),
    });
    return {
      block: {
        kind: "no_agent",
        agentName: "智能体",
        instanceId: null,
        reason: "还没有可用的智能体，无法发送消息。",
        primaryActionLabel: "去设置",
        primaryActionMode: "setup",
        supportsInAppSetup: false,
      },
      alternativeAgent,
    };
  }
  const block = evaluateProviderInstanceReadiness(
    input.selectedEntry.snapshot,
    input.selectedModel,
  );
  if (!block) {
    return { block: null, alternativeAgent: null };
  }
  const canSuggestAlternative =
    block.kind === "not_installed" || block.kind === "unauthenticated" || block.kind === "disabled";
  const alternativeAgent = canSuggestAlternative
    ? findAlternativeReadyProvider({
        entries: input.entries,
        currentInstanceId: input.selectedEntry.instanceId,
        lockedProvider: input.lockedProvider ?? null,
        lockedInstanceId: input.lockedInstanceId ?? null,
        ...(input.supportsProviderSwitchingViaHandoff === undefined
          ? {}
          : { supportsProviderSwitchingViaHandoff: input.supportsProviderSwitchingViaHandoff }),
        ...(input.isTargetModelDisabled === undefined
          ? {}
          : { isTargetModelDisabled: input.isTargetModelDisabled }),
      })
    : null;
  return { block, alternativeAgent };
}
