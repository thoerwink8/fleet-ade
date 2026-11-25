import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";

export interface ChatGptWelcomeProfile {
  readonly key: string;
  readonly environmentLabel: string;
  readonly providerName: string;
}

export interface ChatGptWelcomeSource {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
}

/**
 * One profile per signed-in account that shares usage with ChatGPT, on a
 * connected machine. The key names the account, so signing in again never
 * repeats the notice and a second account still gets its own.
 */
export function chatGptWelcomeProfiles(
  sources: ReadonlyArray<ChatGptWelcomeSource>,
): ReadonlyArray<ChatGptWelcomeProfile> {
  return sources.flatMap((source) =>
    source.connected
      ? source.providers.filter(usesChatGptSharing).map((provider) => ({
          key: JSON.stringify([
            source.environmentId,
            provider.instanceId,
            provider.auth.profileId ?? provider.auth.email ?? "default",
          ]),
          environmentLabel: source.environmentLabel,
          providerName: provider.displayName ?? "Codex",
        }))
      : [],
  );
}

/** The first profile the user has not been told about yet, or null when none is due. */
export function nextChatGptWelcomeProfile(
  profiles: ReadonlyArray<ChatGptWelcomeProfile>,
  acknowledged: ReadonlyArray<string>,
): ChatGptWelcomeProfile | null {
  return profiles.find((profile) => !acknowledged.includes(profile.key)) ?? null;
}
