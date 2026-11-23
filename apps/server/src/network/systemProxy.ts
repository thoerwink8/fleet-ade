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

let cached: SystemProxyRead = UNAVAILABLE;
let lastRefreshAt = 0;
let pendingRefresh: Promise<SystemProxyRead> | undefined;
const REFRESH_INTERVAL_MS = 2_000;

function readUncached(platform: NodeJS.Platform): Promise<SystemProxyRead> {
  if (platform !== "win32" && platform !== "darwin") return Promise.resolve(LINUX);

  const { promise, resolve } = Promise.withResolvers<SystemProxyRead>();
  try {
    if (platform === "win32") {
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      NodeChildProcess.execFile(
        `${systemRoot}\\System32\\reg.exe`,
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
        { encoding: "utf8", windowsHide: true, timeout: 3_000 },
        (error, stdout) => resolve(error ? UNAVAILABLE : parseWindowsInternetSettings(stdout)),
      );
    } else {
      NodeChildProcess.execFile(
        "/usr/sbin/scutil",
        ["--proxy"],
        { encoding: "utf8", timeout: 3_000 },
        (error, stdout) => resolve(error ? UNAVAILABLE : parseMacScutilProxy(stdout)),
      );
    }
  } catch {
    resolve(UNAVAILABLE);
  }
  return promise;
}

export function readSystemProxy(
  platform: NodeJS.Platform = HostProcess.Platform.defaultValue(),
): SystemProxyRead {
  return platform === "win32" || platform === "darwin" ? cached : LINUX;
}

export function refreshSystemProxy(
  platform: NodeJS.Platform = HostProcess.Platform.defaultValue(),
  force = false,
  now = Date.now(),
): Promise<SystemProxyRead> {
  if (pendingRefresh) return pendingRefresh;
  if (!force && now - lastRefreshAt < REFRESH_INTERVAL_MS) {
    return Promise.resolve(readSystemProxy(platform));
  }

  lastRefreshAt = now;
  pendingRefresh = readUncached(platform)
    .catch(() => UNAVAILABLE)
    .then((value) => {
      cached = value;
      pendingRefresh = undefined;
      return value;
    });
  void pendingRefresh.catch(() => undefined);
  return pendingRefresh;
}
