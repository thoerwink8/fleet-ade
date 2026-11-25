import type {
  DispatchRole,
  ModelSelection,
  ProjectScopedServerSettingKey,
  ServerProvider,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { resolveEffectiveDefaultModelSelection } from "../../modelSelection";
import {
  resolveDefaultProviderModelSelection,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import {
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ScopedSettingsTarget,
} from "./scopedSettings";

export type CommanderDispatchRoleKey =
  | "dispatchCodeModelSelection"
  | "dispatchReviewModelSelection"
  | "dispatchReadonlyModelSelection"
  | "dispatchPlanModelSelection";

export type CommanderDispatchSettingKey = CommanderDispatchRoleKey | "dispatchConcurrencyLimit";

export interface CommanderDispatchRoleConfig {
  readonly role: DispatchRole;
  readonly key: CommanderDispatchRoleKey;
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export const COMMANDER_DISPATCH_ROLES: ReadonlyArray<CommanderDispatchRoleConfig> = [
  {
    role: "code",
    key: "dispatchCodeModelSelection",
    id: "commander-dispatch-code",
    title: "写码",
    description: "负责修改代码和跑验证；留空时跟随默认模型。",
  },
  {
    role: "review",
    key: "dispatchReviewModelSelection",
    id: "commander-dispatch-review",
    title: "复查",
    description: "负责代码审查与挑错；留空时跟随默认模型。",
  },
  {
    role: "readonly",
    key: "dispatchReadonlyModelSelection",
    id: "commander-dispatch-readonly",
    title: "只读查看",
    description: "负责检索、阅读和调研；留空时跟随默认模型。",
  },
  {
    role: "plan",
    key: "dispatchPlanModelSelection",
    id: "commander-dispatch-plan",
    title: "出方案",
    description: "负责分析需求和拟定计划；留空时跟随默认模型。",
  },
];

export const COMMANDER_DISPATCH_SETTING_KEYS: readonly (CommanderDispatchSettingKey &
  ProjectScopedServerSettingKey)[] = [
  "dispatchCodeModelSelection",
  "dispatchReviewModelSelection",
  "dispatchReadonlyModelSelection",
  "dispatchPlanModelSelection",
  "dispatchConcurrencyLimit",
];

export const COMMANDER_RESET_ALL_PATCH: ServerSettingsPatch = {
  dispatchCodeModelSelection: null,
  dispatchReviewModelSelection: null,
  dispatchReadonlyModelSelection: null,
  dispatchPlanModelSelection: null,
  dispatchConcurrencyLimit: null,
};

export interface CommanderDispatchSettingsValues {
  readonly dispatchCodeModelSelection: ModelSelection | null;
  readonly dispatchReviewModelSelection: ModelSelection | null;
  readonly dispatchReadonlyModelSelection: ModelSelection | null;
  readonly dispatchPlanModelSelection: ModelSelection | null;
  readonly dispatchConcurrencyLimit: number | null;
}

/** Reads dispatch settings defensively so legacy snapshots without these keys default to null. */
export function readCommanderDispatchSettings(
  settings: Partial<ServerSettings>,
): CommanderDispatchSettingsValues {
  return {
    dispatchCodeModelSelection: settings.dispatchCodeModelSelection ?? null,
    dispatchReviewModelSelection: settings.dispatchReviewModelSelection ?? null,
    dispatchReadonlyModelSelection: settings.dispatchReadonlyModelSelection ?? null,
    dispatchPlanModelSelection: settings.dispatchPlanModelSelection ?? null,
    dispatchConcurrencyLimit: settings.dispatchConcurrencyLimit ?? null,
  };
}

export function parseDispatchConcurrencyLimitDraft(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export function commanderResetRowPatch(key: CommanderDispatchSettingKey): ServerSettingsPatch {
  return { [key]: null };
}

export interface CommanderRoleModelPresentation {
  readonly saved: ModelSelection | null;
  readonly selection: ModelSelection | null;
  readonly providerNote: string | null;
  readonly usesDefault: boolean;
}

function providerNote(entry: ProviderInstanceEntry | undefined): string {
  if (!entry) return "这台电脑上没有这个智能体。";
  if (!entry.enabled) return `${entry.displayName} 已关闭。`;
  return `${entry.displayName} 不可用。`;
}

export function resolveCommanderRoleModelPresentation(input: {
  readonly saved: ModelSelection | null;
  readonly fallbackSelection: ModelSelection | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): CommanderRoleModelPresentation {
  if (input.saved === null) {
    return {
      saved: null,
      selection: input.fallbackSelection,
      providerNote: null,
      usesDefault: true,
    };
  }
  const savedEntry = input.entries.find((entry) => entry.instanceId === input.saved?.instanceId);
  const resolved = resolveDefaultProviderModelSelection(input.providers, input.saved);
  if (
    !savedEntry?.enabled ||
    !savedEntry.isAvailable ||
    resolved?.instanceId !== input.saved.instanceId
  ) {
    return {
      saved: input.saved,
      selection: input.saved,
      providerNote: providerNote(savedEntry),
      usesDefault: false,
    };
  }
  return {
    saved: input.saved,
    selection: resolveEffectiveDefaultModelSelection(input.settings, input.providers, resolved),
    providerNote: null,
    usesDefault: false,
  };
}

export function canResetCommanderSettingRow(input: {
  readonly key: CommanderDispatchSettingKey;
  readonly isProjectScope: boolean;
  readonly targets: readonly Pick<ScopedSettingsTarget, "settings" | "sources">[];
  readonly mixed: boolean;
}): boolean {
  if (input.isProjectScope) {
    const source = scopedSettingsSource(input.targets, [input.key]);
    return source === "project" || source === "mixed";
  }
  if (input.mixed) return true;
  return input.targets.some((target) => (target.settings[input.key] ?? null) !== null);
}

export function hasAnyCommanderSettingToReset(input: {
  readonly isProjectScope: boolean;
  readonly targets: readonly Pick<ScopedSettingsTarget, "settings" | "sources">[];
}): boolean {
  return COMMANDER_DISPATCH_SETTING_KEYS.some((key) =>
    canResetCommanderSettingRow({
      key,
      isProjectScope: input.isProjectScope,
      targets: input.targets,
      mixed: scopedSettingsAreMixed(input.targets, [key]),
    }),
  );
}
