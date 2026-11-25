// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

function scanFixture(files: Readonly<Record<string, string>>): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ui-no-english-"));
  try {
    for (const [rel, source] of Object.entries(files)) {
      const file = NodePath.join(root, rel);
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, source);
    }
    try {
      NodeChildProcess.execFileSync(
        process.execPath,
        [NodePath.join(__dirname, "ui-no-english.ts"), root],
        {
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      return "";
    } catch (error) {
      return error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("ui-no-english", () => {
  it("flags bare English labels in copy modules, ?? fallbacks, and latin duration units", () => {
    const out = scanFixture({
      "packages/shared/src/model.ts": `export function getProviderOptionCurrentLabel(): string { return "Default"; }\n`,
      "packages/shared/src/paletteSearch.ts": `const hint = { label: "Branch" };\nconst pr = { label: "PR" };\n`,
      "packages/client-runtime/src/operations/threadTitle.ts": `export const title = "Attached image";\n`,
      "apps/web/src/components/SettingsScopeNotice.tsx": `const member = { environmentLabel: null as string | null };\nconst choice = { primary: member.environmentLabel ?? "Environment" };\n`,
      "apps/web/src/components/GitActionsControl.logic.ts": `const minutes = 1;\nconst seconds = 2;\nconst elapsed = \`\${minutes}m \${seconds}s\`;\n`,
    });
    expect(out).toContain("Default");
    expect(out).toContain("Branch");
    expect(out).not.toContain("  PR");
    expect(out).toContain("Attached image");
    expect(out).toContain("Environment");
    expect(out).toContain("  m\n");
    expect(out).toContain("  s\n");
  });

  it("keeps internal status returns and Chinese copy quiet", () => {
    const out = scanFixture({
      "packages/client-runtime/src/work-log/presentation.ts": `export function liveActivityToolStatus(status: string | undefined) {\n  if (status === "failed") return status;\n  return "completed";\n}\n`,
      "packages/shared/src/paletteSearch.ts": `const hint = { label: "分支" };\n`,
    });
    expect(out).toBe("");
  });
});
