import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { providerSetupGuidance } from "./providerSetupGuidance.logic";

const provider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-11-25T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  message: "any copy at all",
  setup: { canAuthenticate: true, canInstall: false },
} satisfies ServerProvider;

describe("provider setup guidance", () => {
  it("names the server computer for an installed but signed-out Claude, whatever the message says", () => {
    for (const message of ["Claude Code 未登录。", "reworded copy", undefined]) {
      expect(
        providerSetupGuidance({
          provider: { ...provider, message },
          environmentLabel: "办公室电脑",
        }),
      ).toEqual({
        message: "在 办公室电脑 上登录 Claude。",
        action: { kind: "authenticate", label: "登录" },
      });
    }
  });

  it("offers no sign-in when the server does not open it", () => {
    expect(
      providerSetupGuidance({
        provider: { ...provider, setup: { canAuthenticate: false, canInstall: false } },
        environmentLabel: "办公室电脑",
      }).action,
    ).toBeNull();
    expect(
      providerSetupGuidance({
        provider: { ...provider, auth: { status: "authenticated" } },
        environmentLabel: "办公室电脑",
      }).action,
    ).toBeNull();
  });

  it("keeps the server message and no action for a missing reclaude", () => {
    expect(
      providerSetupGuidance({
        provider: {
          ...provider,
          auth: { status: "unknown" },
          message: "未找到 reclaude，Claude 渠道未启用。",
          setup: { canAuthenticate: false, canInstall: false },
        },
        environmentLabel: "办公室电脑",
      }),
    ).toEqual({ message: "未找到 reclaude，Claude 渠道未启用。", action: null });
  });

  it("leaves other providers alone", () => {
    expect(
      providerSetupGuidance({
        provider: { ...provider, driver: ProviderDriverKind.make("codex") },
        environmentLabel: "办公室电脑",
      }).action,
    ).toBeNull();
  });
});
