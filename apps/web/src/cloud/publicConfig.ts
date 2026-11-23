import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

export interface CloudPublicConfig {
  readonly relayUrl: string | null;
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
  };
}

/** Clerk and the hosted relay are gone, so cloud sign-in never configures. */
export function hasCloudPublicConfig(): boolean {
  return false;
}
