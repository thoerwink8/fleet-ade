import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { providerSetupGuidance } from "./providerSetupGuidance.logic";

const provider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-11-25T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  message: "还没装 Claude Code，装好后会自动识别。",
  setup: {
    canAuthenticate: false,
    canInstall: false,
    documentationUrl: "https://code.claude.com/docs/en/setup#install-claude-code",
  },
} satisfies ServerProvider;

describe("provider setup guidance", () => {
  it("links official installation help when Claude is not installed", () => {
    expect(
      providerSetupGuidance({
        provider,
        environmentLabel: "办公室电脑",
      }),
    ).toEqual({
      message: "还没装 Claude Code，装好后会自动识别。",
      action: {
        kind: "documentation",
        label: "查看安装方法",
        url: "https://code.claude.com/docs/en/setup#install-claude-code",
      },
    });
  });

  it("names the server computer for an installed but signed-out Claude", () => {
    expect(
      providerSetupGuidance({
        provider: {
          ...provider,
          installed: true,
          auth: { status: "unauthenticated" },
          setup: { canAuthenticate: true, canInstall: false },
          message: "Claude Code 未登录。请运行 `claude auth login` 后重试。",
        },
        environmentLabel: "办公室电脑",
      }),
    ).toEqual({
      message: "在 办公室电脑 上登录 Claude。",
      action: { kind: "authenticate", label: "登录" },
    });
  });
});
