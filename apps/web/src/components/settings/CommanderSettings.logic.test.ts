import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { providerInstanceEntriesFor } from "../../providerInstances";
import {
  COMMANDER_DISPATCH_ROLES,
  COMMANDER_DISPATCH_SETTING_KEYS,
  COMMANDER_RESET_ALL_PATCH,
  canResetCommanderSettingRow,
  commanderResetRowPatch,
  hasAnyCommanderSettingToReset,
  parseDispatchConcurrencyLimitDraft,
  readCommanderDispatchSettings,
  resolveCommanderRoleModelPresentation,
} from "./CommanderSettings.logic";

const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const savedCodex = createModelSelection(codexId, "gpt-5.6");
const savedClaude = createModelSelection(claudeId, "claude-opus-4-8", [
  { id: "effort", value: "high" },
]);

function provider(input: {
  instanceId: string;
  driver: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  models: ReadonlyArray<string>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

const claudeAndCodex = [
  provider({ instanceId: "codex", driver: "codex", models: ["gpt-5.6"] }),
  provider({ instanceId: "claudeAgent", driver: "claudeAgent", models: ["claude-opus-4-8"] }),
];

describe("CommanderSettings logic", () => {
  it("exposes only the four dispatch role rows and five dispatch keys", () => {
    expect(COMMANDER_DISPATCH_ROLES.map((role) => role.role)).toEqual([
      "code",
      "review",
      "readonly",
      "plan",
    ]);
    expect(COMMANDER_DISPATCH_SETTING_KEYS).toEqual([
      "dispatchCodeModelSelection",
      "dispatchReviewModelSelection",
      "dispatchReadonlyModelSelection",
      "dispatchPlanModelSelection",
      "dispatchConcurrencyLimit",
    ]);
  });

  it("reads legacy settings missing dispatch keys as null defaults without throwing", () => {
    const decodedLegacy = decodeServerSettings({});
    expect(readCommanderDispatchSettings(decodedLegacy)).toEqual({
      dispatchCodeModelSelection: null,
      dispatchReviewModelSelection: null,
      dispatchReadonlyModelSelection: null,
      dispatchPlanModelSelection: null,
      dispatchConcurrencyLimit: null,
    });
    expect(readCommanderDispatchSettings({})).toEqual({
      dispatchCodeModelSelection: null,
      dispatchReviewModelSelection: null,
      dispatchReadonlyModelSelection: null,
      dispatchPlanModelSelection: null,
      dispatchConcurrencyLimit: null,
    });
  });

  it("parses concurrency limit drafts strictly", () => {
    expect(parseDispatchConcurrencyLimitDraft("")).toBeNull();
    expect(parseDispatchConcurrencyLimitDraft("   ")).toBeNull();
    expect(parseDispatchConcurrencyLimitDraft(" 3 ")).toBe(3);
    expect(parseDispatchConcurrencyLimitDraft("1")).toBe(1);
    expect(parseDispatchConcurrencyLimitDraft("0")).toBeUndefined();
    expect(parseDispatchConcurrencyLimitDraft("-2")).toBeUndefined();
    expect(parseDispatchConcurrencyLimitDraft("1.5")).toBeUndefined();
    expect(parseDispatchConcurrencyLimitDraft("abc")).toBeUndefined();
  });

  it("resolves role model presentation for inherited default, valid saved, and unavailable providers", () => {
    const settings: UnifiedSettings = { ...DEFAULT_UNIFIED_SETTINGS };
    const entries = providerInstanceEntriesFor(claudeAndCodex, settings, null);

    expect(
      resolveCommanderRoleModelPresentation({
        saved: null,
        fallbackSelection: savedCodex,
        entries,
        providers: claudeAndCodex,
        settings,
      }),
    ).toEqual({
      saved: null,
      selection: savedCodex,
      providerNote: null,
      usesDefault: true,
    });

    expect(
      resolveCommanderRoleModelPresentation({
        saved: savedClaude,
        fallbackSelection: savedCodex,
        entries,
        providers: claudeAndCodex,
        settings,
      }),
    ).toEqual({
      saved: savedClaude,
      selection: savedClaude,
      providerNote: null,
      usesDefault: false,
    });

    const claudeDisabledSettings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [claudeId]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: false },
      },
    };
    expect(
      resolveCommanderRoleModelPresentation({
        saved: savedClaude,
        fallbackSelection: savedCodex,
        entries: providerInstanceEntriesFor(claudeAndCodex, claudeDisabledSettings, null),
        providers: claudeAndCodex,
        settings: claudeDisabledSettings,
      }),
    ).toEqual({
      saved: savedClaude,
      selection: savedClaude,
      providerNote: "Claude 已关闭。",
      usesDefault: false,
    });

    const unavailableProviders = claudeAndCodex.map((entry) =>
      entry.instanceId === claudeId ? { ...entry, availability: "unavailable" as const } : entry,
    );
    expect(
      resolveCommanderRoleModelPresentation({
        saved: savedClaude,
        fallbackSelection: savedCodex,
        entries: providerInstanceEntriesFor(unavailableProviders, settings, null),
        providers: unavailableProviders,
        settings,
      }),
    ).toEqual({
      saved: savedClaude,
      selection: savedClaude,
      providerNote: "Claude 不可用。",
      usesDefault: false,
    });

    const withoutClaude = claudeAndCodex.filter((entry) => entry.instanceId !== claudeId);
    expect(
      resolveCommanderRoleModelPresentation({
        saved: savedClaude,
        fallbackSelection: savedCodex,
        entries: providerInstanceEntriesFor(withoutClaude, settings, null),
        providers: withoutClaude,
        settings,
      }),
    ).toEqual({
      saved: savedClaude,
      selection: savedClaude,
      providerNote: "此环境上没有这个提供方。",
      usesDefault: false,
    });
  });

  it("tracks single-row and reset-all availability in environment and project scopes", () => {
    const envId = EnvironmentId.make("env-1");
    const projectId = ProjectId.make("proj-1");
    const defaultSettings = decodeServerSettings({});
    const envTarget = {
      environmentId: envId,
      label: "Env 1",
      projectId: null,
      ...resolveProjectSettings(defaultSettings, null),
    };
    expect(
      canResetCommanderSettingRow({
        key: "dispatchCodeModelSelection",
        isProjectScope: false,
        targets: [envTarget],
        mixed: false,
      }),
    ).toBe(false);
    expect(hasAnyCommanderSettingToReset({ isProjectScope: false, targets: [envTarget] })).toBe(
      false,
    );

    const modifiedEnvSettings = {
      ...defaultSettings,
      dispatchCodeModelSelection: savedCodex,
      dispatchConcurrencyLimit: 4,
    };
    const modifiedEnvTarget = {
      environmentId: envId,
      label: "Env 1",
      projectId: null,
      ...resolveProjectSettings(modifiedEnvSettings, null),
    };
    expect(
      canResetCommanderSettingRow({
        key: "dispatchCodeModelSelection",
        isProjectScope: false,
        targets: [modifiedEnvTarget],
        mixed: false,
      }),
    ).toBe(true);
    expect(
      canResetCommanderSettingRow({
        key: "dispatchReviewModelSelection",
        isProjectScope: false,
        targets: [modifiedEnvTarget],
        mixed: false,
      }),
    ).toBe(false);
    expect(
      hasAnyCommanderSettingToReset({ isProjectScope: false, targets: [modifiedEnvTarget] }),
    ).toBe(true);

    // Project scope with only environment defaults has nothing overridden to reset.
    const inheritedProjectTarget = {
      environmentId: envId,
      label: "Env 1",
      projectId,
      ...resolveProjectSettings(modifiedEnvSettings, projectId),
    };
    expect(
      canResetCommanderSettingRow({
        key: "dispatchCodeModelSelection",
        isProjectScope: true,
        targets: [inheritedProjectTarget],
        mixed: false,
      }),
    ).toBe(false);
    expect(
      hasAnyCommanderSettingToReset({ isProjectScope: true, targets: [inheritedProjectTarget] }),
    ).toBe(false);

    // Project override (even overriding to null) is resettable back to environment default.
    const overriddenSettings = {
      ...modifiedEnvSettings,
      projectSettingsOverrides: {
        [projectId]: { dispatchCodeModelSelection: null },
      },
    };
    const overriddenProjectTarget = {
      environmentId: envId,
      label: "Env 1",
      projectId,
      ...resolveProjectSettings(overriddenSettings, projectId),
    };
    expect(
      canResetCommanderSettingRow({
        key: "dispatchCodeModelSelection",
        isProjectScope: true,
        targets: [overriddenProjectTarget],
        mixed: false,
      }),
    ).toBe(true);
    expect(
      hasAnyCommanderSettingToReset({ isProjectScope: true, targets: [overriddenProjectTarget] }),
    ).toBe(true);

    expect(commanderResetRowPatch("dispatchCodeModelSelection")).toEqual({
      dispatchCodeModelSelection: null,
    });
    expect(COMMANDER_RESET_ALL_PATCH).toEqual({
      dispatchCodeModelSelection: null,
      dispatchReviewModelSelection: null,
      dispatchReadonlyModelSelection: null,
      dispatchPlanModelSelection: null,
      dispatchConcurrencyLimit: null,
    });
  });
});
