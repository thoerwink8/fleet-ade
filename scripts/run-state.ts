export interface RunRecord {
  readonly kind: "dev" | "start";
  readonly pid: number;
  readonly ports: readonly number[];
  readonly address: string | undefined;
  readonly marker: string;
  readonly startedAt: string;
}

export const DEV_MARKER = "scripts/dev-runner.ts";
export const START_MARKER = "apps/server/dist/bin.mjs";
export const DEFAULT_START_PORT = 3773;
export const DEFAULT_START_HOST = "127.0.0.1";

export function parseDevRunnerPorts(
  line: string,
): { readonly serverPort: number; readonly webPort: number } | undefined {
  const match = /serverPort=(\d+)\s+webPort=(\d+)/.exec(line);
  if (!match?.[1] || !match[2]) return undefined;
  return { serverPort: Number(match[1]), webPort: Number(match[2]) };
}

export function commandLineMatches(commandLine: string, marker: string): boolean {
  return commandLine.replaceAll("\\", "/").includes(marker);
}

/** Live recorded processes whose command line still contains the marker. A recycled pid does not match. */
export function stopTargets(
  records: readonly RunRecord[],
  commandLineOf: (pid: number) => string | undefined,
): { readonly kill: readonly RunRecord[]; readonly idle: boolean } {
  const kill = records.filter((record) => {
    const commandLine = commandLineOf(record.pid);
    return commandLine !== undefined && commandLineMatches(commandLine, record.marker);
  });
  return { kill, idle: kill.length === 0 };
}

export type KillPlan =
  | { readonly kind: "taskkill"; readonly command: "taskkill"; readonly args: readonly string[] }
  | { readonly kind: "process-group"; readonly pid: number };

export function planKill(pid: number, platform: NodeJS.Platform): KillPlan {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`pid 不对: ${pid}`);
  }
  if (platform === "win32") {
    // /F: node has no window, so /T alone does not end the tree.
    return { kind: "taskkill", command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] };
  }
  return { kind: "process-group", pid };
}

export function isLinkedWorktreeGitFile(contents: string): boolean {
  const gitdir = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  if (gitdir === undefined || gitdir.length === 0) return false;
  const segments = gitdir
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  return segments.length >= 3 && segments.at(-2) === "worktrees";
}

/**
 * Flag, then this worktree's `.t3`, then `T3CODE_HOME`, then `<repo>/.t3`.
 * Never the home directory: that database is the live install.
 */
export function resolveStartBaseDir(input: {
  readonly repoRoot: string;
  readonly linkedWorktree: boolean;
  readonly envHome: string | undefined;
  readonly flag: string | undefined;
}): string {
  const flag = input.flag?.trim();
  if (flag) return flag;
  const root = input.repoRoot.replace(/[/\\]$/, "");
  if (input.linkedWorktree) return `${root}/.t3`;
  const envHome = input.envHome?.trim();
  if (envHome) return envHome;
  return `${root}/.t3`;
}

export function takeFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`缺少 ${name} 的值`);
  }
  return value;
}

export function parseStartPort(args: readonly string[], envPort: string | undefined): number {
  const raw = takeFlag(args, "--port") ?? envPort;
  if (raw === undefined || raw.trim() === "") return DEFAULT_START_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口不对: ${raw}`);
  }
  return port;
}

export function devAddress(webPort: number): string {
  return `http://localhost:${webPort}`;
}

export function startAddress(port: number): string {
  return `http://${DEFAULT_START_HOST}:${port}`;
}

export function alreadyRunningText(record: RunRecord): string {
  const where =
    record.address ?? (record.ports.length > 0 ? record.ports.join(",") : "端口还没记下来");
  return `已在跑\npid=${record.pid} ${where}`;
}
