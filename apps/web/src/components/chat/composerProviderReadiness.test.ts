import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  evaluateComposerProviderReadiness,
  evaluateProviderInstanceReadiness,
  findAlternativeReadyProvider,
} from "./composerProviderReadiness";

function makeEntry(
  id: string,
  driver: string,
  displayName: string,
  overrides: Partial<ServerProvider> = {},
): ProviderInstanceEntry {
  const snapshot: ServerProvider = {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-24T00:00:00.000Z",
    models: [
      {
        slug: `${id}-default`,
        name: `${displayName} Default`,
        isCustom: false,
        capabilities: null,
      },
    ],
    skills: [],
    slashCommands: [],
    ...overrides,
  };
  return {
    instanceId: snapshot.instanceId,
    driverKind: snapshot.driver,
    displayName,
    isDefault: id === driver,
    enabled: snapshot.enabled,
    installed: snapshot.installed,
    isAvailable: snapshot.enabled && snapshot.installed,
    status: snapshot.status,
    snapshot,
    models: snapshot.models,
    continuationGroupKey: undefined,
  };
}

describe("composerProviderReadiness", () => {
  it("blocks unauthenticated non-Antigravity agents and provides both sign-in and alternative exits", () => {
    const codexUnauthenticated = makeEntry("codex", "codex", "Codex", {
      status: "error",
      auth: { status: "unauthenticated" },
    });
    const claudeReady = makeEntry("claudeAgent", "claudeAgent", "Claude");

    const readiness = evaluateComposerProviderReadiness({
      selectedEntry: codexUnauthenticated,
      selectedModel: "gpt-5.4",
      entries: [codexUnauthenticated, claudeReady],
    });

    expect(readiness.block).toMatchObject({
      kind: "unauthenticated",
      reason: "Codex 还没登录，无法发送消息。",
      primaryActionLabel: "去登录",
      primaryActionMode: "sign_in",
    });
    expect(readiness.alternativeAgent).toMatchObject({
      instanceId: claudeReady.instanceId,
      displayName: "Claude",
    });
  });

  it("omits alternative exit when no other agent is ready", () => {
    const codexNotInstalled = makeEntry("codex", "codex", "Codex", {
      installed: false,
      status: "error",
      auth: { status: "unknown" },
    });
    const claudeAlsoLoggedOut = makeEntry("claudeAgent", "claudeAgent", "Claude", {
      status: "error",
      auth: { status: "unauthenticated" },
    });

    const readiness = evaluateComposerProviderReadiness({
      selectedEntry: codexNotInstalled,
      selectedModel: "gpt-5.4",
      entries: [codexNotInstalled, claudeAlsoLoggedOut],
    });

    expect(readiness.block).toMatchObject({
      kind: "not_installed",
      reason: "这台电脑上没装 Codex，无法发送消息。",
      primaryActionLabel: "查看安装方法",
      primaryActionMode: "install_help",
    });
    expect(readiness.alternativeAgent).toBeNull();
  });

  it("allows Antigravity while installed auth status is unknown until session start", () => {
    const antigravity = makeEntry("antigravity", "antigravity", "Antigravity", {
      status: "warning",
      auth: { status: "unknown" },
    });

    expect(evaluateProviderInstanceReadiness(antigravity.snapshot, "gemini-pro")).toBeNull();
  });

  it("returns no_agent block when no entry is selected", () => {
    const readiness = evaluateComposerProviderReadiness({
      selectedEntry: undefined,
      selectedModel: "",
      entries: [],
    });

    expect(readiness.block).toMatchObject({
      kind: "no_agent",
      reason: "还没有可用的智能体，无法发送消息。",
      primaryActionLabel: "去设置",
    });
    expect(readiness.alternativeAgent).toBeNull();
  });

  it("respects locked provider constraints when suggesting an alternative", () => {
    const codexPersonal = makeEntry("codex", "codex", "Codex 个人", {
      status: "error",
      auth: { status: "unauthenticated" },
    });
    const claudeReady = makeEntry("claudeAgent", "claudeAgent", "Claude");

    expect(
      findAlternativeReadyProvider({
        entries: [codexPersonal, claudeReady],
        currentInstanceId: codexPersonal.instanceId,
        lockedProvider: ProviderDriverKind.make("codex"),
        supportsProviderSwitchingViaHandoff: false,
      }),
    ).toBeNull();

    expect(
      findAlternativeReadyProvider({
        entries: [codexPersonal, claudeReady],
        currentInstanceId: codexPersonal.instanceId,
        lockedProvider: ProviderDriverKind.make("codex"),
        supportsProviderSwitchingViaHandoff: true,
      }),
    )?.toMatchObject({ displayName: "Claude" });
  });
});
