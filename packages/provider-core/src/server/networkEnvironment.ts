// Reclaude owns its own proxy and CA. A binary whose path points at it must not
// inherit or receive HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY, or NODE_EXTRA_CA_CERTS.
// Loopback port 56879 is that proxy and is never injected for anyone else either.

const RECLAUDE_PROXY_PORT = "56879";

const PROXY_ENV_NAMES = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "node_extra_ca_certs",
  "node_use_env_proxy",
] as const;

const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";

const WRAPPER_STEMS = new Set(["node", "cmd"]);

const AGENT_STEMS: Readonly<Record<string, readonly string[]>> = {
  grok: ["grok"],
  codex: ["codex"],
  claudeAgent: ["claude", "reclaude"],
  antigravity: ["antigravity", "agy"],
};

export interface AgentNetworkOverride {
  readonly line: "follow" | "direct" | "custom";
  readonly proxyUrl: string;
  readonly noProxy: string;
}

export interface AgentNetworkSettings {
  readonly line: "auto" | "direct" | "custom";
  readonly proxyUrl: string;
  readonly noProxy: string;
  readonly extraCaCertPath: string;
  readonly agentOverrides: Readonly<Record<string, AgentNetworkOverride>>;
}

export interface SystemProxyRead {
  readonly proxyUrl: string | null;
  readonly noProxy: string;
  readonly detail: string;
  readonly available: boolean;
}

export type NetworkRouteSource = "system" | "custom" | "direct" | "unavailable" | "rejected";

export interface ResolvedNetworkRoute {
  readonly proxyUrl: string | null;
  readonly noProxy: string;
  readonly source: NetworkRouteSource;
  readonly detail: string;
}

export interface KnownAgentBinary {
  readonly driver: string;
  readonly binaryPath?: string | undefined;
}

export interface AgentNetworkTarget {
  readonly command: string;
  readonly args: readonly string[];
}

const DIRECT: ResolvedNetworkRoute = {
  proxyUrl: null,
  noProxy: "",
  source: "direct",
  detail: "直连",
};

function commandStem(command: string): string {
  const trimmed = command.trim().replace(/^"(.*)"$/, "$1");
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function isReclaudePath(command: string): boolean {
  const trimmed = command.trim().replace(/^"(.*)"$/, "$1");
  return trimmed.split(/[\\/]/).some((part) => commandStem(part) === "reclaude");
}

function isReclaudeLaunch(command: string, args: readonly string[]): boolean {
  if (isReclaudePath(command)) return true;
  if (!WRAPPER_STEMS.has(commandStem(command))) return false;
  return args.some((arg) => isReclaudePath(arg));
}

function normalizeProxyUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || !url.port) return null;
  return `${url.protocol}//${url.host}`;
}

function isReclaudeProxyUrl(proxyUrl: string): boolean {
  try {
    const url = new URL(proxyUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    return loopback && url.port === RECLAUDE_PROXY_PORT;
  } catch {
    return false;
  }
}

function hostBypassesProxy(hostname: string, noProxy: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  for (const rule of noProxy.split(/[,;\s]+/)) {
    const item = rule.trim().toLowerCase();
    if (!item) continue;
    if (item === "*") return true;
    if (item.startsWith(".")) {
      if (host.endsWith(item) || host === item.slice(1)) return true;
      continue;
    }
    if (host === item || host.endsWith(`.${item}`)) return true;
  }
  return false;
}

function driverForCommand(
  command: string,
  args: readonly string[],
  agents: readonly KnownAgentBinary[] = [],
): string | null {
  const normalized = command
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/\\/g, "/")
    .toLowerCase();
  for (const agent of agents) {
    const configured = agent.binaryPath?.trim().replace(/\\/g, "/").toLowerCase();
    if (configured && configured === normalized) return agent.driver;
  }
  const stem = commandStem(command);
  for (const [driver, stems] of Object.entries(AGENT_STEMS)) {
    if (stems.includes(stem)) return driver;
  }
  if (!WRAPPER_STEMS.has(stem)) return null;
  for (const arg of args) {
    const argStem = commandStem(arg);
    for (const [driver, stems] of Object.entries(AGENT_STEMS)) {
      if (stems.includes(argStem)) return driver;
    }
  }
  return null;
}

function mergeNoProxy(left: string, right: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const part of `${left},${right}`.split(/[,;\s]+/)) {
    const item = part.trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(item);
  }
  return parts.join(",");
}

function finishRoute(
  proxyUrl: string | null,
  noProxy: string,
  source: NetworkRouteSource,
  detail: string,
): ResolvedNetworkRoute {
  if (!proxyUrl) return { proxyUrl: null, noProxy: "", source, detail };
  if (isReclaudeProxyUrl(proxyUrl)) {
    return {
      proxyUrl: null,
      noProxy: "",
      source: "rejected",
      detail: "56879 是 reclaude 专用端口，不拿来做线路，已按直连",
    };
  }
  return {
    proxyUrl,
    noProxy: mergeNoProxy(noProxy, LOOPBACK_NO_PROXY),
    source,
    detail,
  };
}

function resolveCustom(proxyUrl: string, noProxy: string): ResolvedNetworkRoute {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) {
    return {
      proxyUrl: null,
      noProxy: "",
      source: "rejected",
      detail: "地址要写成 http://主机:端口，已按直连",
    };
  }
  return finishRoute(normalized, noProxy, "custom", "指定地址");
}

export function resolveGlobalRoute(
  settings: AgentNetworkSettings,
  systemProxy: SystemProxyRead,
): ResolvedNetworkRoute {
  if (settings.line === "direct") return DIRECT;
  if (settings.line === "custom") return resolveCustom(settings.proxyUrl, settings.noProxy);
  if (!systemProxy.available && !systemProxy.proxyUrl) {
    return {
      proxyUrl: null,
      noProxy: "",
      source: "unavailable",
      detail: systemProxy.detail || "读不到系统代理，按直连",
    };
  }
  if (!systemProxy.proxyUrl) {
    return {
      proxyUrl: null,
      noProxy: "",
      source: "direct",
      detail: systemProxy.detail || "系统代理没有开",
    };
  }
  return finishRoute(
    systemProxy.proxyUrl,
    mergeNoProxy(systemProxy.noProxy, settings.noProxy),
    "system",
    systemProxy.detail || "来自系统代理",
  );
}

export function resolveAgentRoute(
  settings: AgentNetworkSettings,
  systemProxy: SystemProxyRead,
  driver: string | null,
): ResolvedNetworkRoute {
  const override = driver ? settings.agentOverrides[driver] : undefined;
  if (override?.line === "direct") return DIRECT;
  if (override?.line === "custom") return resolveCustom(override.proxyUrl, override.noProxy);
  return resolveGlobalRoute(settings, systemProxy);
}

export function proxyUrlForServerRequest(
  hostname: string,
  route: ResolvedNetworkRoute,
): string | null {
  if (!route.proxyUrl || isReclaudeProxyUrl(route.proxyUrl)) return null;
  if (hostBypassesProxy(hostname, route.noProxy)) return null;
  return route.proxyUrl;
}

function stripProxyEnv(
  hostEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (PROXY_ENV_NAMES.includes(key.toLowerCase() as (typeof PROXY_ENV_NAMES)[number])) continue;
    next[key] = value;
  }
  return next;
}

function assignBothCases(env: Record<string, string>, name: string, value: string) {
  env[name.toUpperCase()] = value;
  env[name.toLowerCase()] = value;
}

export function applyAgentNetworkEnvironment(input: {
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  readonly settings: AgentNetworkSettings;
  readonly systemProxy: SystemProxyRead;
  readonly target: AgentNetworkTarget;
  readonly agents?: readonly KnownAgentBinary[];
}): Record<string, string> {
  const next = stripProxyEnv(input.hostEnv);
  if (isReclaudeLaunch(input.target.command, input.target.args)) return next;
  const driver = driverForCommand(input.target.command, input.target.args, input.agents ?? []);
  const route = resolveAgentRoute(input.settings, input.systemProxy, driver);
  const extraCa = input.settings.extraCaCertPath.trim();
  if (extraCa) next.NODE_EXTRA_CA_CERTS = extraCa;
  if (!route.proxyUrl) return next;
  assignBothCases(next, "HTTP_PROXY", route.proxyUrl);
  assignBothCases(next, "HTTPS_PROXY", route.proxyUrl);
  assignBothCases(next, "ALL_PROXY", route.proxyUrl);
  assignBothCases(next, "NO_PROXY", route.noProxy);
  assignBothCases(next, "NODE_USE_ENV_PROXY", "1");
  return next;
}

function windowsOverrideToNoProxy(raw: string): string {
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.toLowerCase() === "<local>" ? "localhost,127.0.0.1" : part))
    .join(",");
}

function pickWindowsProxyServer(raw: string): string | null {
  const parts = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const byScheme = new Map<string, string>();
  const bare: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0) byScheme.set(part.slice(0, eq).toLowerCase(), part.slice(eq + 1).trim());
    else bare.push(part);
  }
  const chosen = byScheme.get("https") ?? byScheme.get("http") ?? bare[0];
  return chosen ? normalizeProxyUrl(chosen) : null;
}

export function parseWindowsInternetSettings(text: string): SystemProxyRead {
  const enable = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(text);
  const server = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(text);
  const override = /ProxyOverride\s+REG_SZ\s+(.+)/i.exec(text);
  if (!enable) {
    return {
      proxyUrl: null,
      noProxy: "",
      detail: "读不到系统代理，按直连",
      available: false,
    };
  }
  if (Number.parseInt(enable[1] ?? "", 16) === 0) {
    return { proxyUrl: null, noProxy: "", detail: "系统代理没有开", available: true };
  }
  const proxyUrl = pickWindowsProxyServer(server?.[1]?.trim() ?? "");
  if (!proxyUrl) {
    return {
      proxyUrl: null,
      noProxy: "",
      detail: "系统代理开了，但地址读不懂，按直连",
      available: true,
    };
  }
  return {
    proxyUrl,
    noProxy: windowsOverrideToNoProxy(override?.[1]?.trim() ?? ""),
    detail: "来自系统代理",
    available: true,
  };
}

function macValue(text: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*${name}\\s*:\\s*(.+)\\s*$`, "im").exec(text);
  return match?.[1]?.trim();
}

function macExceptions(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /ExceptionsList/.test(line));
  if (start < 0) return "";
  const hosts: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const entry = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line);
    if (entry?.[1]) {
      hosts.push(entry[1]);
      continue;
    }
    if (hosts.length > 0) break;
  }
  return hosts.join(",");
}

export function parseMacScutilProxy(text: string): SystemProxyRead {
  const httpsOn = macValue(text, "HTTPSEnable") === "1";
  const httpOn = macValue(text, "HTTPEnable") === "1";
  const exceptions = macExceptions(text);
  const pick = (prefix: "HTTPS" | "HTTP") => {
    const host = macValue(text, `${prefix}Proxy`);
    const port = macValue(text, `${prefix}Port`);
    if (!host || !port) return null;
    return normalizeProxyUrl(`${host}:${port}`);
  };
  if (
    !httpsOn &&
    !httpOn &&
    macValue(text, "HTTPSEnable") === undefined &&
    macValue(text, "HTTPEnable") === undefined
  ) {
    return { proxyUrl: null, noProxy: "", detail: "读不到系统代理，按直连", available: false };
  }
  const proxyUrl = (httpsOn ? pick("HTTPS") : null) ?? (httpOn ? pick("HTTP") : null);
  if (!proxyUrl) {
    return { proxyUrl: null, noProxy: "", detail: "系统代理没有开", available: true };
  }
  return { proxyUrl, noProxy: exceptions, detail: "来自系统代理", available: true };
}
