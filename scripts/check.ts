// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - the check runner prints step timing with Node, same as test-cached.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(import.meta.dirname, "..");
const vp = NodePath.join(root, "node_modules", "vite-plus", "bin", "vp");

export interface Step {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

function parseStepFilter(
  argv: readonly string[],
  envCheckSteps: string | undefined,
): readonly string[] {
  const cliArgs = argv[0] === "--" ? argv.slice(1) : argv;
  const rawEntries = cliArgs.length > 0 ? cliArgs : envCheckSteps ? [envCheckSteps] : [];
  return rawEntries
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePositiveShard(name: string, prefix: string): string | undefined {
  const match = new RegExp(`^${prefix}\\s+(\\d+)\\/(\\d+)$`).exec(name);
  if (!match) return undefined;
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || index > count) {
    return undefined;
  }
  return `${index}/${count}`;
}

export function selectCheckSteps<TStep extends { readonly name: string }>(
  allSteps: readonly TStep[],
  argv: readonly string[],
  envCheckSteps?: string,
  createWebShardSteps?: (shard: string) => readonly TStep[],
  createServerShardStep?: (shard: string) => TStep,
): readonly TStep[] {
  const requested = parseStepFilter(argv, envCheckSteps);
  if (requested.length === 0) {
    return allSteps;
  }
  const availableNames = new Set(allSteps.map((step) => step.name));
  const webShards: TStep[] = [];
  const seenWebShards = new Set<string>();
  const serverShards: TStep[] = [];
  const seenServerShards = new Set<string>();
  const unknown: string[] = [];

  for (const name of requested) {
    if (availableNames.has(name)) continue;
    const webShard = createWebShardSteps ? parsePositiveShard(name, "web") : undefined;
    if (webShard) {
      if (!seenWebShards.has(webShard)) {
        seenWebShards.add(webShard);
        webShards.push(...createWebShardSteps!(webShard));
      }
      continue;
    }
    const serverShard = createServerShardStep ? parsePositiveShard(name, "server") : undefined;
    if (serverShard) {
      if (!seenServerShards.has(serverShard)) {
        seenServerShards.add(serverShard);
        serverShards.push(createServerShardStep!(serverShard));
      }
      continue;
    }
    if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `未知的 check 步骤: ${unknown.join(", ")}（可选: ${allSteps.map((step) => step.name).join(", ")}, web <i/n>, server <i/n>）`,
    );
  }

  const selectedNames = new Set(requested);
  const selected: TStep[] = [];
  const lastServerIndex = allSteps.findLastIndex((step) => step.name.startsWith("server "));
  for (const [index, step] of allSteps.entries()) {
    if (step.name === "web") {
      if (selectedNames.has("web")) {
        selected.push(step);
      }
      selected.push(...webShards);
      continue;
    }
    if (selectedNames.has(step.name)) {
      selected.push(step);
    }
    if (index === lastServerIndex) {
      selected.push(...serverShards);
    }
  }
  if (lastServerIndex === -1) {
    selected.push(...serverShards);
  }
  return selected;
}

function nodeStep(name: string, args: readonly string[], cwd?: string): Step {
  return cwd
    ? { name, command: process.execPath, args, cwd }
    : { name, command: process.execPath, args };
}

function vpStep(name: string, args: readonly string[], cwd?: string): Step {
  return nodeStep(name, [vp, ...args], cwd);
}

// Run the Node `unit` fork pool and the Playwright `browser` Chromium pool
// sequentially within each web shard so 180+ worker forks do not starve
// Vite's initial browser session connect or headless Chromium rendering.
function webShardSteps(shard: string): readonly Step[] {
  const webDir = NodePath.join(root, "apps", "web");
  return [
    vpStep(
      `web ${shard} (unit)`,
      ["test", "run", "--passWithNoTests", "--project", "unit", `--shard=${shard}`],
      webDir,
    ),
    vpStep(
      `web ${shard} (browser)`,
      ["test", "run", "--passWithNoTests", "--project", "browser", `--shard=${shard}`],
      webDir,
    ),
  ];
}

function serverShardStep(shard: string): Step {
  return nodeStep(`server ${shard}`, [
    "scripts/test-cached.ts",
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
}

const steps: Step[] = [
  vpStep("fmt", ["fmt", "--check", "--no-error-on-unmatched-pattern"]),
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
  ...Array.from({ length: 8 }, (_, index) => serverShardStep(`${index + 1}/8`)),
];

function runCheck() {
  process.env.CI ??= "true";
  process.env.T3CODE_TELEMETRY_ENABLED ??= "false";
  process.env.OTEL_SDK_DISABLED ??= "true";

  let selectedSteps: readonly Step[];
  try {
    selectedSteps = selectCheckSteps(
      steps,
      process.argv.slice(2),
      process.env.CHECK_STEPS,
      webShardSteps,
      serverShardStep,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  let failed = false;
  const failedSteps: string[] = [];
  const startedAll = performance.now();
  for (const step of selectedSteps) {
    console.log(`\n== ${step.name} ==`);
    const started = performance.now();
    const result = NodeChildProcess.spawnSync(step.command, [...step.args], {
      cwd: step.cwd ?? root,
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
  console.log(
    `\npnpm check ${failed ? `失败：${failedSteps.join("、")}` : "通过"}，用时 ${total}s`,
  );
  if (failed) process.exit(1);
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCheck();
}
