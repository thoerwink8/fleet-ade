import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_SETUP_ACTION_LABEL,
  AGENT_SETUP_STATUS_LABEL,
  type AgentSetupProvider,
  resolveAgentSetupCard,
} from "./agentSetupCard.logic";

function provider(
  instanceId: string,
  driver: string,
  overrides: Partial<AgentSetupProvider> = {},
): AgentSetupProvider {
  return {
    instanceId,
    driver,
    displayName: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    authStatus: "authenticated",
    ...overrides,
  };
}

describe("resolveAgentSetupCard", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly providers: readonly AgentSetupProvider[];
    readonly catalogKnown?: boolean;
    readonly computerName?: string | null;
    readonly configured?: readonly string[];
    readonly shown: boolean;
    readonly title?: string;
    readonly rows?: ReadonlyArray<readonly [string, string, string, string]>;
  }> = [
    {
      name: "hides while the snapshot has not arrived",
      providers: [],
      catalogKnown: false,
      shown: false,
    },
    {
      name: "hides when one real agent can be used",
      providers: [provider("codex", "codex", { displayName: "Codex" })],
      shown: false,
    },
    {
      name: "does not treat Replay as a real usable agent",
      providers: [
        provider("devReplay", "acpRegistry", { displayName: "Replay (dev)" }),
        provider("claudeAgent", "claudeAgent", {
          displayName: "Claude",
          installed: false,
          status: "warning",
          authStatus: "unknown",
        }),
      ],
      shown: true,
      rows: [["claudeAgent", "Claude", "not_installed", "provider-instance-claudeAgent-status"]],
    },
    {
      name: "hides when an installed Codex warns and its sign-in is merely unchecked",
      providers: [
        provider("codex", "codex", {
          displayName: "Codex",
          status: "warning",
          authStatus: "unknown",
        }),
      ],
      shown: false,
    },
    {
      name: "hides when Antigravity is installed and its sign-in is merely unchecked",
      providers: [
        provider("antigravity", "antigravity", {
          displayName: "Antigravity",
          status: "warning",
          authStatus: "unknown",
        }),
      ],
      shown: false,
    },
    {
      name: "waits instead of flashing while a check is still running",
      providers: [
        provider("codex", "codex", {
          displayName: "Codex",
          installed: false,
          status: "warning",
          authStatus: "unknown",
          message: "正在检查 Codex 是否可用。",
        }),
      ],
      shown: false,
    },
    {
      name: "names the remote computer and lists each settled agent once",
      computerName: "工作室",
      providers: [
        provider("grok", "grok", {
          displayName: "Grok",
          status: "error",
          authStatus: "unknown",
          message: "执行 Grok CLI 健康检查失败。",
        }),
        provider("codex", "codex", {
          displayName: "Codex",
          installed: false,
          status: "warning",
          authStatus: "unknown",
        }),
        provider("antigravity", "antigravity", {
          displayName: "Antigravity",
          enabled: false,
          status: "disabled",
          canAuthenticate: true,
          canInstall: true,
        }),
        provider("claudeAgent", "claudeAgent", {
          displayName: "Claude",
          status: "error",
          authStatus: "unauthenticated",
        }),
        provider("cursor", "acpRegistry", {
          displayName: "Cursor",
          authStatus: "unauthenticated",
          canAuthenticate: true,
        }),
        provider("devReplay", "acpRegistry", { displayName: "Replay (dev)" }),
      ],
      shown: true,
      configured: ["antigravity"],
      title: "先在「工作室」上装或登录一个智能体",
      rows: [
        ["codex", "Codex", "not_installed", "provider-instance-codex-status"],
        ["claudeAgent", "Claude", "signed_out", "provider-instance-claudeAgent-status"],
        ["grok", "Grok", "error", "provider-instance-grok-status"],
        ["antigravity", "Antigravity", "disabled", "provider-instance-antigravity-status"],
        ["cursor", "Cursor", "signed_out", "provider-instance-cursor-setup"],
      ],
    },
    {
      name: "sends an in-app install to the setup section",
      providers: [
        provider("antigravity", "antigravity", {
          displayName: "Antigravity",
          installed: false,
          status: "warning",
          authStatus: "unknown",
          canInstall: true,
          canAuthenticate: true,
        }),
      ],
      shown: true,
      rows: [
        ["antigravity", "Antigravity", "not_installed", "provider-instance-antigravity-setup"],
      ],
    },
    {
      name: "keeps a warning with a signed-in account usable",
      providers: [
        provider("grok", "grok", {
          displayName: "Grok",
          status: "warning",
          message: "Grok CLI 已安装，但 ACP 初始化失败，模型选项可能不完整。",
        }),
      ],
      shown: false,
    },
    {
      name: "treats an unavailable snapshot as an error even when it says ready",
      providers: [
        provider("codex", "codex", { displayName: "Codex", availability: "unavailable" }),
      ],
      shown: true,
      rows: [["codex", "Codex", "error", "provider-instance-codex-status"]],
    },
    {
      name: "leaves out a stopped agent that agent settings has no row for",
      providers: [
        provider("grok", "grok", { displayName: "Grok", enabled: false, status: "disabled" }),
        provider("codex", "codex", { displayName: "Codex", enabled: false, status: "disabled" }),
      ],
      shown: true,
      rows: [["codex", "Codex", "disabled", "provider-instance-codex-status"]],
    },
    {
      name: "offers the settings page when the catalog has no real agents",
      providers: [provider("devReplay", "acpRegistry", { displayName: "Replay (dev)" })],
      shown: true,
      rows: [],
    },
  ];

  it.each(cases)("$name", (entry) => {
    const card = resolveAgentSetupCard({
      providers: entry.providers,
      catalogKnown: entry.catalogKnown ?? true,
      computerName: entry.computerName ?? null,
      configuredInstanceIds: new Set(entry.configured ?? []),
    });
    if (!entry.shown) {
      expect(card).toBeNull();
      return;
    }
    expect(card?.title).toBe(entry.title ?? "先装或登录一个智能体");
    expect(
      card?.rows.map((row) => [row.instanceId, row.name, row.state, row.settingsHash]),
    ).toEqual(entry.rows ?? []);
  });

  it("uses one short status and one destination label", () => {
    expect(AGENT_SETUP_STATUS_LABEL).toEqual({
      not_installed: "没装",
      signed_out: "没登录",
      error: "出错",
      disabled: "已停用",
    });
    expect(AGENT_SETUP_ACTION_LABEL).toEqual({
      not_installed: "去设置",
      signed_out: "去登录",
      error: "去查看",
      disabled: "去启用",
    });
  });
});
