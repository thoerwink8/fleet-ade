// @effect-diagnostics nodeBuiltinImport:off - The probe is a hidden, bounded child process in effect-free helpers.
// Effect-free so the service launcher shares the pre-lock owner identity check with server startup.
import * as NodeChildProcess from "node:child_process";

const legacyOwnerStartTimeCommand = (pid: number, platform: NodeJS.Platform) => {
  const windows = platform === "win32";
  return {
    command: windows ? "powershell.exe" : "ps",
    args: windows
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ]
      : ["-p", String(pid), "-o", "lstart="],
    env: { LC_ALL: "C", TZ: "UTC" },
  };
};

/**
 * The process start time in milliseconds since the epoch, or undefined when the probe fails or
 * its output cannot be parsed. Undefined is not proof of reuse: callers decide per surface.
 */
export const probeProcessStartTime = (
  pid: number,
  platform: NodeJS.Platform,
): Promise<number | undefined> => {
  const { command, args, env } = legacyOwnerStartTimeCommand(pid, platform);
  return new Promise((resolve) =>
    NodeChildProcess.execFile(
      command,
      args,
      {
        env: { ...process.env, ...env },
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
        const parsed = Date.parse(platform === "win32" ? trimmed : `${trimmed} UTC`);
        resolve(Number.isFinite(parsed) ? parsed : undefined);
      },
    ),
  );
};

/**
 * Whether the process start is consistent with having written a record or copy at `referenceAt`.
 * Windows reports sub-second precision, so it needs only clock-jitter tolerance; POSIX `ps`
 * reports whole seconds, which cannot separate a reuse within the same second.
 */
export const processStartedBeforeTimestamp = (
  startedAtMs: number,
  referenceAtMs: number,
  platform: NodeJS.Platform,
): boolean => startedAtMs <= referenceAtMs + (platform === "win32" ? 250 : 1_000);
