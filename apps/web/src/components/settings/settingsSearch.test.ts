import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  makeProviderSettingsSchema,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { UNKNOWN_SOURCE_CONTROL_CLIENT } from "@t3tools/client-runtime/source-control-clients";
import * as Schema from "effect/Schema";

import {
  filterAvailableSettingsSearchItems,
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  movedSettingsRedirect,
  movedSettingsPath,
  searchSettings,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SEARCH_ITEMS,
  sourceControlHostSearchItems,
  sourceControlHostSettingsSearchId,
  type SettingsSearchItem,
} from "./settingsSearch";

const desktop = vi.hoisted(() => ({ enabled: false }));
vi.mock(import("~/env"), async (importOriginal) => ({
  ...(await importOriginal()),
  get isElectron() {
    return desktop.enabled;
  },
  isSecretsFeatureEnabled: false,
}));

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "自动换行",
    to: "/settings/general",
    searchTerms: ["long lines in code previews"],
  },
  {
    id: "network-access",
    title: "网络访问",
    to: "/settings/connections",
    searchTerms: ["remote pairing backend"],
  },
  {
    id: "providers",
    title: "智能体",
    to: "/settings/providers",
    searchTerms: ["claude codex agents"],
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches titles, sections, and remembered setting details", () => {
    expect(searchSettings("换行", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("网络", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("连接", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
    expect(searchSettings("long lines", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    const spanish = (message: string) => (message === "自动换行" ? "Ajuste de línea" : message);
    expect(searchSettings("ajuste", ITEMS, spanish).map((item) => item.id)).toEqual(["word-wrap"]);
    for (const query of ["fallback", "fallback agent", "备用模型"]) {
      expect(searchSettings(query)[0]).toMatchObject({
        id: "fallback-model",
        to: "/settings/threads",
        scope: "environment-defaults",
      });
    }
  });

  it("hides the Secrets page from nav and search while the secrets feature is disabled", () => {
    expect(SETTINGS_NAV_GROUPS.flatMap((group) => group.paths)).not.toContain("/settings/secrets");
    expect(searchSettings("vault").map((item) => item.to)).not.toContain("/settings/secrets");
  });

  it("finds the Scheduled tasks page", () => {
    expect(searchSettings("定时任务")[0]).toMatchObject({
      id: "scheduled-tasks",
      to: "/settings/scheduled-tasks",
    });
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  自动换行  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("字号").map((item) => item.id)).toEqual(["font-size"]);
    expect(searchSettings("主题")[0]?.id).toBe("theme");
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockReturnValue("gıt");
    try {
      expect(searchSettings("GIT")[0]?.id).toBe("git-fetch-interval");
      expect(localeLowerCase).not.toHaveBeenCalled();
    } finally {
      localeLowerCase.mockRestore();
    }
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("matches query words across fields and ranks the strongest result first", () => {
    expect(searchSettings("pairing remote", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(
      searchSettings("remote pairing")
        .slice(0, 2)
        .map((item) => item.id),
    ).toEqual(["network-access", "connections-environment"]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("hold to quit")).toEqual([]);
    expect(searchSettings("wsl")).toEqual([]);
    expect(searchSettings("update track")).toEqual([]);
  });

  it("does not offer the removed desktop update track in settings search", () => {
    desktop.enabled = true;
    try {
      expect(searchSettings("update track").map((item) => item.id)).not.toContain("update-track");
    } finally {
      desktop.enabled = false;
    }
  });

  it("hides settings whose controls are unavailable", () => {
    const available = filterAvailableSettingsSearchItems({
      hasEnvironment: false,
      hasProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    });

    const gatedIds = new Set<string>([
      "follow-change-request-templates",
      "git-fetch-interval",
      "network-access",
      "publish-agent-activity",
      "provider-health-check-interval",
      "source-control-writer-model",
      "source-control-writing-style",
      "hold-webhooks-while-offline",
      "tailscale-https",
      "wsl-backend",
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "days-before-auto-settle",
      "linked-environments",
    ]);
    expect(available.map((item) => item.id).filter((id) => gatedIds.has(id))).toEqual([]);
  });

  it("finds linked environments on a remote host without local maintenance access", () => {
    const availability = {
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      localEnvironmentDisabled: true,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
      hasMultipleEnvironments: true,
    };
    const results = (hasPeerLinkHost: boolean) =>
      searchSettings(
        "关联电脑",
        filterAvailableSettingsSearchItems({ ...availability, hasPeerLinkHost }),
      );
    expect(results(false).map((item) => item.id)).not.toContain("linked-environments");
    expect(results(true)).toContainEqual(
      expect.objectContaining({
        id: "linked-environments",
        to: "/settings/connections",
        targetId: "linked-environments",
      }),
    );
  });

  it("shows connection entries only once a second computer exists", () => {
    const availability = {
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: true,
      localEnvironmentDisabled: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
      hasPeerLinkHost: true,
      hasPrimaryEnvironment: true,
    };
    const ids = (hasMultipleEnvironments: boolean) =>
      filterAvailableSettingsSearchItems({ ...availability, hasMultipleEnvironments }).map(
        (item) => item.id,
      );
    const connectionIds = [
      "connections-environment",
      "linked-environments",
      "remote-environments",
      "load-balancing",
      "pull-request-routing",
    ];
    expect(ids(false).filter((id) => connectionIds.includes(id))).toEqual([]);
    expect(ids(true)).toEqual(expect.arrayContaining(connectionIds));
  });

  it("finds keybinding commands by label, command id, and default key", () => {
    expect(searchSettings("toggle sidebar")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("sidebar.toggle")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("mod+b")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("复制链接")[0]).toMatchObject({
      id: "keybinding-thread.copyReference",
      to: "/settings/general",
    });
  });

  it("sends commands without a default binding to the section", () => {
    expect(searchSettings("thread.stop")[0]).toMatchObject({
      id: "keybinding-thread.stop",
      targetId: "keybindings",
    });
    expect(searchSettings("sidebar.toggle")[0]?.targetId).toBeUndefined();
  });

  it("finds rows by the titles shown on their pages", () => {
    for (const [title, id] of [
      ["工作树清理", "storage-worktrees"],
      ["工作树位置", "storage-worktrees-location"],
      ["产物与日志", "storage-artifacts"],
      ["立即删除", "storage-delete-now"],
      ["智能体", "providers"],
      ["运行中发送", "follow-up-behavior"],
    ] as const) {
      expect(searchSettings(title)[0]?.id, title).toBe(id);
    }
    for (const query of ["排队", "立即发送", "steer"]) {
      expect(searchSettings(query).map((item) => item.id)).toContain("follow-up-behavior");
    }
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("settings search targets", () => {
  it("requires an environment for the resolved telemetry export destination", () => {
    const result = searchSettings("OpenTelemetry 导出").find(
      (item) => item.id === "telemetry-export",
    )!;
    const target = getSettingsSearchTargetScope(result.targetId ?? result.id)!;
    expect(isSettingsSearchScopeAvailable(target.scope, "all")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "project")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "environment")).toBe(true);
  });

  it("keeps environment-wide settings out of project scopes", () => {
    const updates = getSettingsSearchTargetScope("provider-update-checks")!;
    expect(updates.scope).toBe("environment-defaults");
    expect(isSettingsSearchScopeAvailable(updates.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "project")).toBe(false);
    const fallback = getSettingsSearchTargetScope("fallback-model")!;
    expect(fallback.scope).toBe("environment-defaults");
    expect(isSettingsSearchScopeAvailable(fallback.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(fallback.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(fallback.scope, "project")).toBe(false);
    for (const id of ["response-streaming", "auto-settle-inactive-threads"]) {
      expect(getSettingsSearchTargetScope(id)?.scope).toBe("project-defaults");
    }
    for (const scope of ["all", "environment", "project"] as const) {
      expect(isSettingsSearchScopeAvailable("project-defaults", scope)).toBe(true);
    }
    for (const id of ["tool-call-visibility", "working-shelf"]) {
      expect(getSettingsSearchTargetScope(id)!.scope).toBeNull();
    }
  });
});

describe("auto-settlement search availability", () => {
  function environment(id: string, { connected = true, loaded = true } = {}) {
    return {
      environmentId: EnvironmentId.make(id),
      connection: { phase: connected ? ("connected" as const) : ("offline" as const) },
      serverConfig: loaded ? { environment: { capabilities: {} } } : null,
    };
  }

  const capable = environment("capable");
  const offline = environment("offline", { connected: false });
  const loading = environment("loading", { loaded: false });
  const environments = [capable, offline, loading];

  it("keeps results discoverable when one connected environment supports them", () => {
    const availability = getThreadAutoSettlementSearchAvailability(environments);
    expect(availability.eligibleEnvironmentIds).toEqual([capable.environmentId]);
    const items = filterAvailableSettingsSearchItems({
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: availability.eligibleEnvironmentIds.length > 0,
    });
    expect(searchSettings("自动标为完成", items).map((item) => item.id)).toEqual([
      "days-before-auto-settle",
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
    ]);
    expect(searchSettings("保留有关联 PR", items).map((item) => item.id)).toContain(
      "keep-threads-with-pull-requests",
    );
  });

  it.each([offline, loading])(
    "does not render the target on $environmentId or silently fall back",
    (selected) => {
      expect(
        getThreadAutoSettlementSearchAvailability(environments, {
          kind: "environment",
          environmentIds: [selected.environmentId],
        }),
      ).toEqual({ eligibleEnvironmentIds: [capable.environmentId], isTargetAvailable: false });
    },
  );

  it("ignores offline and unloaded targets when all connected targets support the setting", () => {
    const selected = [capable, offline, loading];
    expect(
      getThreadAutoSettlementSearchAvailability(selected, {
        kind: "all",
        environmentIds: selected.map((entry) => entry.environmentId),
      }).isTargetAvailable,
    ).toBe(true);
  });
});

describe("source control host search items", () => {
  const definition = {
    ...UNKNOWN_SOURCE_CONTROL_CLIENT,
    kind: SourceControlProviderKind.make("example"),
    label: "Example",
    searchKeywords: ["sample"],
    settings: makeProviderSettingsSchema({ apiToken: Schema.String }),
  };

  it("lists a host by its label, its keywords, and its settings fields", () => {
    const items = sourceControlHostSearchItems([UNKNOWN_SOURCE_CONTROL_CLIENT, definition]);
    expect(items.map((item) => item.title)).toEqual(["Example 凭证"]);
    expect(searchSettings("sample apitoken", items).map((item) => item.id)).toEqual([
      sourceControlHostSettingsSearchId("example"),
    ]);
  });

  it("lists a host with credentials by its accounts, token and CLI", () => {
    const items = sourceControlHostSearchItems([
      {
        ...definition,
        credentials: {
          cliName: "ex",
          cliLabel: "Example CLI",
          loginCommand: "ex login",
          tokenEnvVar: "EX_TOKEN",
          tokenAccess: "access",
          newTokenUrl: (host) => `https://${host}/tokens`,
        },
      },
    ]);
    expect(items.map((item) => item.title)).toEqual(["Example 账户和 token"]);
    expect(searchSettings("ex switch accounts", items)).toHaveLength(1);
  });

  it("finds the built-in hosts by their own words", () => {
    expect(searchSettings("codeberg")).toEqual([]);
    expect(searchSettings("ghes").map((item) => item.id)).toContain(
      sourceControlHostSettingsSearchId("github"),
    );
  });
});

describe("movedSettingsPath", () => {
  it("sends old links to the page their row moved to", () => {
    expect(movedSettingsPath("/settings/general", "text-generation-model")).toBe(
      "/settings/threads",
    );
    expect(movedSettingsPath("/settings/general", "authorized-clients")).toBe(
      "/settings/connections",
    );
    expect(movedSettingsPath("/settings/connections", "local-environment")).toBeNull();
    expect(movedSettingsPath("/settings/source-control", "worktree-branch-naming")).toBe(
      "/settings/projects",
    );
    expect(movedSettingsPath("/settings/appearance", "chat-width")).toBeNull();
    expect(movedSettingsPath("/settings/connections", "wsl-backend")).toBeNull();
    expect(movedSettingsPath("/settings/storage", "storage-worktrees")).toBe("/settings/projects");
    expect(movedSettingsPath("/settings/storage", "")).toBe("/settings/maintenance");
    expect(movedSettingsPath("/settings/beta", "")).toBe("/settings/maintenance");
    expect(movedSettingsPath("/settings/labs", "")).toBe("/settings/maintenance");
    expect(movedSettingsPath("/settings/network", "")).toBe("/settings/general");
    expect(movedSettingsPath("/settings/keybindings", "keybindings")).toBe("/settings/general");
    expect(movedSettingsPath("/settings/chat", "composer")).toBe("/settings/threads");
    expect(movedSettingsPath("/settings/archived", "")).toBe("/settings/threads");
    expect(movedSettingsPath("/settings/diffs", "")).toBe("/settings/appearance");
    expect(movedSettingsPath("/settings/worktrees", "")).toBe("/settings/projects");
    expect(movedSettingsPath("/settings/access", "authorized-clients")).toBe(
      "/settings/connections",
    );
    expect(movedSettingsPath("/settings/secrets", "")).toBe("/settings/connections");
    expect(movedSettingsPath("/settings/about", "about")).toBe("/settings/maintenance");
  });
  it("carries default section anchors for bare moved paths", () => {
    expect(movedSettingsRedirect("/settings/network", "")).toEqual({
      to: "/settings/general",
      hash: "network",
    });
    expect(movedSettingsRedirect("/settings/keybindings", "")).toEqual({
      to: "/settings/general",
      hash: "keybindings",
    });
    expect(movedSettingsRedirect("/settings/worktrees", "")).toEqual({
      to: "/settings/projects",
      hash: "worktree-creation",
    });
    expect(movedSettingsRedirect("/settings/about", "")).toEqual({
      to: "/settings/maintenance",
      hash: "about",
    });
  });

  it("leaves current pages alone", () => {
    expect(movedSettingsPath("/settings/general", "time-format")).toBeNull();
    expect(movedSettingsPath("/settings/projects", "project-defaults")).toBeNull();
    expect(movedSettingsPath("/settings/connections", "remote-environments")).toBeNull();
    expect(movedSettingsPath("/settings/appearance", "theme")).toBeNull();
  });
});

describe("settings search keeps the names it used before the vocabulary change", () => {
  const OLD_NAME_CASES: ReadonlyArray<readonly [query: string, id: string]> = [
    ["聊天宽度", "chat-width"],
    ["提供方", "providers"],
    ["提供方实例", "providers"],
    ["账号", "providers"],
    ["用量数据提供方", "usage-providers"],
    ["环境图标", "environment-icon"],
    ["本地环境", "local-environment"],
    ["关联环境", "linked-environments"],
    ["环境", "remote-environments"],
    ["机器", "remote-environments"],
    ["主机", "remote-environments"],
    ["服务器", "remote-environments"],
    ["令牌", "connections-environment"],
    ["引导凭据", "connections-environment"],
    ["配对码", "connections-environment"],
    ["已授权的客户端", "connections-environment"],
    ["关联电脑", "remote-environments"],
  ];

  it.each(OLD_NAME_CASES)("finds the old name %s on %s", (query, id) => {
    desktop.enabled = true;
    try {
      const ids = searchSettings(query, SETTINGS_SEARCH_ITEMS).map((item) => item.id);
      expect(ids).toContain(id);
    } finally {
      desktop.enabled = false;
    }
  });
});
