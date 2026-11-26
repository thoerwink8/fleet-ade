// @effect-diagnostics nodeBuiltinImport:off - The probe is a hidden, bounded child process in effect-free helpers.
// Effect-free so the service launcher shares the pre-lock owner identity check with server startup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const windowsStartTimeCommand = (pid: number) => ({
  command: "powershell.exe",
  args: [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
  ],
});

const probeWallClockText = (
  pid: number,
  platform: NodeJS.Platform,
): Promise<string | undefined> => {
  const windows = platform === "win32";
  const { command, args } = windows
    ? windowsStartTimeCommand(pid)
    : { command: "ps", args: ["-p", String(pid), "-o", "lstart="] };
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  NodeChildProcess.execFile(
    command,
    args,
    {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 2_000,
      maxBuffer: 16_384,
      windowsHide: true,
    },
    (error, stdout) => {
      if (error !== null) {
        resolve(undefined);
        return;
      }
      const trimmed = stdout.trim();
      resolve(trimmed.length > 0 ? trimmed : undefined);
    },
  );
  return promise;
};

/**
 * The kernel starttime (clock ticks since boot, raw) of `pid` from `/proc/<pid>/stat`
 * field 22, or undefined when unreadable. Ticks compare within one boot of one machine,
 * which is exactly what process-identity records need.
 */
const linuxStartTick = (pid: number): Promise<string | undefined> =>
  NodeFS.promises.readFile(`/proc/${pid}/stat`, "utf8").then(
    (contents) => {
      // Field 2 (comm) may contain spaces and parentheses; everything after the last ")" is
      // space-separated positional fields, where the starttime is the 20th token.
      const tick = contents.slice(contents.lastIndexOf(")") + 2).split(" ")[19];
      return tick !== undefined && /^\d+$/.test(tick) ? tick : undefined;
    },
    () => undefined,
  );

// This process's start never changes while it lives, so its identity is captured once instead
// of shelling out on every verification — a PowerShell spawn costs hundreds of milliseconds.
const selfIdentity = new Map<NodeJS.Platform, Promise<string | undefined>>();
const selfIdentityFor = (platform: NodeJS.Platform): Promise<string | undefined> => {
  const cached = selfIdentity.get(platform);
  if (cached !== undefined) return cached;
  const probed =
    platform === "linux"
      ? linuxStartTick(process.pid)
      : platform === "win32"
        ? probeWallClockText(process.pid, platform)
        : Promise.resolve(undefined);
  selfIdentity.set(platform, probed);
  return probed;
};

/**
 * The process generation behind a PID, or undefined when the probe cannot answer at generation
 * precision. Exact string equality (same probe, same machine) proves the process never changed:
 * Windows sub-second creation, Linux the kernel start tick. Whole-second platforms (`ps lstart`)
 * report undefined rather than a collidable answer; undefined is not proof of reuse.
 */
export const processIdentity = (
  pid: number,
  platform: NodeJS.Platform,
): Promise<string | undefined> => {
  if (pid === process.pid) return selfIdentityFor(platform);
  if (platform === "linux") return linuxStartTick(pid);
  if (platform !== "win32") return Promise.resolve(undefined);
  return probeWallClockText(pid, platform);
};

/**
 * The process start time in milliseconds since the epoch, or undefined when the probe fails or
 * its output cannot be parsed. Retained for the service-selection lease, which compares start
 * times across process generations; identity comparisons must use `processIdentity` instead —
 * this wall-clock answer cannot distinguish same-second generations on POSIX.
 */
export const probeProcessStartTime = (
  pid: number,
  platform: NodeJS.Platform,
): Promise<number | undefined> =>
  probeWallClockText(pid, platform).then((text) => {
    if (text === undefined) return undefined;
    const parsed = Date.parse(platform === "win32" ? text : `${text} UTC`);
    return Number.isFinite(parsed) ? parsed : undefined;
  });
