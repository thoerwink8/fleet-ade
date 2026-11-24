import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderFailureClass,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  classifyProviderError,
  type AlternativeReadyAgent,
  type ClassifyProviderErrorInput,
} from "./providerErrorClassification";

const alternativeClaude: AlternativeReadyAgent = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  displayName: "Claude",
};

function makeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "error",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-24T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
    ...overrides,
  };
}

describe("classifyProviderError", () => {
  it.each<{
    readonly name: string;
    readonly input: ClassifyProviderErrorInput;
    readonly expectedCategory: string;
    readonly expectedMessage: string;
    readonly expectedActionLabel: string | null;
    readonly expectedVariant: "warning" | "error";
  }>([
    {
      name: "classifies server auth_error failure",
      input: {
        agentName: "Codex",
        errorClass: "auth_error",
        errorCode: "api_error_401",
        rawError: '{"error":{"message":"401 Unauthorized"}}',
      },
      expectedCategory: "auth",
      expectedMessage: "Codex 需要重新登录",
      expectedActionLabel: "去登录",
      expectedVariant: "error",
    },
    {
      name: "classifies unauthenticated provider status",
      input: {
        agentName: "Codex",
        providerStatus: makeProvider({ auth: { status: "unauthenticated" } }),
        rawError: "Codex login expired.",
      },
      expectedCategory: "auth",
      expectedMessage: "Codex 需要重新登录",
      expectedActionLabel: "去登录",
      expectedVariant: "error",
    },
    {
      name: "classifies raw 401 when failure class is missing",
      input: {
        agentName: "Claude",
        rawError: "API Error: 401 Credentials expired.",
      },
      expectedCategory: "auth",
      expectedMessage: "Claude 需要重新登录",
      expectedActionLabel: "去登录",
      expectedVariant: "error",
    },
    {
      name: "classifies not_installed failure",
      input: {
        agentName: "Codex",
        errorClass: "not_installed",
        rawError: "spawn codex ENOENT",
      },
      expectedCategory: "not_installed",
      expectedMessage: "这台电脑上没装 Codex",
      expectedActionLabel: "查看安装方法",
      expectedVariant: "error",
    },
    {
      name: "classifies missing executable from provider status",
      input: {
        agentName: "Claude",
        providerStatus: makeProvider({
          driver: ProviderDriverKind.make("claudeAgent"),
          installed: false,
          auth: { status: "unknown" },
        }),
        rawError: "CLI not found in PATH.",
      },
      expectedCategory: "not_installed",
      expectedMessage: "这台电脑上没装 Claude",
      expectedActionLabel: "查看安装方法",
      expectedVariant: "error",
    },
    {
      name: "classifies usage limit with known reset time and alternative agent",
      input: {
        agentName: "Codex",
        errorClass: "usage_limit",
        errorCode: CHATGPT_USAGE_LIMIT_CODE,
        usageLimitResetAt: new Date(2026, 10, 24, 17, 30).toISOString(),
        timestampFormat: "24-hour",
        alternativeAgent: alternativeClaude,
        rawError: "usage limit exceeded",
      },
      expectedCategory: "usage_limit",
      expectedMessage: "Codex 用量到上限了，17:30 恢复",
      expectedActionLabel: "换用 Claude",
      expectedVariant: "warning",
    },
    {
      name: "hides switch button when no alternative agent exists",
      input: {
        agentName: "Codex",
        errorClass: "usage_limit",
        errorCode: CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
        usageLimitResetAt: new Date(2026, 10, 24, 17, 30).toISOString(),
        timestampFormat: "24-hour",
        alternativeAgent: null,
        rawError: "workspace usage limit",
      },
      expectedCategory: "usage_limit",
      expectedMessage: "Codex 用量到上限了，17:30 恢复",
      expectedActionLabel: null,
      expectedVariant: "warning",
    },
    {
      name: "classifies network failure with retry count",
      input: {
        agentName: "Codex",
        errorClass: "transport_error",
        retryCount: 5,
        rawError: "stream disconnected before completion",
      },
      expectedCategory: "network_unavailable",
      expectedMessage: "连不上 Codex，已重试 5 次",
      expectedActionLabel: "再试一次",
      expectedVariant: "error",
    },
    {
      name: "classifies overloaded 529 service error without count",
      input: {
        agentName: "Claude",
        errorCode: "api_error_529",
        rawError: "Claude API is overloaded (529).",
      },
      expectedCategory: "network_unavailable",
      expectedMessage: "连不上 Claude",
      expectedActionLabel: "再试一次",
      expectedVariant: "error",
    },
    {
      name: "keeps 403 permission error in other rather than guessing auth",
      input: {
        agentName: "Claude",
        errorClass: "permission_error" as OrchestrationV2ProviderFailureClass,
        errorCode: "api_error_403",
        rawError: "API Error: 403 Your organization does not have access.",
      },
      expectedCategory: "other",
      expectedMessage: "Claude 出错了",
      expectedActionLabel: "再试一次",
      expectedVariant: "error",
    },
    {
      name: "keeps Antigravity unknown restart auth out of auth category",
      input: {
        agentName: "Antigravity",
        providerStatus: makeProvider({
          driver: ProviderDriverKind.make("antigravity"),
          status: "warning",
          auth: { status: "unknown" },
        }),
        rawError: "Temporary check warning.",
      },
      expectedCategory: "other",
      expectedMessage: "Antigravity 出错了",
      expectedActionLabel: "再试一次",
      expectedVariant: "error",
    },
    {
      name: "keeps a missing project file (ENOENT) out of not_installed",
      input: {
        agentName: "Codex",
        rawError: "ENOENT: no such file or directory, open '/work/app.ts'",
      },
      expectedCategory: "other",
      expectedMessage: "Codex 出错了",
      expectedActionLabel: "再试一次",
      expectedVariant: "error",
    },
    {
      name: "does not read a bare 401 inside tool output as a sign-in problem",
      input: { agentName: "Codex", rawError: "Tool output: parsed 401 rows from users.csv" },
      expectedCategory: "other",
      expectedMessage: "Codex 出错了",
      expectedActionLabel: "再试一次",
      expectedVariant: "error",
    },
    {
      name: "does not read a bare 429 inside tool output as a usage limit",
      input: { agentName: "Claude", rawError: "Tool output: line 429 of build.log is empty" },
      expectedCategory: "other",
      expectedMessage: "Claude 出错了",
      expectedActionLabel: "再试一次",
      expectedVariant: "error",
    },
    {
      name: "does not read a bare 503 inside tool output as an outage",
      input: { agentName: "Claude", rawError: "Tool output: wrote 503 bytes to out.bin" },
      expectedCategory: "other",
      expectedMessage: "Claude 出错了",
      expectedActionLabel: "再试一次",
      expectedVariant: "error",
    },
    {
      name: "names the generic agent without a stray space",
      input: { agentName: "智能体", errorClass: "transport_error", retryCount: 3 },
      expectedCategory: "network_unavailable",
      expectedMessage: "连不上智能体，已重试 3 次",
      expectedActionLabel: "再试一次",
      expectedVariant: "error",
    },
    {
      name: "falls back to other when error text is ambiguous",
      input: {
        agentName: "Claude",
        errorClass: "provider_error",
        rawError: "Something went wrong while running tool step 3.",
      },
      expectedCategory: "other",
      expectedMessage: "Claude 出错了",
      expectedActionLabel: "再试一次",
      expectedVariant: "error",
    },
  ])(
    "$name",
    ({ input, expectedCategory, expectedMessage, expectedActionLabel, expectedVariant }) => {
      using _now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 10, 24, 12, 0).getTime());
      const result = classifyProviderError(input);
      expect(result.category).toBe(expectedCategory);
      expect(result.message).toBe(expectedMessage);
      expect(result.action?.label ?? null).toBe(expectedActionLabel);
      expect(result.variant).toBe(expectedVariant);
      expect(result.rawDetail).toBe(input.rawError ?? null);
    },
  );
});
