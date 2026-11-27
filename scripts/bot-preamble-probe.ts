// @effect-diagnostics nodeBuiltinImport:off
// Measures how much of a bot preamble each provider channel delivers.
// Excluded from scripts/tsconfig.json: it imports the production splitter by path and is run with node.
// Run: node scripts/bot-preamble-probe.ts [--dry-run] [--provider claude,codex,grok,antigravity,acp]
/* oxlint-disable t3code/no-global-process-runtime -- Standalone Node probe, no Effect runtime. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { buildBotPreambleSections } from "../packages/provider-core/src/server/botPreamble.ts";

const SIZES = [
  { label: "1KB", bytes: 1024 },
  { label: "4KB", bytes: 4096 },
  { label: "16KB", bytes: 16_384 },
  { label: "64KB", bytes: 65_536 },
] as const;

const PAD = "x".repeat(60);
const MAX_TURNS_DEFAULT = 10;
let TURN_TIMEOUT_MS = 300_000;
let skipCompact = false;

type SizeLabel = (typeof SIZES)[number]["label"];
type Json = Record<string, unknown>;

interface ProbeBody {
  readonly label: SizeLabel;
  readonly bytes: number;
  readonly sections: readonly string[];
  readonly markers: readonly string[];
  readonly text: string;
}

interface Cell {
  provider: string;
  model: string;
  size: SizeLabel;
  channel: string;
  sectionCount: number;
  received: string[];
  firstMissing: string | null;
  afterCompact: string[] | null;
  compactNote: string;
  error: string | null;
  turns: number;
}

const channels = {
  claude:
    "Claude --append-system-prompt-file，折进 systemPrompt.append（ClaudeAdapterV2.makeClaudeQueryOptions）",
  codex:
    "Codex app-server turn/start additionalContext，一节一个 application 项（CodexDeveloperInstructions.ts；client.ts 补上 schema 里没有的字段）",
  grok: "grok --rules，帮助写明追加到系统提示。ACP 会话没有系统提示字段",
  antigravity:
    "session/new _meta.antigravity.systemPrompt.append，仅当 initialize 声明会追加（antigravitySessionMeta）",
  acp: "没有系统提示字段。候选是工作目录 AGENTS.md（本探测用已安装的 kimi acp）",
} as const;

type ProviderName = keyof typeof channels;

function sectionsFor(rules: string): readonly string[] {
  return buildBotPreambleSections({
    toolsText: "",
    soul: "probe",
    name: "probe",
    memory: "",
    rules,
  });
}

function buildProbe(label: SizeLabel, targetBytes: number): ProbeBody {
  let rules = PAD;
  let sections = sectionsFor(rules);
  while (Buffer.byteLength(sections.join(""), "utf8") < targetBytes) {
    rules += `\n${PAD}`;
    sections = sectionsFor(rules);
  }
  let padSeen = 0;
  const replacement = new Map<number, string>();
  for (const [sectionIndex, section] of sections.entries()) {
    let replaced = false;
    for (const line of section.split("\n")) {
      if (line !== PAD) continue;
      padSeen += 1;
      if (!replaced) {
        const raw = `PROBE-${label}-${sectionIndex + 1}`;
        replacement.set(padSeen, raw + "x".repeat(PAD.length - raw.length));
        replaced = true;
      }
    }
  }
  let seen = 0;
  const markedRules = rules
    .split("\n")
    .map((line) => {
      if (line !== PAD) return line;
      seen += 1;
      return replacement.get(seen) ?? line;
    })
    .join("\n");
  const marked = sectionsFor(markedRules);
  const markers = marked.map((_, index) => `PROBE-${label}-${index + 1}`);
  for (const [index, section] of marked.entries()) {
    if (!section.includes(markers[index]!)) {
      throw new Error(`section ${index + 1} of ${label} lost its marker`);
    }
  }
  return {
    label,
    bytes: Buffer.byteLength(marked.join(""), "utf8"),
    sections: marked,
    markers,
    text: marked.join(""),
  };
}

function askText(): string {
  return "List every verbatim token that starts with PROBE- from instructions given to you before this message. One token per line, exact spelling, nothing else. Do not use tools. If there are none, reply NONE.";
}

function foundMarkers(text: string, expected: readonly string[]): string[] {
  const seen = new Set(text.match(/PROBE-\d+KB-\d+/g) ?? []);
  return expected.filter((marker) => seen.has(marker));
}

function seenMarkers(
  reply: string,
  thought: string,
  expected: readonly string[],
): { received: string[]; where: "reply" | "thought" | "none" } {
  const inReply = foundMarkers(reply, expected);
  if (reply.trim().length > 0) return { received: inReply, where: "reply" };
  const inThought = foundMarkers(thought, expected);
  if (inThought.length > 0) return { received: inThought, where: "thought" };
  return { received: [], where: "none" };
}

function firstDrop(expected: readonly string[], received: readonly string[]): string | null {
  const index = expected.findIndex((marker) => !received.includes(marker));
  if (index < 0) return null;
  if (expected.slice(index + 1).some((marker) => received.includes(marker))) return "没有整段截断";
  return expected[index] ?? null;
}

function redact(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(sk-|xai-|AIza)[A-Za-z0-9_-]{6,}/g, "[secret]")
    .replace(/Bearer\s+\S+/gi, "Bearer [secret]")
    .slice(0, 2000);
}

function killTree(pid: number): void {
  if (process.platform === "win32") {
    NodeChildProcess.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

interface Captured {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function launchSpec(command: string, args: readonly string[]): { file: string; args: string[] } {
  if (process.platform !== "win32" || command.includes("/") || command.includes("\\")) {
    return { file: command, args: [...args] };
  }
  const where = NodeChildProcess.spawnSync("where.exe", [command], {
    windowsHide: true,
    encoding: "utf8",
  });
  const lines = (where.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const executable = lines.find((line) => /\.exe$/i.test(line));
  if (executable !== undefined) return { file: executable, args: [...args] };
  const batch = lines.find((line) => /\.(cmd|bat)$/i.test(line));
  if (batch !== undefined) {
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", batch, ...args] };
  }
  return { file: command, args: [...args] };
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<Captured> {
  const { promise, resolve } = Promise.withResolvers<Captured>();
  const launch = launchSpec(command, args);
  const child = NodeChildProcess.spawn(launch.file, launch.args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ code, stdout, stderr, timedOut });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) killTree(child.pid);
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < 2_000_000) stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 200_000) stderr += chunk;
  });
  child.on("error", (error) => {
    stderr = `${stderr}\n${error.message}`;
    finish(null);
  });
  child.on("close", (code) => finish(code));
  return promise;
}

function claudeResultText(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const value = JSON.parse(trimmed) as { result?: unknown };
    return typeof value.result === "string" ? value.result : trimmed;
  } catch {
    return trimmed;
  }
}

function commandFailure(captured: Captured): string | null {
  if (captured.timedOut) return "超时，已杀掉本次进程树";
  if (captured.code !== 0) {
    return redact(`${captured.stderr}\n${captured.stdout}`.trim() || `exit ${captured.code}`);
  }
  return null;
}

class Budget {
  turns = 0;
  #max = 0;
  constructor(max: number) {
    this.#max = max;
  }
  take(): boolean {
    if (this.turns >= this.#max) return false;
    this.turns += 1;
    return true;
  }
}

function blankCell(input: {
  provider: ProviderName;
  model: string;
  body: ProbeBody;
  error: string | null;
  turns: number;
  compactNote: string;
}): Cell {
  return {
    provider: input.provider,
    model: input.model,
    size: input.body.label,
    channel: channels[input.provider],
    sectionCount: input.body.sections.length,
    received: [],
    firstMissing: input.turns === 0 ? null : (input.body.markers[0] ?? null),
    afterCompact: null,
    compactNote: input.compactNote,
    error: input.error,
    turns: input.turns,
  };
}

async function probeClaude(body: ProbeBody, budget: Budget, cwd: string): Promise<Cell> {
  const model = "haiku";
  if (!budget.take()) {
    return blankCell({
      provider: "claude",
      model,
      body,
      error: "回合预算用完，未发送",
      turns: 0,
      compactNote: "未测",
    });
  }
  const file = NodePath.join(cwd, `preamble-${body.label}.txt`);
  NodeFS.writeFileSync(file, body.text, "utf8");
  const sessionId = NodeCrypto.randomUUID();
  const quiet = [
    "--model",
    model,
    "--tools",
    "",
    "--permission-prompts",
    "none",
    "--output-format",
    "json",
  ];
  const first = await runCommand(
    "claude",
    ["-p", ...quiet, "--session-id", sessionId, "--append-system-prompt-file", file, askText()],
    cwd,
    TURN_TIMEOUT_MS,
  );
  const parsed = claudeResultText(first.stdout);
  const failure = commandFailure(first);
  const received = failure === null ? foundMarkers(parsed, body.markers) : [];
  const cell = blankCell({
    provider: "claude",
    model,
    body,
    error: failure,
    turns: 1,
    compactNote: "未测",
  });
  cell.received = received;
  cell.firstMissing =
    received.length === body.markers.length
      ? null
      : (body.markers.find((marker) => !received.includes(marker)) ?? null);
  if (failure !== null) {
    cell.compactNote = "未压，上一问失败";
    return cell;
  }
  if (skipCompact) {
    cell.compactNote = "这次没压（--no-compact），1KB 已单独压过";
    return cell;
  }
  if (!budget.take()) {
    cell.compactNote = "未测，回合预算用完";
    return cell;
  }
  const compact = await runCommand(
    "claude",
    ["-p", ...quiet, "--resume", sessionId, "/compact"],
    cwd,
    TURN_TIMEOUT_MS,
  );
  cell.turns += 1;
  const compactFailure = commandFailure(compact);
  if (compactFailure !== null) {
    cell.compactNote = compactFailure;
    cell.error = compactFailure;
    return cell;
  }
  if (!budget.take()) {
    cell.compactNote = "压缩命令已发出，没有剩余回合再问";
    return cell;
  }
  const after = await runCommand(
    "claude",
    ["-p", ...quiet, "--system-prompt-snapshot", "off", "--resume", sessionId, askText()],
    cwd,
    TURN_TIMEOUT_MS,
  );
  cell.turns += 1;
  const afterText = claudeResultText(after.stdout);
  const afterFailure = commandFailure(after);
  if (afterFailure !== null) {
    cell.compactNote = afterFailure;
    cell.error = afterFailure;
    return cell;
  }
  cell.afterCompact = foundMarkers(afterText, body.markers);
  cell.compactNote = "已压。追问不再带 append 文件，并关掉 system-prompt-snapshot";
  return cell;
}

interface RpcChild {
  readonly request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  readonly notify: (method: string, params: unknown) => void;
  readonly waitFor: (predicate: (message: Json) => boolean, timeoutMs: number) => Promise<Json>;
  readonly close: () => void;
}

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === "object" ? (value as Json) : null;
}

function startRpc(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  jsonrpc: boolean;
  onRequest: (method: string, params: unknown) => unknown;
  onNotification: (method: string, params: unknown) => void;
}): RpcChild {
  const launch = launchSpec(input.command, input.args);
  const child: NodeChildProcess.ChildProcessWithoutNullStreams = NodeChildProcess.spawn(
    launch.file,
    launch.args,
    {
      cwd: input.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffer = "";
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const notes: Json[] = [];
  const noteWaiters: Array<(message: Json) => void> = [];
  let stderr = "";
  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 100_000) stderr += chunk;
  });
  child.on("error", (error) => failAll(error));
  child.on("close", (code) => failAll(new Error(redact(`进程退出 code=${code} ${stderr}`.trim()))));
  const handle = (message: Json) => {
    const id = message.id;
    if (typeof message.method === "string" && (typeof id === "number" || typeof id === "string")) {
      const result = input.onRequest(message.method, message.params);
      const response: Json = { id: id as never };
      if (input.jsonrpc) response.jsonrpc = "2.0";
      if (result instanceof Error) response.error = { code: -32603, message: result.message };
      else response.result = result as never;
      child.stdin.write(`${JSON.stringify(response)}\n`);
      return;
    }
    if (typeof id === "number" && pending.has(id)) {
      const waiter = pending.get(id)!;
      pending.delete(id);
      if (message.error !== undefined)
        waiter.reject(new Error(redact(JSON.stringify(message.error))));
      else waiter.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      input.onNotification(message.method, message.params);
      notes.push(message);
      for (const waiter of noteWaiters.splice(0)) waiter(message);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          handle(JSON.parse(line) as Json);
        } catch {
          // stdout can carry non-json logs
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  return {
    request(method, params, timeoutMs) {
      const id = nextId;
      nextId += 1;
      const frame: Json = { id, method, params: params as never };
      if (input.jsonrpc) frame.jsonrpc = "2.0";
      child.stdin.write(`${JSON.stringify(frame)}\n`);
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`超时 ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      return promise;
    },
    notify(method, params) {
      const frame: Json = { method, params: params as never };
      if (input.jsonrpc) frame.jsonrpc = "2.0";
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    waitFor(predicate, timeoutMs) {
      const existing = notes.find(predicate);
      if (existing) return Promise.resolve(existing);
      const { promise, resolve, reject } = Promise.withResolvers<Json>();
      const timer = setTimeout(() => reject(new Error("超时等待通知")), timeoutMs);
      const waiter = (message: Json) => {
        if (!predicate(message)) {
          noteWaiters.push(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(message);
      };
      noteWaiters.push(waiter);
      return promise;
    },
    close() {
      if (child.pid !== undefined) killTree(child.pid);
    },
  };
}

function commandNames(session: unknown): string[] {
  const commands = asRecord(session)?.availableCommands;
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((command) => {
    const name = asRecord(command)?.name;
    return typeof name === "string" ? [name.replace(/^\//, "")] : [];
  });
}

function antigravityAppends(initialize: unknown): boolean {
  const info = asRecord(asRecord(initialize)?.agentInfo);
  if (info?.version === "1.4.5") return true;
  const capabilities = asRecord(asRecord(initialize)?.agentCapabilities);
  const extension = asRecord(asRecord(capabilities?._meta)?.antigravity);
  return asRecord(extension?.systemPrompt)?.append === true;
}

async function probeAcp(input: {
  provider: "antigravity" | "acp";
  command: string;
  args: readonly string[];
  model: string;
  body: ProbeBody;
  budget: Budget;
  cwd: string;
  sessionMeta: (initialize: unknown) => Json | undefined;
  missingChannel: (initialize: unknown) => string | null;
}): Promise<Cell> {
  let turns = 0;
  let agentText = "";
  let thoughtText = "";
  const rpc = startRpc({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    jsonrpc: true,
    onRequest: (method) => {
      if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
      return new Error(`probe does not serve ${method}`);
    },
    onNotification: (method, params) => {
      if (method !== "session/update") return;
      const update = asRecord(asRecord(params)?.update);
      const kind = update?.sessionUpdate;
      const content = asRecord(update?.content);
      if (typeof content?.text !== "string") return;
      if (kind === "agent_message_chunk" || kind === "agent_message") agentText += content.text;
      if (kind === "agent_thought_chunk" || kind === "agent_thought") thoughtText += content.text;
    },
  });
  try {
    const initialize = await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "bot-preamble-probe", version: "0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      60_000,
    );
    const blocked = input.missingChannel(initialize);
    if (blocked !== null) {
      return blankCell({
        provider: input.provider,
        model: input.model,
        body: input.body,
        error: blocked,
        turns: 0,
        compactNote: "没法触发",
      });
    }
    const created = await rpc.request(
      "session/new",
      {
        cwd: input.cwd,
        mcpServers: [],
        ...(input.sessionMeta(initialize) === undefined
          ? {}
          : { _meta: input.sessionMeta(initialize) }),
      },
      60_000,
    );
    const sessionId = asRecord(created)?.sessionId;
    if (typeof sessionId !== "string") throw new Error("session/new 没有 sessionId");
    if (!input.budget.take()) {
      return blankCell({
        provider: input.provider,
        model: input.model,
        body: input.body,
        error: "回合预算用完，未发送",
        turns: 0,
        compactNote: "未测",
      });
    }
    turns += 1;
    agentText = "";
    thoughtText = "";
    await rpc.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: askText() }] },
      TURN_TIMEOUT_MS,
    );
    const seen = seenMarkers(agentText, thoughtText, input.body.markers);
    const cell = blankCell({
      provider: input.provider,
      model: input.model,
      body: input.body,
      error: seen.where === "thought" ? "最终回复没有，标记只出现在思考流" : null,
      turns,
      compactNote: "未测",
    });
    cell.received = seen.received;
    cell.firstMissing = firstDrop(input.body.markers, seen.received);
    if (skipCompact) {
      cell.compactNote = "这次没压（--no-compact）";
      return cell;
    }
    if (!commandNames(created).includes("compact")) {
      cell.compactNote = "没法触发：session/new 没广告 compact 命令";
      return cell;
    }
    if (!input.budget.take()) {
      cell.compactNote = "有 compact 命令，回合预算用完未发";
      return cell;
    }
    turns += 1;
    cell.turns = turns;
    agentText = "";
    thoughtText = "";
    await rpc.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: "/compact" }] },
      TURN_TIMEOUT_MS,
    );
    if (!input.budget.take()) {
      cell.compactNote = "已发 /compact，没有剩余回合再问";
      return cell;
    }
    turns += 1;
    cell.turns = turns;
    agentText = "";
    thoughtText = "";
    await rpc.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: askText() }] },
      TURN_TIMEOUT_MS,
    );
    cell.afterCompact = foundMarkers(agentText, input.body.markers);
    cell.compactNote = "已发 /compact，追问不再带开场说明";
    return cell;
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    const seen = seenMarkers(agentText, thoughtText, input.body.markers);
    const cell = blankCell({
      provider: input.provider,
      model: input.model,
      body: input.body,
      error:
        seen.where === "thought"
          ? `${message}（标记只出现在思考流）`
          : seen.received.length > 0
            ? `${message}（超时前已有回复）`
            : message,
      turns,
      compactNote: "未测",
    });
    cell.received = seen.received;
    cell.firstMissing = firstDrop(input.body.markers, seen.received);
    return cell;
  } finally {
    rpc.close();
  }
}

async function probeCodex(body: ProbeBody, budget: Budget, cwd: string): Promise<Cell> {
  const model = "gpt-6-luna";
  const status = await runCommand("codex", ["login", "status"], cwd, 30_000);
  if (/not logged in/i.test(`${status.stdout}\n${status.stderr}`)) {
    return blankCell({
      provider: "codex",
      model,
      body,
      error: "codex login status: Not logged in",
      turns: 0,
      compactNote: "未测",
    });
  }
  if (status.code !== 0 || status.timedOut) {
    return blankCell({
      provider: "codex",
      model,
      body,
      error: redact(`${status.stderr}\n${status.stdout}`.trim() || "codex login status 失败"),
      turns: 0,
      compactNote: "未测",
    });
  }
  if (!budget.take()) {
    return blankCell({
      provider: "codex",
      model,
      body,
      error: "回合预算用完，未发送",
      turns: 0,
      compactNote: "未测",
    });
  }
  let turns = 1;
  let agentText = "";
  const rpc = startRpc({
    command: "codex",
    args: ["app-server"],
    cwd,
    jsonrpc: false,
    onRequest: () => ({ decline: true }),
    onNotification: (method, params) => {
      const record = asRecord(params);
      if (method === "item/agentMessage/delta" && typeof record?.delta === "string")
        agentText += record.delta;
      const item = asRecord(record?.item);
      if (
        method === "item/completed" &&
        item?.type === "agentMessage" &&
        typeof item.text === "string"
      ) {
        agentText = item.text;
      }
    },
  });
  try {
    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "bot-preamble-probe", title: "bot preamble probe", version: "0" },
        capabilities: { experimentalApi: true },
      },
      60_000,
    );
    rpc.notify("initialized", {});
    const additionalContext = Object.fromEntries(
      body.sections.map((section, index) => [
        `probe_${String(index + 1).padStart(2, "0")}`,
        { kind: "application", value: section },
      ]),
    );
    const started = asRecord(
      await rpc.request(
        "thread/start",
        { cwd, model, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" },
        60_000,
      ),
    );
    const threadId = asRecord(started?.thread)?.id;
    if (typeof threadId !== "string") throw new Error("thread/start 没有 thread.id");
    agentText = "";
    const turn = asRecord(
      await rpc.request(
        "turn/start",
        {
          threadId,
          model,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
          input: [{ type: "text", text: askText() }],
          additionalContext,
        },
        30_000,
      ),
    );
    const turnId = asRecord(turn?.turn)?.id;
    await rpc.waitFor(
      (message) => message.method === "turn/completed" && sameTurn(message, turnId),
      TURN_TIMEOUT_MS,
    );
    const received = foundMarkers(agentText, body.markers);
    const cell = blankCell({
      provider: "codex",
      model,
      body,
      error: null,
      turns,
      compactNote: "未测",
    });
    cell.received = received;
    cell.firstMissing =
      received.length === body.markers.length
        ? null
        : (body.markers.find((marker) => !received.includes(marker)) ?? null);
    if (skipCompact) {
      cell.compactNote = "这次没压（--no-compact）";
      return cell;
    }
    if (!budget.take()) {
      cell.compactNote = "未测，回合预算用完";
      return cell;
    }
    turns += 1;
    cell.turns = turns;
    await rpc.request("thread/compact/start", { threadId }, 30_000);
    await rpc.waitFor((message) => message.method === "thread/compacted", TURN_TIMEOUT_MS);
    if (!budget.take()) {
      cell.compactNote = "已发 thread/compact/start，没有剩余回合再问";
      return cell;
    }
    turns += 1;
    cell.turns = turns;
    agentText = "";
    const follow = asRecord(
      await rpc.request(
        "turn/start",
        {
          threadId,
          model,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
          input: [{ type: "text", text: askText() }],
        },
        30_000,
      ),
    );
    const followId = asRecord(follow?.turn)?.id;
    await rpc.waitFor(
      (message) => message.method === "turn/completed" && sameTurn(message, followId),
      TURN_TIMEOUT_MS,
    );
    cell.afterCompact = foundMarkers(agentText, body.markers);
    cell.compactNote = "已发 thread/compact/start，追问不再带 additionalContext";
    return cell;
  } catch (error) {
    return blankCell({
      provider: "codex",
      model,
      body,
      error: redact(error instanceof Error ? error.message : String(error)),
      turns,
      compactNote: "未测",
    });
  } finally {
    rpc.close();
  }
}

function sameTurn(message: Json, turnId: unknown): boolean {
  if (typeof turnId !== "string") return true;
  const params = asRecord(message.params);
  return params?.turnId === turnId || asRecord(params?.turn)?.id === turnId;
}

async function probeGrok(body: ProbeBody, budget: Budget, cwd: string): Promise<Cell> {
  const model = "grok-4.5";
  const models = await runCommand("grok", ["models"], cwd, 30_000);
  if (/not authenticated/i.test(`${models.stdout}\n${models.stderr}`)) {
    return blankCell({
      provider: "grok",
      model,
      body,
      error: "grok models: You are not authenticated",
      turns: 0,
      compactNote: "未测",
    });
  }
  if (!budget.take()) {
    return blankCell({
      provider: "grok",
      model,
      body,
      error: "回合预算用完，未发送",
      turns: 0,
      compactNote: "未测",
    });
  }
  const first = await runCommand(
    "grok",
    [
      "-p",
      "--model",
      model,
      "--max-turns",
      "1",
      "--disable-web-search",
      "--output-format",
      "json",
      "--rules",
      body.text,
      askText(),
    ],
    cwd,
    TURN_TIMEOUT_MS,
  );
  const failure = commandFailure(first);
  const received = failure === null ? foundMarkers(first.stdout, body.markers) : [];
  const cell = blankCell({
    provider: "grok",
    model,
    body,
    error: failure,
    turns: 1,
    compactNote: "未测",
  });
  cell.received = received;
  cell.firstMissing =
    failure !== null
      ? (body.markers[0] ?? null)
      : received.length === body.markers.length
        ? null
        : (body.markers.find((marker) => !received.includes(marker)) ?? null);
  if (failure !== null) {
    cell.compactNote = "未压，上一问失败";
    return cell;
  }
  if (skipCompact) {
    cell.compactNote = "这次没压（--no-compact）";
    return cell;
  }
  const sessionId = readSessionId(first.stdout);
  if (sessionId === null) {
    cell.compactNote = "没法触发：单轮 JSON 里没有会话 id，不能续上再发 /compact";
    return cell;
  }
  if (!budget.take()) {
    cell.compactNote = "未测，回合预算用完";
    return cell;
  }
  const compact = await runCommand(
    "grok",
    ["-p", "--model", model, "--resume", sessionId, "--output-format", "json", "/compact"],
    cwd,
    TURN_TIMEOUT_MS,
  );
  cell.turns += 1;
  const compactFailure = commandFailure(compact);
  if (compactFailure !== null) {
    cell.compactNote = compactFailure;
    cell.error = compactFailure;
    return cell;
  }
  if (!budget.take()) {
    cell.compactNote = "已发 /compact，没有剩余回合再问";
    return cell;
  }
  const after = await runCommand(
    "grok",
    ["-p", "--model", model, "--resume", sessionId, "--output-format", "json", askText()],
    cwd,
    TURN_TIMEOUT_MS,
  );
  cell.turns += 1;
  const afterFailure = commandFailure(after);
  if (afterFailure !== null) {
    cell.compactNote = afterFailure;
    cell.error = afterFailure;
    return cell;
  }
  cell.afterCompact = foundMarkers(after.stdout, body.markers);
  cell.compactNote = "已发 /compact，追问不再带 --rules";
  return cell;
}

function readSessionId(stdout: string): string | null {
  try {
    const value = JSON.parse(stdout) as Json;
    for (const key of ["session_id", "sessionId", "id"]) {
      if (typeof value[key] === "string") return value[key];
    }
  } catch {
    return null;
  }
  return null;
}

function parseArgs(argv: readonly string[]): {
  dryRun: boolean;
  providers: readonly ProviderName[];
  sizes: readonly SizeLabel[];
  maxTurns: number;
} {
  let dryRun = false;
  let providers = Object.keys(channels) as ProviderName[];
  let sizes: SizeLabel[] = SIZES.map((size) => size.label);
  let maxTurns = MAX_TURNS_DEFAULT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--provider") {
      providers = (argv[++index] ?? "").split(",").map((name) => name.trim()) as ProviderName[];
      for (const name of providers) {
        if (!(name in channels)) throw new Error(`未知 provider ${name}`);
      }
    } else if (arg === "--sizes") {
      const requested = (argv[++index] ?? "").split(",").map((size) => size.trim().toUpperCase());
      sizes = SIZES.map((size) => size.label).filter((label) => requested.includes(label));
    } else if (arg === "--max-turns") maxTurns = Number(argv[++index]);
    else if (arg === "--turn-timeout-ms") TURN_TIMEOUT_MS = Number(argv[++index]);
    else if (arg === "--no-compact") skipCompact = true;
    else if (arg === "--help") {
      console.log(
        "node scripts/bot-preamble-probe.ts [--dry-run] [--no-compact] [--provider claude,codex,grok,antigravity,acp] [--sizes 1KB,4KB,16KB,64KB] [--max-turns 10]",
      );
      process.exit(0);
    } else throw new Error(`未知参数 ${arg}`);
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("--max-turns 要是正整数");
  if (sizes.length === 0) throw new Error("--sizes 没有认出档位");
  return { dryRun, providers, sizes, maxTurns };
}

function dispatch(
  provider: ProviderName,
  body: ProbeBody,
  budget: Budget,
  cwd: string,
): Promise<Cell> {
  if (provider === "claude") return probeClaude(body, budget, cwd);
  if (provider === "codex") return probeCodex(body, budget, cwd);
  if (provider === "grok") return probeGrok(body, budget, cwd);
  if (provider === "antigravity") {
    return probeAcp({
      provider,
      command: "agy",
      args: ["acp", "--stdio"],
      model: "会话默认模型",
      body,
      budget,
      cwd,
      sessionMeta: (initialize) =>
        antigravityAppends(initialize)
          ? { antigravity: { systemPrompt: { append: body.text } } }
          : undefined,
      missingChannel: (initialize) =>
        antigravityAppends(initialize)
          ? null
          : "这版 initialize 没有 systemPrompt.append，不把开场说明塞进 _meta",
    });
  }
  return probeAcp({
    provider: "acp",
    command: "kimi",
    args: ["acp"],
    model: "kimi 默认",
    body,
    budget,
    cwd,
    sessionMeta: () => undefined,
    missingChannel: () => null,
  });
}

async function runProvider(
  provider: ProviderName,
  bodies: readonly ProbeBody[],
  maxTurns: number,
): Promise<{ cells: Cell[]; turns: number }> {
  const budget = new Budget(maxTurns);
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bot-preamble-probe-"));
  const cells: Cell[] = [];
  try {
    for (let index = 0; index < bodies.length; index += 1) {
      const body = bodies[index]!;
      if (provider === "acp")
        NodeFS.writeFileSync(NodePath.join(cwd, "AGENTS.md"), body.text, "utf8");
      const cell = await dispatch(provider, body, budget, cwd);
      cells.push(cell);
      if (cell.error !== null && cell.received.length === 0) {
        for (const rest of bodies.slice(index + 1)) {
          cells.push({
            ...cell,
            size: rest.label,
            sectionCount: rest.sections.length,
            received: [],
            firstMissing: null,
            afterCompact: null,
            turns: 0,
            compactNote: "未测",
            error: cell.turns === 0 ? cell.error : `未跑：${body.label} 没收到（${cell.error}）`,
          });
        }
        break;
      }
    }
    return { cells, turns: budget.turns };
  } finally {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        NodeFS.rmSync(cwd, { recursive: true, force: true });
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
  }
}

function printTable(cells: readonly Cell[]): void {
  console.log("\n| 家 | 档 | 注入口 | 收到段数 | 开始丢的位置 | 压缩后剩余 | 报错 |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const cell of cells) {
    const dropped = cell.turns === 0 ? "未测" : (cell.firstMissing ?? "没丢");
    const after =
      cell.afterCompact === null ? cell.compactNote : cell.afterCompact.join(" ") || "(无)";
    console.log(
      `| ${cell.provider} | ${cell.size} | ${cell.channel} | ${cell.received.length}/${cell.sectionCount} ${cell.received.join(" ")} | ${dropped} | ${after} | ${cell.error ?? ""} |`,
    );
  }
}

const parsed = parseArgs(process.argv.slice(2));
const bodies = SIZES.filter((size) => parsed.sizes.includes(size.label)).map((size) =>
  buildProbe(size.label, size.bytes),
);
if (parsed.dryRun) {
  for (const provider of parsed.providers) {
    console.log(`\n# ${provider}`);
    console.log(`注入口: ${channels[provider]}`);
    for (const body of bodies) {
      console.log(
        `${body.label}: ${body.bytes} bytes, ${body.sections.length} 节, 暗号 ${body.markers.join(" ")}`,
      );
    }
    console.log(`用户问句: ${askText()}`);
  }
} else {
  const cells: Cell[] = [];
  const turnCount: Record<string, number> = {};
  for (const provider of parsed.providers) {
    const result = await runProvider(provider, bodies, parsed.maxTurns);
    cells.push(...result.cells);
    turnCount[provider] = result.turns;
  }
  printTable(cells);
  console.log(`\n回合: ${JSON.stringify(turnCount)}`);
  const outDir = NodePath.join(process.cwd(), "_tmp");
  NodeFS.mkdirSync(outDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(outDir, "bot-preamble-probe-result.json"),
    JSON.stringify({ cells, turnCount }, null, 2),
  );
}
