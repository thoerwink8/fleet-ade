import type { ServerProvider } from "@t3tools/contracts";

export interface ProviderSetupGuidance {
  readonly message: string;
  readonly action: { readonly kind: "authenticate"; readonly label: string } | null;
}

/**
 * Names the machine the sign-in runs on. It only reads the structured status the server sends
 * (`auth.status` and `setup.canAuthenticate`), never the status message text.
 */
export function providerSetupGuidance(input: {
  readonly provider: Pick<ServerProvider, "driver" | "auth" | "message" | "setup">;
  readonly environmentLabel: string;
}): ProviderSetupGuidance {
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
  return { message: input.provider.message ?? "", action: null };
}
