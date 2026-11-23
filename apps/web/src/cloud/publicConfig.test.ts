import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it("ignores retired Clerk and hosted app environment values", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("clerk.example.com$")}`);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
    expect(resolveCloudPublicConfig().relayUrl).toBeNull();
  });
});
