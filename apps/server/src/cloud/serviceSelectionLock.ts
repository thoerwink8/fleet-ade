// @effect-diagnostics nodeBuiltinImport:off -- Shared with the standalone launcher, which has no Effect runtime.
// @effect-diagnostics globalTimers:off -- Bounded cross-process lease acquisition in the standalone launcher.
// @effect-diagnostics globalDate:off -- The boot epoch needs wall time; the deadline does not.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Coarse boot time: a lease from an earlier boot is dead even when its PID is live again.
const bootEpochSeconds = () => Math.round(Date.now() / 1000 - NodeOS.uptime());

export interface ServiceSelectionLockOptions {
  /** Retry delay in milliseconds, capped to the time left in the 30 second budget. */
  readonly waitForRetry?: (ms: number) => Promise<void>;
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
    options?.waitForRetry ??
    ((ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    });
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = options?.platform ?? NodeOS.platform();
  const windows = platform === "win32";
  // Monotonic: wall-clock corrections must neither extend nor cut the acquisition budget.
  const now = options?.now ?? (() => performance.now());
  const renameSync = options?.renameSync ?? NodeFS.renameSync;
  const rmdirSync = options?.rmdirSync ?? NodeFS.rmdirSync;
  const directory = NodePath.dirname(selectionPath);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = selectionPath + ".selection-lock";
  const owner = `${process.pid}.${bootEpochSeconds()}.${NodeCrypto.randomUUID()}`;
  const candidate = `${lock}.${owner}`;
  const deadline = now() + 30_000;
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
      // Checked before every rename, so a wake at or past the deadline fails instead of
      // acquiring a lock that only freed after the budget was spent.
      if (now() >= deadline)
        throw new Error(
          `Service selection is locked at ${lock}. Retry when the other operation finishes.`,
        );
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
      const remaining = deadline - now();
      if (remaining <= 0)
        throw new Error(
          `Service selection is locked at ${lock}. Retry when the other operation finishes.`,
        );
      await waitForRetry(Math.min(50, remaining));
    }
  } finally {
    NodeFS.rmSync(candidate, { recursive: true, force: true });
  }
}
