import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettingsPatch,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  settings: null as unknown as UnifiedSettings,
  canWriteSettings: true,
  updateSettings: vi.fn<(patch: ServerSettingsPatch) => void>(),
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_environmentId: EnvironmentId) => state.settings) as never,
  useUpdateEnvironmentSettings: ((_environmentId: EnvironmentId) => state.updateSettings) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canWriteSettings,
}));

import { PipelineModelsSettings } from "./PipelineModelsSettings";

const environmentId = EnvironmentId.make("remote-device");
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: claudeId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-23T00:00:00.000Z",
    models: [
      { slug: "claude-sonnet-4", name: "Claude Sonnet 4", isCustom: false, capabilities: null },
      { slug: "claude-opus-4", name: "Claude Opus 4", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-23T00:00:00.000Z",
    models: [{ slug: "gpt-6-luna", name: "GPT-6 Luna", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
];

function view(readOnly = false) {
  return (
    <PipelineModelsSettings
      environmentId={environmentId}
      providers={providers}
      readOnly={readOnly}
    />
  );
}

async function setup(overrides?: Partial<UnifiedSettings>, readOnly = false) {
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, ...overrides };
  state.canWriteSettings = true;
  const screen = await render(view(readOnly));
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.settings = { ...state.settings, ...(patch as Partial<UnifiedSettings>) };
    void screen.rerender(view(readOnly));
  });
  return screen;
}

describe("PipelineModelsSettings", () => {
  it("renders empty state when settings omit or clear candidate lists", async () => {
    await using screen = await setup();
    await expect.element(screen.getByText("流水线模型")).toBeVisible();
    expect(screen.container.textContent).toContain("还没有候选模型。");
  });

  it("adds, reorders, removes, and resets ordered candidates via settings RPC", async () => {
    await using screen = await setup();

    await userEvent.click(screen.getByRole("button", { name: "流水线写单模型：添加候选模型" }));
    await userEvent.click(page.getByRole("option", { name: /Claude Sonnet 4/ }));
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      pipelineAuthorModel: [{ instanceId: claudeId, model: "claude-sonnet-4" }],
    });

    await userEvent.click(screen.getByRole("button", { name: "流水线写单模型：添加候选模型" }));
    await userEvent.click(page.getByRole("option", { name: /Claude Opus 4/ }));
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      pipelineAuthorModel: [
        { instanceId: claudeId, model: "claude-sonnet-4" },
        { instanceId: claudeId, model: "claude-opus-4" },
      ],
    });

    await userEvent.click(screen.getByRole("button", { name: "上移 Claude Opus 4" }));
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      pipelineAuthorModel: [
        { instanceId: claudeId, model: "claude-opus-4" },
        { instanceId: claudeId, model: "claude-sonnet-4" },
      ],
    });

    await userEvent.click(screen.getByRole("button", { name: "移除 Claude Sonnet 4" }));
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      pipelineAuthorModel: [{ instanceId: claudeId, model: "claude-opus-4" }],
    });

    await userEvent.click(screen.getByRole("button", { name: "将 写单模型 恢复为默认值" }));
    expect(state.updateSettings).toHaveBeenLastCalledWith({ pipelineAuthorModel: [] });
  });

  it("warns when verifier and author share the first candidate and hides editors when read-only", async () => {
    await using screen = await setup(
      {
        pipelineAuthorModel: [{ instanceId: claudeId, model: "claude-sonnet-4" }],
        pipelineVerifierModel: [{ instanceId: claudeId, model: "claude-sonnet-4" }],
      },
      true,
    );

    await expect
      .element(
        screen.getByText(
          "第一个可用验单模型与写单模型相同，验单会停在“没配模型”。请更换其中一个。",
        ),
      )
      .toBeVisible();
    expect(
      screen.container.querySelector('button[aria-label="流水线写单模型：添加候选模型"]'),
    ).toBeNull();
    await expect
      .element(screen.getByRole("button", { name: "移除 Claude Sonnet 4" }).first())
      .toBeDisabled();
  });
});
