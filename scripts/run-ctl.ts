// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - process supervisor prints to the terminal and stamps pid files before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  alreadyRunningText,
  DEFAULT_START_HOST,
  DEV_MARKER,
  devAddress,
  isLinkedWorktreeGitFile,
  parseDevRunnerPorts,
  parseStartPort,
  planKill,
  resolveStartBaseDir,
  type RunRecord,
  START_MARKER,
  startAddress,
  stopTargets,
  takeFlag,
} from "./run-state.ts";

import { assertNodeVersion } from "./node-version-check.cjs";

assertNodeVersion();

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

function recordPath(kind: RunRecord["kind"]): string {
  return NodePath.join(repoRoot, "_tmp", "run", `${kind}.json`);
}

function writeRecord(record: RunRecord): void {
  const file = recordPath(record.kind);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  NodeFS.renameSync(temp, file);
}

function readRecord(kind: RunRecord["kind"]): RunRecord | undefined {
  let parsed: Partial<RunRecord>;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(recordPath(kind), "utf8")) as Partial<RunRecord>;
  } catch {
    return undefined;
  }
  if (parsed.kind !== kind || typeof parsed.pid !== "number" || typeof parsed.marker !== "string") {
    return undefined;
  }
  return {
    kind,
    pid: parsed.pid,
    ports: Array.isArray(parsed.ports)
      ? parsed.ports.filter((port) => typeof port === "number")
      : [],
    address: typeof parsed.address === "string" ? parsed.address : undefined,
    marker: parsed.marker,
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
  };
}

function removeRecord(kind: RunRecord["kind"]): void {
  NodeFS.rmSync(recordPath(kind), { force: true });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function commandLineOf(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (HostProcess.Platform.defaultValue() === "win32") {
    const result = NodeChildProcess.spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const text = result.stdout.trim();
    return text.length > 0 ? text : undefined;
  }
  try {
    return NodeFS.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ");
  } catch {
    return undefined;
  }
}

function killPid(pid: number): void {
  const plan = planKill(pid, HostProcess.Platform.defaultValue());
  if (plan.kind === "taskkill") {
    const result = NodeChildProcess.spawnSync(plan.command, [...plan.args], { stdio: "inherit" });
    if ((result.status ?? 1) !== 0 && isPidAlive(pid)) {
      throw new Error(`taskkill 没停掉 pid ${pid}`);
    }
    return;
  }
  try {
    process.kill(-plan.pid, "SIGTERM");
  } catch (error) {
    if (!isPidAlive(pid)) return;
    throw error;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isPidAlive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(-plan.pid, "SIGKILL");
    } catch {
      // The group exited between the check and the signal.
    }
  }
}

function runningRecord(kind: RunRecord["kind"]): RunRecord | undefined {
  const record = readRecord(kind);
  if (!record) return undefined;
  return stopTargets([record], commandLineOf).kill[0];
}

function pipeLines(
  input: NodeJS.ReadableStream | null,
  output: NodeJS.WriteStream,
  onLine: (line: string) => void,
): void {
  if (!input) return;
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    output.write(chunk);
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  });
}

function dev(args: readonly string[]): void {
  const existing = runningRecord("dev");
  if (existing) {
    console.log(alreadyRunningText(existing));
    return;
  }
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(repoRoot, "scripts", "dev-runner.ts"), "dev", ...args],
    {
      cwd: repoRoot,
      env: process.env,
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (child.pid === undefined) throw new Error("没有拿到 dev 的 pid");
  const pid = child.pid;
  let record: RunRecord = {
    kind: "dev",
    pid,
    ports: [],
    address: undefined,
    marker: DEV_MARKER,
    startedAt: new Date().toISOString(),
  };
  writeRecord(record);
  const onLine = (line: string) => {
    const ports = parseDevRunnerPorts(line);
    if (!ports) return;
    record = {
      ...record,
      ports: [ports.serverPort, ports.webPort],
      address: devAddress(ports.webPort),
    };
    writeRecord(record);
  };
  pipeLines(child.stdout, process.stdout, onLine);
  pipeLines(child.stderr, process.stderr, onLine);
  const stopChild = () => {
    try {
      killPid(pid);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
  };
  process.on("SIGINT", stopChild);
  process.on("SIGTERM", stopChild);
  child.on("exit", (code) => {
    if (readRecord("dev")?.pid === pid) removeRecord("dev");
    process.exit(code ?? 0);
  });
}

function runVp(args: readonly string[]): number {
  const vp = NodePath.join(repoRoot, "node_modules", "vite-plus", "bin", "vp");
  const result = NodeChildProcess.spawnSync(process.execPath, [vp, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => resolve(true));
    server.listen(port, DEFAULT_START_HOST, () => {
      server.close(() => resolve(false));
    });
  });
}

function readTextIfExists(file: string): string {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function waitForPairingUrl(pid: number, logPath: string): Promise<string> {
  const deadline = Date.now() + 180_000;
  let text = "";
  while (Date.now() < deadline) {
    text = readTextIfExists(logPath);
    const match = /pairingUrl:\s*(\S+)/.exec(text);
    if (match?.[1]) return match[1];
    if (!isPidAlive(pid)) {
      throw new Error(`服务进程退出了。\n${text.slice(-4000)}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  throw new Error(`等了 180 秒还没有 pairingUrl。\n${text.slice(-4000)}`);
}

function startBaseDir(flag: string | undefined): string {
  let gitFile: string | undefined;
  try {
    const gitPath = NodePath.join(repoRoot, ".git");
    if (NodeFS.statSync(gitPath).isFile()) gitFile = NodeFS.readFileSync(gitPath, "utf8");
  } catch {
    gitFile = undefined;
  }
  return NodePath.resolve(
    resolveStartBaseDir({
      repoRoot,
      linkedWorktree: gitFile !== undefined && isLinkedWorktreeGitFile(gitFile),
      envHome: process.env.T3CODE_HOME,
      flag,
    }),
  );
}

async function start(args: readonly string[]): Promise<void> {
  const existing = runningRecord("start");
  if (existing) {
    console.log(alreadyRunningText(existing));
    return;
  }
  const port = parseStartPort(args, process.env.T3CODE_PORT);
  if (await portBusy(port)) {
    throw new Error(
      `${DEFAULT_START_HOST}:${port} 已被占用。换一个端口：pnpm start -- --port <端口>`,
    );
  }
  console.log("正在构建网页版…");
  const buildStatus = runVp(["run", "--filter", "t3", "build"]);
  if (buildStatus !== 0) process.exit(buildStatus);

  const bin = NodePath.join(repoRoot, "apps", "server", "dist", "bin.mjs");
  if (!NodeFS.existsSync(bin)) throw new Error(`构建没有产出 ${bin}`);
  const baseDir = startBaseDir(takeFlag(args, "--base-dir"));
  const address = startAddress(port);
  const logPath = NodePath.join(repoRoot, "_tmp", "run", "start.log");
  NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
  const logFd = NodeFS.openSync(logPath, "a");
  const env = { ...process.env };
  delete env.T3CODE_HOME;
  delete env.T3CODE_PORT;
  delete env.T3CODE_HOST;
  env.T3CODE_TELEMETRY_ENABLED = "false";
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      bin,
      "--host",
      DEFAULT_START_HOST,
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--no-browser",
    ],
    {
      cwd: repoRoot,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    },
  );
  child.unref();
  if (child.pid === undefined) throw new Error("没有拿到 start 的 pid");
  const pid = child.pid;
  writeRecord({
    kind: "start",
    pid,
    ports: [port],
    address,
    marker: START_MARKER,
    startedAt: new Date().toISOString(),
  });
  const stopChild = () => {
    try {
      killPid(pid);
    } catch {
      // The original failure is reported by the caller.
    }
    removeRecord("start");
    process.exit(1);
  };
  process.on("SIGINT", stopChild);
  process.on("SIGTERM", stopChild);
  try {
    const pairingUrl = await waitForPairingUrl(pid, logPath);
    process.off("SIGINT", stopChild);
    process.off("SIGTERM", stopChild);
    console.log(address);
    console.log(`pairingUrl: ${pairingUrl}`);
  } catch (error) {
    try {
      killPid(pid);
    } catch {
      // The process already left; the original error is the one to report.
    }
    removeRecord("start");
    throw error;
  }
}

function stop(): void {
  const records = [readRecord("dev"), readRecord("start")].filter(
    (record): record is RunRecord => record !== undefined,
  );
  const { kill, idle } = stopTargets(records, commandLineOf);
  if (idle) {
    for (const record of records) removeRecord(record.kind);
    console.log("没在跑");
    return;
  }
  for (const record of kill) {
    killPid(record.pid);
    removeRecord(record.kind);
    console.log(`已停 ${record.kind} pid=${record.pid}`);
  }
  for (const record of records) {
    if (!kill.some((item) => item.pid === record.pid && item.kind === record.kind)) {
      removeRecord(record.kind);
    }
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "dev") {
  dev(args);
} else if (command === "start") {
  try {
    await start(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
} else if (command === "stop") {
  stop();
} else {
  console.error("用法: pnpm dev | pnpm start | pnpm stop");
  process.exit(1);
}
