import type { ProviderAuthState } from "@t3tools/contracts";

export function providerAuthAccountDescription(input: {
  readonly phase: ProviderAuthState["phase"] | undefined;
  readonly message: string | null | undefined;
  readonly interactionType: string | undefined;
  readonly signedIn: boolean;
  readonly isDiscovering: boolean;
  readonly guidanceMessage: string | null;
  readonly needsExternalSetup: boolean;
  readonly usesCredentials: boolean;
  readonly environmentLabel: string;
}): string {
  const active =
    input.phase === "starting" || input.phase === "waiting" || input.phase === "verifying";
  if (active) {
    if (input.phase === "starting") {
      return input.message ?? (input.usesCredentials ? "正在连接…" : "正在启动登录…");
    }
    if (input.phase === "verifying") {
      return input.usesCredentials ? "正在检查凭据并加载模型…" : "正在检查你的账户…";
    }
    if (input.interactionType === "terminal") return "在下方终端中完成登录。";
    if (input.interactionType === "credentials") return "在下方输入凭据。";
    return "在浏览器中完成登录。";
  }
  if (input.signedIn) return "已登录";
  if (input.isDiscovering) return "正在查找登录方式…";
  // A cancelled flow stays visible until the next attempt, so the click is acknowledged.
  if (input.phase === "cancelled") return "登录已取消。需要时可以重新登录。";
  if (input.guidanceMessage !== null) return input.guidanceMessage;
  if (input.needsExternalSetup) return "智能体未提供应用内登录。请按智能体文档完成设置。";
  return input.usesCredentials
    ? `在 ${input.environmentLabel} 上连接以加载模型。`
    : `在 ${input.environmentLabel} 上登录。`;
}
