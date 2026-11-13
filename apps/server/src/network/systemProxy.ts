// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The OS proxy read must not use the wrapped spawner, or the read recurses into itself.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  parseMacScutilProxy,
  parseWindowsInternetSettings,
  type SystemProxyRead,
} from "@t3tools/provider-core/server/networkEnvironment";

const UNAVAILABLE: SystemProxyRead = {
  proxyUrl: null,
  noProxy: "",
  detail: "读不到系统代理，按直连",
  available: false,
};

const LINUX: SystemProxyRead = {
  proxyUrl: null,
  noProxy: "",
  detail: "这个系统还不会读系统代理，按直连",
  available: false,
};

let cached: { readonly at: number; readonly value: SystemProxyRead } | undefined;

function readUncached(platform: NodeJS.Platform): SystemProxyRead {
  try {
    if (platform === "win32") {
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      const text = NodeChildProcess.execFileSync(
        `${systemRoot}\\System32\\reg.exe`,
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
        { encoding: "utf8", windowsHide: true, timeout: 3_000 },
      );
      return parseWindowsInternetSettings(text);
    }
    if (platform === "darwin") {
      const text = NodeChildProcess.execFileSync("/usr/sbin/scutil", ["--proxy"], {
        encoding: "utf8",
        timeout: 3_000,
      });
      return parseMacScutilProxy(text);
    }
    return LINUX;
  } catch {
    return UNAVAILABLE;
  }
}

export function readSystemProxy(
  platform: NodeJS.Platform = HostProcess.Platform.defaultValue(),
  force = false,
): SystemProxyRead {
  const now = Date.now();
  if (!force && cached && now - cached.at < 2_000) return cached.value;
  const value = readUncached(platform);
  cached = { at: now, value };
  return value;
}
