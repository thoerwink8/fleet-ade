import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chatGptWelcomeProfiles,
  nextChatGptWelcomeProfile,
  type ChatGptWelcomeProfile,
  type ChatGptWelcomeSource,
} from "./ChatGptWelcome.logic";

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");
const sharing = provider({
  displayName: "Codex",
  auth: { status: "authenticated", profileId: "acct-1", subscriptionSharing: true },
});

function source(overrides: Partial<ChatGptWelcomeSource>): ChatGptWelcomeSource {
  return {
    environmentId: ENV_A,
    environmentLabel: "办公室电脑",
    connected: true,
    providers: [sharing],
    ...overrides,
  };
}

const profileA: ChatGptWelcomeProfile = {
  key: JSON.stringify([ENV_A, sharing.instanceId, "acct-1"]),
  environmentLabel: "办公室电脑",
  providerName: "Codex",
};
const profileB: ChatGptWelcomeProfile = {
  key: JSON.stringify([ENV_B, sharing.instanceId, "acct-2"]),
  environmentLabel: "家里电脑",
  providerName: "Codex",
};

describe("chatGptWelcomeProfiles", () => {
  it.each<[string, ChatGptWelcomeSource, ReadonlyArray<ChatGptWelcomeProfile>]>([
    ["disconnected machine", source({ connected: false }), []],
    [
      "signed in without sharing",
      source({ providers: [provider({ auth: { status: "authenticated" } })] }),
      [],
    ],
    ["sharing account on a connected machine", source({}), [profileA]],
  ])("%s", (_label, input, expected) => {
    expect(chatGptWelcomeProfiles([input])).toEqual(expected);
  });

  it("gives each sharing account on one machine its own profile", () => {
    const profiles = chatGptWelcomeProfiles([
      source({
        providers: [
          sharing,
          provider({
            instanceId: ProviderInstanceId.make("codex-2"),
            auth: { status: "authenticated", email: "b@example.com", subscriptionSharing: true },
          }),
        ],
      }),
    ]);
    expect(profiles.map((profile) => profile.key)).toEqual([
      JSON.stringify([ENV_A, sharing.instanceId, "acct-1"]),
      JSON.stringify([ENV_A, ProviderInstanceId.make("codex-2"), "b@example.com"]),
    ]);
  });

  it("keys an account without a profile id by email, then by a default", () => {
    const [byEmail, byDefault] = chatGptWelcomeProfiles([
      source({
        providers: [
          provider({
            auth: { status: "authenticated", email: "a@example.com", subscriptionSharing: true },
          }),
          provider({
            instanceId: ProviderInstanceId.make("codex-3"),
            auth: { status: "authenticated", subscriptionSharing: true },
          }),
        ],
      }),
    ]);
    expect(byEmail?.key).toBe(JSON.stringify([ENV_A, sharing.instanceId, "a@example.com"]));
    expect(byDefault?.key).toBe(
      JSON.stringify([ENV_A, ProviderInstanceId.make("codex-3"), "default"]),
    );
  });
});

describe("nextChatGptWelcomeProfile", () => {
  it.each<[string, ReadonlyArray<ChatGptWelcomeProfile>, ReadonlyArray<string>, string | null]>([
    ["nothing acknowledged", [profileA, profileB], [], profileA.key],
    ["first acknowledged", [profileA, profileB], [profileA.key], profileB.key],
    ["every profile acknowledged", [profileA, profileB], [profileA.key, profileB.key], null],
    ["no profiles", [], [], null],
  ])("%s", (_label, profiles, acknowledged, expectedKey) => {
    expect(nextChatGptWelcomeProfile(profiles, acknowledged)?.key ?? null).toBe(expectedKey);
  });
});
