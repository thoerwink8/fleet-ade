// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - the check runner prints step timing with Node, same as test-cached.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

const root = NodePath.resolve(import.meta.dirname, "..");
const vp = NodePath.join(root, "node_modules", "vite-plus", "bin", "vp");

process.env.CI ??= "true";
process.env.T3CODE_TELEMETRY_ENABLED ??= "false";
process.env.OTEL_SDK_DISABLED ??= "true";

interface Step {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

function nodeStep(name: string, args: readonly string[]): Step {
  return { name, command: process.execPath, args };
}

function vpStep(name: string, args: readonly string[]): Step {
  return nodeStep(name, [vp, ...args]);
}

const releaseChecks = [
  ".github/scripts/check-nightly-release.test.cjs",
  ".github/scripts/mobile-preview-comment.test.cjs",
  ".github/scripts/test-delta.test.cjs",
];

const steps: Step[] = [
  vpStep("lint", ["lint", "--report-unused-disable-directives"]),
  nodeStep("ui-no-english", ["scripts/ui-no-english.ts"]),
  vpStep("typecheck", ["run", "-r", "--cache", "--concurrency-limit", "4", "typecheck"]),
  vpStep("ensure-electron", ["run", "--filter", "@t3tools/desktop", "ensure:electron"]),
  nodeStep("chromium", [
    NodePath.join(root, "apps", "web", "node_modules", "playwright", "cli.js"),
    "install",
    "--only-shell",
    "chromium",
  ]),
  ...(HostProcess.Platform.defaultValue() === "linux"
    ? [
        {
          name: "preview-python",
          command: "python3",
          args: ["-B", ".github/scripts/stage-preview-bundle.test.py"],
        } satisfies Step,
      ]
    : []),
  nodeStep("release-checks", ["--test", ...releaseChecks]),
  vpStep("packages", [
    "run",
    "--parallel",
    "--concurrency-limit",
    "4",
    "--filter",
    "!t3",
    "--filter",
    "!@t3tools/monorepo",
    "--filter",
    "!@t3tools/web",
    "test",
  ]),
  vpStep("web", ["run", "--filter", "@t3tools/web", "test"]),
  ...Array.from({ length: 8 }, (_, index) => {
    const shard = `${index + 1}/8`;
    return vpStep(`server ${shard}`, [
      "run",
      "test:cached",
      "--",
      "--shard",
      shard,
      "--concurrency",
      "4",
      "--uncached",
      "apps/server/integration/transferBudgetV2.integration.test.ts",
      "--verify-hits",
      "1",
      "apps/server",
    ]);
  }),
];

let failed = false;
const failedSteps: string[] = [];
const startedAll = performance.now();
for (const step of steps) {
  console.log(`\n== ${step.name} ==`);
  const started = performance.now();
  const result = NodeChildProcess.spawnSync(step.command, [...step.args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const status = result.status ?? 1;
  if (result.error || status !== 0) {
    failed = true;
    failedSteps.push(step.name);
    console.error(`${step.name} 失败 ${seconds}s`);
    continue;
  }
  console.log(`${step.name} 通过 ${seconds}s`);
}
const total = ((performance.now() - startedAll) / 1000).toFixed(1);
console.log(`\npnpm check ${failed ? `失败：${failedSteps.join("、")}` : "通过"}，用时 ${total}s`);
if (failed) process.exit(1);
