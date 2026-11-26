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
 * The raw process start time exactly as the probe reports it, or undefined when the probe fails
 * or its output is empty. Records store this verbatim: writer and verifier run the same probe on
 * the same machine, so exact string equality proves the process behind a PID never changed —
 * no wall-clock comparison, no tolerance. Undefined is not proof of reuse: callers decide.
 */
export const processIdentity = (
  pid: number,
  platform: NodeJS.Platform,
): Promise<string | undefined> => {
  const { command, args, env } = legacyOwnerStartTimeCommand(pid, platform);
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
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
      resolve(trimmed.length > 0 ? trimmed : undefined);
    },
  );
  return promise;
};

/**
 * The process start time in milliseconds since the epoch, or undefined when the probe fails or
 * its output cannot be parsed. Retained for the service-selection lease, which compares start
 * times across process generations; identity comparisons should use `processIdentity` instead.
 */
export const probeProcessStartTime = (
  pid: number,
  platform: NodeJS.Platform,
): Promise<number | undefined> =>
  processIdentity(pid, platform).then((identity) => {
    if (identity === undefined) return undefined;
    const parsed = Date.parse(platform === "win32" ? identity : `${identity} UTC`);
    return Number.isFinite(parsed) ? parsed : undefined;
  });
