import type { ServerProvider } from "@t3tools/contracts";

const CLAUDE_INSTALL_DOCUMENTATION_URL =
  "https://code.claude.com/docs/en/setup#install-claude-code";

export interface ProviderSetupGuidance {
  readonly message: string;
  readonly action:
    | { readonly kind: "documentation"; readonly label: string; readonly url: string }
    | { readonly kind: "authenticate"; readonly label: string }
    | null;
}

export function providerSetupGuidance(input: {
  readonly provider: Pick<
    ServerProvider,
    "driver" | "installed" | "auth" | "message" | "setup" | "displayName"
  >;
  readonly environmentLabel: string;
}): ProviderSetupGuidance {
  const message = input.provider.message ?? "";
  const documentationUrl = input.provider.setup?.documentationUrl;
  const claudeMissing =
    message === "还没装 Claude Code，装好后会自动识别。" ||
    message === "在 PATH 上找不到 Claude Agent CLI（`claude`）。";
  if (
    input.provider.driver === "claudeAgent" &&
    !input.provider.installed &&
    (documentationUrl !== undefined || claudeMissing)
  ) {
    return {
      message,
      action: {
        kind: "documentation",
        label: "查看安装方法",
        url: documentationUrl ?? CLAUDE_INSTALL_DOCUMENTATION_URL,
      },
    };
  }
  if (
    input.provider.driver === "claudeAgent" &&
    input.provider.auth.status === "unauthenticated" &&
    input.provider.setup?.canAuthenticate === true
  ) {
    return {
      message: `在 ${input.environmentLabel} 上登录 Claude。`,
      action: { kind: "authenticate", label: "登录" },
    };
  }
  return { message, action: null };
}
