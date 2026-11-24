// @effect-diagnostics nodeBuiltinImport:off - compiles real source files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { transform } from "oxc-transform-react";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

// Titles stay `/`-separated so check:changed's `-t` filter, built from git paths, matches on Windows.
const compilerCasePath = (file: string) => file.replaceAll("\\", "/");
export const reactCompilerCaseName = (file: string) => `compiles ${compilerCasePath(file)}`;

const webSourceFiles = NodeFS.readdirSync(NodePath.join(repoRoot, "apps/web/src"), {
  recursive: true,
})
  .map(String)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file))
  .filter((file) => !file.endsWith(".gen.ts"))
  .map((file) => `apps/web/src/${file}`);

// ChatView is ~9k lines. Compiling it takes ~9s on a fast machine and can pass the
// 15s project limit on loaded CI runners, so slow files get a 60s limit below.
const slowFiles = new Set(["apps/web/src/components/ChatView.tsx"]);

const compile = async (file: string) => {
  const absolute = NodePath.join(repoRoot, file);
  const result = await transform(absolute, NodeFS.readFileSync(absolute, "utf8"), {
    jsx: { runtime: "automatic", development: false, refresh: false },
    reactCompiler: { reportDiagnostics: true },
  });
  const bailouts = result.errors.map((error) => error.codeframe ?? error.message);
  expect(bailouts).toEqual([]);
};

// Lint reports most compiler bailouts, but not every one (try/finally, throw
// inside try). A skipped file still builds, just unmemoized, so check the output.
describe("React Compiler coverage", () => {
  it("names compiler cases with forward slashes", () => {
    for (const file of [...webSourceFiles, ...slowFiles]) {
      expect(reactCompilerCaseName(file), file).not.toContain("\\");
    }
    const winPath = NodePath.win32.join("apps", "web", "src", "components", "ui", "button.tsx");
    expect(winPath).toContain("\\");
    expect(reactCompilerCaseName(winPath)).toBe("compiles apps/web/src/components/ui/button.tsx");
    const readDirShape = `apps/web/src/${NodePath.win32.join("components", "ui", "button.tsx")}`;
    expect(readDirShape).toContain("\\");
    expect(reactCompilerCaseName(readDirShape)).toBe(
      "compiles apps/web/src/components/ui/button.tsx",
    );
  });

  it.each(
    webSourceFiles
      .filter((file) => !slowFiles.has(compilerCasePath(file)))
      .map((file) => [compilerCasePath(file), file] as const),
  )("compiles %s", (_displayPath, file) => compile(file));
  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- CPU-bound compile of a huge file, not a hidden wait.
  it.each([...slowFiles].map((file) => [compilerCasePath(file), file] as const))(
    "compiles %s",
    (_displayPath, file) => compile(file),
    60_000,
  );
});
