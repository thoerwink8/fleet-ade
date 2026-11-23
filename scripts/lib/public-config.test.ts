// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence and drops retired Clerk and relay keys", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_APPLE_TEAM_ID=team_root\nT3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_APPLE_TEAM_ID=team_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nVITE_CLERK_PUBLISHABLE_KEY=pk_local\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_APPLE_TEAM_ID).toBe("team_local");
    const loaded = loadRepoEnv({
      baseEnv: {
        T3CODE_APPLE_TEAM_ID: "team_ci",
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
        T3CODE_RELAY_URL: "https://ci.example.test",
        VITE_T3CODE_RELAY_URL: "https://ci.example.test",
      },
      repoRoot,
    });
    expect(loaded.T3CODE_APPLE_TEAM_ID).toBe("team_ci");
    for (const key of [
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      "VITE_CLERK_PUBLISHABLE_KEY",
      "T3CODE_CLERK_JWT_TEMPLATE",
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      "T3CODE_RELAY_URL",
      "VITE_T3CODE_RELAY_URL",
    ]) {
      expect(loaded).not.toHaveProperty(key);
    }
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
