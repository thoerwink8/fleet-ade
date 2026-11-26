// @effect-diagnostics nodeBuiltinImport:off -- Shared with the standalone launcher, which has no Effect runtime.
// @effect-diagnostics globalTimers:off -- Bounded cross-process lease acquisition in the standalone launcher.
// @effect-diagnostics globalDate:off -- The standalone launcher has no Effect clock for its acquisition deadline.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  legacyOwnerStartedBeforeRecord,
  legacyOwnerStartTimeCommand,
} from "../legacyServerOwner.ts";

// Coarse boot time: a lease from an earlier boot is dead even when its PID is live again.
const bootEpochSeconds = () => Math.round(Date.now() / 1000 - NodeOS.uptime());

// Unknown identity (the probe fails or reports nothing) stays conservative: the lease is
// treated as live rather than taken from a service operation that may still hold it.
const probeProcessStartedBefore = (
  pid: number,
  recordedAt: number,
  platform: NodeJS.Platform,
): Promise<boolean> => {
  const { command, args, env } = legacyOwnerStartTimeCommand(pid, platform);
  return new Promise<boolean>((resolve) =>
    NodeChildProcess.execFile(
      command,
      args,
      { env: { ...process.env, ...env }, timeout: 2_000, maxBuffer: 16_384, windowsHide: true },
      (error, stdout) =>
        resolve(
          legacyOwnerStartedBeforeRecord(error === null ? stdout : undefined, recordedAt, platform),
        ),
    ),
  );
};

export interface ServiceSelectionLockOptions {
  /** Retry delay; acquisition is bounded by its 30s deadline, not by a retry count. */
  readonly waitForRetry?: () => Promise<void>;
  /** Drives the error classification Windows file operations need. */
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly renameSync?: typeof NodeFS.renameSync;
  readonly rmdirSync?: typeof NodeFS.rmdirSync;
}

/** Serialize durable selection and unit writes, never manager stop/start commands. */
export async function acquireServiceSelectionLock(
  selectionPath: string,
  options?: ServiceSelectionLockOptions,
): Promise<() => void> {
  const waitForRetry =
    options?.waitForRetry ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = options?.platform ?? NodeOS.platform();
  const windows = platform === "win32";
  const now = options?.now ?? (() => Date.now());
  const renameSync = options?.renameSync ?? NodeFS.renameSync;
  const rmdirSync = options?.rmdirSync ?? NodeFS.rmdirSync;
  // The probe inspects real processes, so it always uses the real platform.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const hostPlatform = NodeOS.platform();
  const ownerStartedBeforeLease = (pid: number, leaseEpochMs: number) =>
    probeProcessStartedBefore(pid, leaseEpochMs, hostPlatform);
  const directory = NodePath.dirname(selectionPath);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = selectionPath + ".selection-lock";
  const owner = `${process.pid}.${bootEpochSeconds()}.${NodeCrypto.randomUUID()}`;
  const candidate = `${lock}.${owner}`;
  const deadline = now() + 30_000;
  // One probe per owner file: a live lease is re-read every iteration, but the process
  // start time behind a PID cannot change while that same process keeps the PID.
  const startedBeforeLease = new Map<string, Promise<boolean>>();
  const ownerIsLeaseWriter = (ownerFile: string, pid: number, leaseEpochMs: number) => {
    let probe = startedBeforeLease.get(ownerFile);
    if (probe === undefined) {
      probe = ownerStartedBeforeLease(pid, leaseEpochMs);
      startedBeforeLease.set(ownerFile, probe);
    }
    return probe;
  };
  const removeEmptyLock = () => {
    try {
      rmdirSync(lock);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code) &&
        !(windows && ["EBUSY", "EPERM", "EACCES"].includes(code))
      )
        throw error;
    }
  };
  NodeFS.mkdirSync(candidate, { mode: 0o700 });
  try {
    NodeFS.writeFileSync(NodePath.join(candidate, owner), "", { mode: 0o600 });
    while (true) {
      try {
        // Publish the owner atomically; rename cannot replace another populated directory.
        renameSync(candidate, lock);
        return () => {
          NodeFS.unlinkSync(NodePath.join(lock, owner));
          removeEmptyLock();
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        // Windows MoveFileExW reports EPERM/EACCES/EBUSY when the target is held open by
        // another process or a virus scanner, even when the lock does not exist.
        const contended =
          code === "EEXIST" ||
          code === "ENOTEMPTY" ||
          (windows && (code === "EPERM" || code === "EACCES" || code === "EBUSY"));
        if (!contended) throw error;
      }
      let owners: string[] = [];
      try {
        owners = NodeFS.readdirSync(lock);
      } catch (error) {
        // A Windows rename can fail with EPERM while no lock exists; keep the deadline and delay.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (owners.length === 1) {
        const previous = owners[0]!;
        const [pidText, bootText] = previous.split(".");
        const pid = Number(pidText);
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error(`Invalid service selection lock owner at ${lock}.`);
        const ownerBoot = Number(bootText);
        const fromEarlierBoot =
          Number.isSafeInteger(ownerBoot) && Math.abs(ownerBoot - bootEpochSeconds()) > 60;
        let dead = fromEarlierBoot;
        if (!dead) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ESRCH" && code !== "EPERM") throw error;
            dead = code === "ESRCH";
          }
        }
        if (!dead) {
          // A live PID is the lease writer only when it started before the lease was
          // recorded; within one boot a newer process holding the PID never wrote it.
          let leaseEpochMs: number | undefined;
          try {
            leaseEpochMs = NodeFS.statSync(NodePath.join(lock, previous)).mtimeMs;
          } catch {
            leaseEpochMs = undefined;
          }
          if (
            leaseEpochMs !== undefined &&
            !(await ownerIsLeaseWriter(previous, pid, leaseEpochMs))
          )
            dead = true;
        }
        if (dead) {
          // Remove only this dead owner's unique file, never a replacement owner's.
          try {
            NodeFS.unlinkSync(NodePath.join(lock, previous));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      removeEmptyLock();
      if (now() >= deadline)
        throw new Error(
          `Service selection is locked at ${lock}. Retry when the other operation finishes.`,
        );
      await waitForRetry();
    }
  } finally {
    NodeFS.rmSync(candidate, { recursive: true, force: true });
  }
}
