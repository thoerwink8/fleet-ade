// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { satisfiesSemverRange } from "@t3tools/shared/semver";
import { checkNodeVersion, nodeVersionError, satisfiesRange } from "./node-version-check.cjs";

const root = NodePath.resolve(import.meta.dirname, "..");

describe("node-version-check", () => {
  it("matches the pinned engines.node and rejects other versions", () => {
    expect(checkNodeVersion("26.12.1", root)).toBeUndefined();
    expect(checkNodeVersion("24.18.1", root)).toContain("v24.18.1");
    expect(checkNodeVersion("26.12.2", root)).toContain("v26.12.2");
    expect(checkNodeVersion("25.0.0", root)).toBeDefined();
    expect(checkNodeVersion("27.0.0", root)).toBeDefined();
  });

  it("reads the pin from the given root's package.json only", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "node-check-"));
    NodeFS.writeFileSync(
      NodePath.join(dir, "package.json"),
      JSON.stringify({ engines: { node: ">=26" } }),
    );
    expect(checkNodeVersion("26.0.0", dir)).toBeUndefined();
    expect(checkNodeVersion("24.18.1", dir)).toContain(">=26");
    expect(checkNodeVersion("26.12.1", NodePath.join(dir, "missing"))).toBeUndefined();
  });

  it("keeps satisfiesRange in lockstep with the shared semver range check", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["26.12.1", "26.12.1"],
      ["26.12.1", "v26.12.1"],
      ["26.12.1", "26"],
      ["26.12.1", "26.12"],
      ["26.12.2", "26.12.1"],
      ["24.0.0", "^24"],
      ["25.0.0", "^24"],
      ["23.9.9", "^24"],
      ["0.2.5", "^0.2.3"],
      ["0.3.0", "^0.2.3"],
      ["26.0.0", ">=26"],
      ["25.9.9", ">=26"],
      ["26.0.0", ">=26 <27"],
      ["27.0.0", ">=26 <27"],
      ["24.0.0", "26.12.1 || 27.0.0"],
      ["27.0.0", "26.12.1 || 27.0.0"],
      ["26.12.1", "<27.0.0"],
      ["26.0.0", "~26"],
      ["26.12.1", "^26.12.1"],
      ["26.12.0", "^26.12.1"],
      ["27.0.0", "^26.12.1"],
      ["26.12.1", "=26.12.1"],
      ["26.0.0-rc.1", ">=26"],
      ["26.12.1-rc.1", "26.12.1"],
    ];
    for (const [version, range] of cases) {
      expect(satisfiesRange(version, range), `${version} vs ${range}`).toBe(
        satisfiesSemverRange(version, range),
      );
    }
  });

  it("names the running version, the required range, and where it is pinned", () => {
    const message = nodeVersionError("24.18.1", "26.12.1");
    expect(message).toContain("26.12.1");
    expect(message).toContain("engines.node");
    expect(message).toContain("v24.18.1");
  });
});
