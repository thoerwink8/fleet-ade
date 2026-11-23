import "~/index.css";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { COMMANDER_DISPATCH_SETTING_KEYS } from "./CommanderSettings.logic";
import type { ScopedSettingsPatch } from "./scopedSettings";

const envId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("proj-1");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");

const PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.6",
        name: "GPT 5.6",
        isCustom: false,
        isDefault: true,
        capabilities: {},
      },
    ],
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: claudeId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        isCustom: false,
        isDefault: true,
        capabilities: {},
      },
    ],
    slashCommands: [],
    skills: [],
  },
];

const state = vi.hoisted(() => ({
  scopeKind: "environment" as "environment" | "project",
  rawSettings: {} as Record<string, unknown>,
  providers: [] as ReadonlyArray<ServerProvider>,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
  clearOverrides: vi.fn<(keys: readonly string[]) => void>(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePrimarySettingsAvailable: () => true,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => envId,
  usePrimaryEnvironment: (() => ({
    environmentId: envId,
    label: "本机",
    connection: { phase: "connected" },
    serverConfig: {
      settings: state.rawSettings,
      environment: { platform: "linux", capabilities: {} },
    },
  })) as never,
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: envId,
        label: "本机",
        connection: { phase: "connected" },
        serverConfig: {
          settings: state.rawSettings,
          environment: { platform: "linux", capabilities: {} },
        },
      },
    ],
    isReady: true,
  })) as never,
  useEnvironmentProviders: () => new Map([[envId, state.providers]]),
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set([envId]),
}));

function buildTargets() {
  const serverSettings = state.rawSettings as unknown as ServerSettings;
  const resolved =
    state.scopeKind === "project"
      ? resolveProjectSettings(serverSettings, projectId)
      : resolveProjectSettings(serverSettings, null);
  return {
    resolved,
    target: {
      environmentId: envId,
      label: "本机",
      projectId: state.scopeKind === "project" ? projectId : null,
      settings: resolved.settings,
      sources: resolved.sources,
    },
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: (() => {
    const { target } = buildTargets();
    const envEntry = {
      environmentId: envId,
      label: "本机",
      connection: { phase: "connected" },
      serverConfig: {
        settings: state.rawSettings,
        environment: { platform: "linux", capabilities: {} },
      },
    };
    return {
      scope: {
        kind: state.scopeKind,
        environmentIds: [envId],
        members: [],
      },
      groups: [],
      search: {},
      environments: [envEntry],
      connectedEnvironments: [envEntry],
      environment: envEntry,
      targets: [target],
      target,
      singleEnvironment: false,
      deviceOnly: false,
      selectScope: vi.fn(),
    };
  }) as never,
  useSettingsScope: (() => {
    const { target } = buildTargets();
    const envEntry = {
      environmentId: envId,
      label: "本机",
      connection: { phase: "connected" },
      serverConfig: {
        settings: state.rawSettings,
        environment: { platform: "linux", capabilities: {} },
      },
    };
    return {
      scope: {
        kind: state.scopeKind,
        environmentIds: [envId],
        members: [],
      },
      groups: [],
      search: {},
      environments: [envEntry],
      connectedEnvironments: [envEntry],
      environment: envEntry,
      targets: [target],
      target,
      singleEnvironment: false,
      deviceOnly: false,
      selectScope: vi.fn(),
    };
  }) as never,
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() =>
    buildTargets().resolved.settings as unknown as UnifiedSettings) as never,
  useScopedSettingsMixed: () => false,
  useScopedSettingSource: ((keys: readonly string[]) => {
    const { target } = buildTargets();
    const key = keys[0] as keyof typeof target.sources | undefined;
    return key ? (target.sources[key] ?? "environment") : "environment";
  }) as never,
  useScopedSettingsWriteAllowed: () => true,
  useUpdateScopedSettings: () => state.updateSettings,
  useClearScopedSettings: () => state.clearOverrides,
  useClearProjectOverrides: () => vi.fn(),
}));

import { CommanderSettingsSection } from "./CommanderSettings";

const content = () => (
  <StrictMode>
    <div className="p-4">
      <CommanderSettingsSection />
    </div>
  </StrictMode>
);

function setup(options?: {
  readonly scopeKind?: "environment" | "project";
  readonly rawSettings?: Record<string, unknown>;
}) {
  state.scopeKind = options?.scopeKind ?? "environment";
  state.providers = PROVIDERS;
  state.rawSettings = options?.rawSettings ?? { ...DEFAULT_UNIFIED_SETTINGS };
  state.updateSettings.mockReset();
  state.clearOverrides.mockReset();
}

describe("CommanderSettingsSection", () => {
  it("renders only the four role rows, concurrency limit, and reset controls", async () => {
    setup();
    await using screen = await render(content(), { router: "/settings/threads" });

    for (const heading of ["指挥", "写码", "复查", "只读查看", "出方案", "同时派出上限"]) {
      await expect.element(screen.getByRole("heading", { name: heading })).toBeVisible();
    }
    await expect.element(screen.getByRole("button", { name: "全部恢复" })).toBeDisabled();

    const text = screen.container.textContent ?? "";
    for (const excluded of [
      "派谁做",
      "沉默",
      "单次时限",
      "到点就停止",
      "指挥守则",
      "推送间隔",
      "状态词",
      "租约",
      "辅助环节",
    ]) {
      expect(text).not.toContain(excluded);
    }
  });

  it("displays defaults cleanly when legacy settings lack dispatch keys", async () => {
    const legacy = { ...DEFAULT_UNIFIED_SETTINGS } as Record<string, unknown>;
    for (const key of COMMANDER_DISPATCH_SETTING_KEYS) {
      delete legacy[key];
    }
    setup({ rawSettings: legacy });
    await using screen = await render(content(), { router: "/settings/threads" });

    for (const role of ["写码模型", "复查模型", "只读查看模型", "出方案模型"]) {
      await expect
        .element(screen.getByRole("button", { name: role }))
        .toHaveTextContent("跟随默认模型");
    }
    await expect.element(screen.getByRole("textbox", { name: "同时派出上限" })).toHaveValue("");
    await expect.element(screen.getByRole("button", { name: "全部恢复" })).toBeDisabled();
  });

  it("commits concurrency limit, resets a single row without touching others, and resets all in environment scope", async () => {
    setup({
      rawSettings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        dispatchCodeModelSelection: { instanceId: claudeId, model: "claude-opus-4-8" },
        dispatchConcurrencyLimit: 2,
      },
    });
    await using screen = await render(content(), { router: "/settings/threads" });

    const limitInput = screen.getByRole("textbox", { name: "同时派出上限" });
    await expect.element(limitInput).toHaveValue("2");
    await userEvent.clear(limitInput);
    await userEvent.type(limitInput, "4{Enter}");
    expect(state.updateSettings).toHaveBeenCalledWith({ dispatchConcurrencyLimit: 4 });

    state.updateSettings.mockClear();
    await userEvent.click(page.getByRole("button", { name: "将 写码 恢复为默认值" }));
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      dispatchCodeModelSelection: null,
    });

    state.updateSettings.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "全部恢复" }));
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      dispatchCodeModelSelection: null,
      dispatchReviewModelSelection: null,
      dispatchReadonlyModelSelection: null,
      dispatchPlanModelSelection: null,
      dispatchConcurrencyLimit: null,
    });
  });

  it("clears project overrides back to environment defaults on row reset and reset-all", async () => {
    setup({
      scopeKind: "project",
      rawSettings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        dispatchCodeModelSelection: { instanceId: codexId, model: "gpt-5.6" },
        dispatchConcurrencyLimit: 2,
        projectSettingsOverrides: {
          [projectId]: {
            dispatchCodeModelSelection: { instanceId: claudeId, model: "claude-opus-4-8" },
            dispatchConcurrencyLimit: 5,
          },
        },
      },
    });
    await using screen = await render(content(), { router: "/settings/threads" });

    await userEvent.click(page.getByRole("button", { name: "将 写码 恢复为默认值" }));
    expect(state.clearOverrides).toHaveBeenCalledExactlyOnceWith(["dispatchCodeModelSelection"]);
    expect(state.updateSettings).not.toHaveBeenCalled();

    state.clearOverrides.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "全部恢复" }));
    expect(state.clearOverrides).toHaveBeenCalledExactlyOnceWith(COMMANDER_DISPATCH_SETTING_KEYS);
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("fits within a 390px narrow mobile viewport without horizontal overflow", async () => {
    await page.viewport(390, 844);
    setup({
      rawSettings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        dispatchCodeModelSelection: { instanceId: claudeId, model: "claude-opus-4-8" },
        dispatchConcurrencyLimit: 3,
      },
    });
    await using _screen = await render(content(), { router: "/settings/threads" });

    await expect.element(page.getByRole("heading", { name: "指挥" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "全部恢复" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });
});
