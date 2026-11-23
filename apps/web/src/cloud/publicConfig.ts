export interface CloudPublicConfig {
  readonly relayUrl: string | null;
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return { relayUrl: null };
}

/** Clerk and the hosted relay are gone, so cloud sign-in never configures. */
export function hasCloudPublicConfig(): boolean {
  return false;
}
