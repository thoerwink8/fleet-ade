import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_TEST_API_PORT_BASE,
  BROWSER_TEST_API_PORT_SPAN,
  COMMON_WINDOWS_EXCLUDED_PORT_RANGES,
  excludedPortRangesForPlatform,
  parseNetshExcludedPortRanges,
  pickBrowserTestApiPort,
  readNetshExcludedPortText,
  type NetshSpawn,
} from "./browserTestApiPort.ts";

const NETSH_TABLE = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
     5357        5357
    61482       61581
    50000       50059     *

* - Administered port exclusions.
`;

describe("pickBrowserTestApiPort", () => {
  it("steps past an excluded block instead of binding the hashed port", () => {
    // 20000 + 1510 lands on 21510, inside 21482-21581.
    expect(pickBrowserTestApiPort(1_510, [{ start: 21_482, end: 21_581 }])).toBe(21_582);
  });

  it("keeps the hashed port when no exclusion covers the window", () => {
    for (const hash of [0, 1, 1_510, 3_999, 4_000, 61_510, -1]) {
      const hashed = BROWSER_TEST_API_PORT_BASE + ((hash >>> 0) % BROWSER_TEST_API_PORT_SPAN);
      expect(pickBrowserTestApiPort(hash, [])).toBe(hashed);
      expect(pickBrowserTestApiPort(hash, COMMON_WINDOWS_EXCLUDED_PORT_RANGES)).toBe(hashed);
    }
  });

  it("walks to the next open port inside 20000-23999", () => {
    expect(
      pickBrowserTestApiPort(1_510, [
        { start: 21_541, end: 21_581 },
        { start: 21_482, end: 21_540 },
      ]),
    ).toBe(21_582);
    expect(pickBrowserTestApiPort(1_582, [{ start: 21_482, end: 21_581 }])).toBe(21_582);
    expect(pickBrowserTestApiPort(1_510, [{ start: 23_000, end: 23_100 }])).toBe(21_510);
    expect(pickBrowserTestApiPort(1_510, [{ start: 21_000, end: 22_000 }])).toBe(22_001);
    expect(pickBrowserTestApiPort(3_990, [{ start: 23_980, end: 24_050 }])).toBe(20_000);
    expect(
      pickBrowserTestApiPort(0, [
        { start: 20_000, end: 20_010 },
        { start: 23_990, end: 23_999 },
      ]),
    ).toBe(20_011);
  });

  it("refuses a window that is entirely excluded", () => {
    expect(() => pickBrowserTestApiPort(1_510, [{ start: 20_000, end: 23_999 }])).toThrow(
      /20000-23999 are all excluded/,
    );
  });
});

describe("parseNetshExcludedPortRanges", () => {
  it("reads inclusive tcp ranges and ignores the administered marker", () => {
    expect(parseNetshExcludedPortRanges(NETSH_TABLE)).toEqual([
      { start: 5_357, end: 5_357 },
      { start: 61_482, end: 61_581 },
      { start: 50_000, end: 50_059 },
    ]);
  });

  it("treats an empty table as no exclusions and other text as unreadable", () => {
    expect(parseNetshExcludedPortRanges("开始端口    结束端口\n----------    --------\n")).toEqual(
      [],
    );
    expect(parseNetshExcludedPortRanges("The following command was not found")).toBeNull();
    expect(parseNetshExcludedPortRanges("")).toBeNull();
  });
});

describe("excludedPortRangesForPlatform", () => {
  it("leaves non-Windows ports on the hash alone", () => {
    let reads = 0;
    expect(
      excludedPortRangesForPlatform("linux", () => {
        reads += 1;
        return null;
      }),
    ).toEqual([]);
    expect(
      excludedPortRangesForPlatform("darwin", () => {
        reads += 1;
        return NETSH_TABLE;
      }),
    ).toEqual([]);
    expect(reads).toBe(0);
  });

  it("uses the netsh table on Windows and the common range when that read fails", () => {
    expect(excludedPortRangesForPlatform("win32", () => NETSH_TABLE)).toEqual([
      { start: 5_357, end: 5_357 },
      { start: 61_482, end: 61_581 },
      { start: 50_000, end: 50_059 },
    ]);
    expect(excludedPortRangesForPlatform("win32", () => null)).toBe(
      COMMON_WINDOWS_EXCLUDED_PORT_RANGES,
    );
    expect(excludedPortRangesForPlatform("win32", () => "not a netsh table")).toBe(
      COMMON_WINDOWS_EXCLUDED_PORT_RANGES,
    );
  });
});

describe("readNetshExcludedPortText", () => {
  it("runs netsh hidden and decodes a utf-16 listing", () => {
    let seen:
      | { file: string; args: readonly string[]; windowsHide: boolean; timeout: number }
      | undefined;
    const exec: NetshSpawn = (file, args, options) => {
      seen = { file, args, windowsHide: options.windowsHide, timeout: options.timeout };
      return Buffer.from(NETSH_TABLE, "utf16le");
    };

    expect(readNetshExcludedPortText(exec)).toContain("61482");
    const root = process.env.SystemRoot || "C:\\Windows";
    expect(seen).toEqual({
      file: `${root}\\System32\\netsh.exe`,
      args: ["int", "ipv4", "show", "excludedportrange", "protocol=tcp"],
      windowsHide: true,
      timeout: 3_000,
    });
  });

  it("returns null when netsh fails, and strips a utf-16 BOM", () => {
    const failing: NetshSpawn = () => {
      throw new Error("ENOENT");
    };
    expect(readNetshExcludedPortText(failing)).toBeNull();

    const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(NETSH_TABLE, "utf16le")]);
    const exec: NetshSpawn = () => bom;
    expect(parseNetshExcludedPortRanges(readNetshExcludedPortText(exec) ?? "")).toEqual([
      { start: 5_357, end: 5_357 },
      { start: 61_482, end: 61_581 },
      { start: 50_000, end: 50_059 },
    ]);
  });
});
