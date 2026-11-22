// @effect-diagnostics nodeBuiltinImport:off - Vite reads this while loading the web test config, before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";

export const BROWSER_TEST_API_PORT_BASE = 20_000;
export const BROWSER_TEST_API_PORT_SPAN = 4_000;

const BROWSER_TEST_API_PORT_LAST = BROWSER_TEST_API_PORT_BASE + BROWSER_TEST_API_PORT_SPAN - 1;

export interface PortRange {
  readonly start: number;
  readonly end: number;
}

// Hyper-V carves exclusions from the default dynamic range. Its 100-port
// blocks move on each boot, so a missed netsh read cannot know them.
export const COMMON_WINDOWS_EXCLUDED_PORT_RANGES: readonly PortRange[] = [
  { start: 49_152, end: 65_535 },
];

export interface NetshSpawn {
  (
    file: string,
    args: readonly string[],
    options: {
      readonly encoding: "buffer";
      readonly windowsHide: true;
      readonly timeout: number;
    },
  ): Uint8Array;
}

const NETSH_ARGS = ["int", "ipv4", "show", "excludedportrange", "protocol=tcp"] as const;
const SEPARATOR = /-{5,}/;
const PORT_LINE = /^\s*(\d+)\s+(\d+)\b/;

// strictPort steps past EADDRINUSE only. An excluded port has to be skipped here.
export function pickBrowserTestApiPort(hash: number, excluded: readonly PortRange[]): number {
  const origin = BROWSER_TEST_API_PORT_BASE + ((hash >>> 0) % BROWSER_TEST_API_PORT_SPAN);
  const blocked = mergeRanges(
    clipRanges(excluded, BROWSER_TEST_API_PORT_BASE, BROWSER_TEST_API_PORT_LAST),
  );
  return (
    firstOpen(blocked, origin, BROWSER_TEST_API_PORT_LAST) ??
    firstOpen(blocked, BROWSER_TEST_API_PORT_BASE, origin - 1) ??
    failClosed()
  );
}

export function parseNetshExcludedPortRanges(text: string): readonly PortRange[] | null {
  const ranges: PortRange[] = [];
  let sawTable = false;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (SEPARATOR.test(line)) sawTable = true;
    const match = PORT_LINE.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start > end || end > 65_535) continue;
    ranges.push({ start, end });
    sawTable = true;
  }
  return sawTable ? ranges : null;
}

export function excludedPortRangesForPlatform(
  platform: NodeJS.Platform,
  readNetsh: () => string | null,
): readonly PortRange[] {
  if (platform !== "win32") return [];
  const text = readNetsh();
  if (text === null) return COMMON_WINDOWS_EXCLUDED_PORT_RANGES;
  return parseNetshExcludedPortRanges(text) ?? COMMON_WINDOWS_EXCLUDED_PORT_RANGES;
}

export function readNetshExcludedPortText(exec: NetshSpawn = defaultNetshExec): string | null {
  const root = process.env.SystemRoot || "C:\\Windows";
  try {
    return decodeNetshOutput(
      exec(`${root}\\System32\\netsh.exe`, NETSH_ARGS, {
        encoding: "buffer",
        windowsHide: true,
        timeout: 3_000,
      }),
    );
  } catch {
    return null;
  }
}

function defaultNetshExec(
  file: string,
  args: readonly string[],
  options: { readonly encoding: "buffer"; readonly windowsHide: true; readonly timeout: number },
): Uint8Array {
  return NodeChildProcess.execFileSync(file, args, options);
}

function decodeNetshOutput(output: Uint8Array): string {
  if (output.length >= 2 && output[0] === 0xff && output[1] === 0xfe) {
    return Buffer.from(output.buffer, output.byteOffset + 2, output.byteLength - 2).toString(
      "utf16le",
    );
  }
  if (looksLikeUtf16Le(output)) return Buffer.from(output).toString("utf16le");
  return Buffer.from(output).toString("utf8");
}

function looksLikeUtf16Le(output: Uint8Array): boolean {
  if (output.length < 8 || output.length % 2 !== 0) return false;
  const sample = Math.min(output.length, 32);
  for (let index = 1; index < sample; index += 2) {
    if (output[index] !== 0) return false;
  }
  return true;
}

function clipRanges(ranges: readonly PortRange[], low: number, high: number): PortRange[] {
  const clipped: PortRange[] = [];
  for (const range of ranges) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) continue;
    const start = Math.max(range.start, low);
    const end = Math.min(range.end, high);
    if (start <= end) clipped.push({ start, end });
  }
  return clipped;
}

function mergeRanges(ranges: readonly PortRange[]): PortRange[] {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: PortRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

function firstOpen(blocked: readonly PortRange[], from: number, to: number): number | undefined {
  if (from > to) return undefined;
  let port = from;
  for (const range of blocked) {
    if (range.end < port) continue;
    if (range.start > port) return port;
    port = range.end + 1;
    if (port > to) return undefined;
  }
  return port <= to ? port : undefined;
}

function failClosed(): never {
  throw new Error(
    `browser test api ports ${BROWSER_TEST_API_PORT_BASE}-${BROWSER_TEST_API_PORT_LAST} are all excluded`,
  );
}
