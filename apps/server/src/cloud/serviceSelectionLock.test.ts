// @effect-diagnostics-next-line nodeBuiltinImport:off -- Lease tests spawn real child processes.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Lease tests inject shaped filesystem failures.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import { acquireServiceSelectionLock } from "./serviceSelectionLock.ts";

/** The boot epoch leases carry, read out of a real acquisition instead of recomputed. */
const probeBootEpoch = async (selectionPath: string, lock: string): Promise<string> => {
  const release = await acquireServiceSelectionLock(selectionPath);
  const ownerFile = NodeFS.readdirSync(lock)[0] ?? "";
  release();
  return ownerFile.split(".")[1] ?? "0";
};

const errnoException = (code: string, syscall: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: injected ${syscall} failure`), { code, syscall });

/** Fake time that expires the 30s acquisition deadline on the 30th iteration. */
const expiringNow = () => {
  let calls = 0;
  return {
    now: () => (++calls === 1 ? 1_000_000 : 1_000_000 + (calls - 1) * 1_001),
    calls: () => calls,
  };
};

it.layer(NodeServices.layer)("service selection lock", (it) => {
  it.effect("reclaims a lease from an earlier boot even when its PID is live again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-selection-lock-" });
      const selectionPath = path.join(root, "service-state.json");
      const lock = `${selectionPath}.selection-lock`;
      const stale = `${process.pid}.1.00000000-0000-4000-8000-000000000000`;
      yield* fs.makeDirectory(lock, { recursive: true });
      yield* fs.writeFileString(path.join(lock, stale), "");

      const release = yield* Effect.promise(() => acquireServiceSelectionLock(selectionPath));
      const owners = yield* fs.readDirectory(lock);
      assert.equal(owners.length, 1);
      assert.notEqual(owners[0], stale);
      assert.isTrue(owners[0]!.startsWith(`${process.pid}.`));
      release();
      assert.isFalse(yield* fs.exists(lock));
    }),
  );

  it.effect("times its acquisition deadline with the monotonic clock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-selection-lock-" });
      const selectionPath = path.join(root, "service-state.json");

      let samples = 0;
      // Uncontended acquisition is synchronous inside one macrotask, so only the lock's
      // own deadline sampling can call the spied clock in this window.
      const spy = vi.spyOn(performance, "now").mockImplementation(() => {
        samples += 1;
        return 1;
      });
      let release: (() => void) | undefined;
      try {
        release = yield* Effect.promise(() => acquireServiceSelectionLock(selectionPath));
      } finally {
        spy.mockRestore();
      }
      assert.isAtLeast(samples, 1);
      release();
    }),
  );

  it.effect("fails a persistently contended acquisition once its 30 second budget is spent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-selection-lock-" });
      const selectionPath = path.join(root, "service-state.json");

      // Time passes only inside the waits: 600 rename/50ms cycles spend the whole budget.
      let time = 1_000_000;
      const delays: number[] = [];
      const renameTimes: number[] = [];
      const outcome = yield* Effect.promise(() =>
        acquireServiceSelectionLock(selectionPath, {
          platform: "win32",
          now: () => time,
          waitForRetry: (ms) => {
            delays.push(ms ?? 50);
            time += ms ?? 50;
            return Promise.resolve();
          },
          renameSync: (from, to) => {
            if (String(from).includes(".selection-lock.")) {
              renameTimes.push(time);
              throw errnoException("EPERM", "rename");
            }
            return NodeFS.renameSync(from, to);
          },
        }).then(
          () => "acquired" as const,
          (error: unknown) => error,
        ),
      );
      assert.instanceOf(outcome, Error);
      assert.match((outcome as Error).message, /Service selection is locked/);
      // The 50ms rhythm holds the whole way and no rename runs at or past the deadline.
      assert.equal(renameTimes.length, 600);
      assert.equal(delays.length, 600);
      assert.isTrue(delays.every((delay) => delay === 50));
      assert.equal(renameTimes[599], 1_029_950);
    }),
  );

  it.effect("never renames again once the acquisition deadline passed while waiting", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-selection-lock-" });
      const selectionPath = path.join(root, "service-state.json");
      const lock = `${selectionPath}.selection-lock`;

      // Contention strikes at 29,990ms into the budget; the lock frees just after 30,000ms.
      let time = 1_000_000;
      const delays: number[] = [];
      let renameAttempts = 0;
      const outcome = yield* Effect.promise(() =>
        acquireServiceSelectionLock(selectionPath, {
          platform: "win32",
          now: () => time,
          waitForRetry: (ms) => {
            delays.push(ms ?? 50);
            time += ms ?? 50;
            return Promise.resolve();
          },
          renameSync: (from, to) => {
            if (String(from).includes(".selection-lock.")) {
              renameAttempts += 1;
              if (renameAttempts === 1) {
                time = 1_029_990;
                throw errnoException("EPERM", "rename");
              }
            }
            return NodeFS.renameSync(from, to);
          },
        }).then(
          () => "acquired" as const,
          (error: unknown) => error,
        ),
      );
      assert.instanceOf(outcome, Error);
      assert.match((outcome as Error).message, /Service selection is locked/);
      // 10ms remained, so the wait is capped to it; waking exactly at the deadline, the
      // acquisition fails before any further rename even though the lock is now free.
      assert.deepEqual(delays, [10]);
      assert.equal(renameAttempts, 1);
      assert.isFalse(yield* fs.exists(lock));
    }),
  );

  it.effect("keeps waiting on a live lease held by a running process until the deadline", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-selection-lock-" });
      const selectionPath = path.join(root, "service-state.json");
      const lock = `${selectionPath}.selection-lock`;
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      try {
        const pid = child.pid;
        assert.isNumber(pid);
        const lease = `${pid}.${yield* Effect.promise(() => probeBootEpoch(selectionPath, lock))}.00000000-0000-4000-8000-000000000000`;
        yield* fs.makeDirectory(lock, { recursive: true });
        yield* fs.writeFileString(path.join(lock, lease), "");

        const clock = expiringNow();
        const outcome = yield* Effect.promise(() =>
          acquireServiceSelectionLock(selectionPath, {
            now: clock.now,
            waitForRetry: () => Promise.resolve(),
          }).then(
            () => "acquired" as const,
            (error: unknown) => error,
          ),
        );
        assert.instanceOf(outcome, Error);
        assert.match((outcome as Error).message, /Service selection is locked/);
        assert.isTrue(yield* fs.exists(path.join(lock, lease)));
      } finally {
        child.kill();
      }
    }),
  );

  it.effect("waits on a contended live lease until the first holder releases it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-selection-lock-" });
      const selectionPath = path.join(root, "service-state.json");
      const lock = `${selectionPath}.selection-lock`;

      const releaseFirst = yield* Effect.promise(() => acquireServiceSelectionLock(selectionPath));
      const retryStarted = Promise.withResolvers<void>();
      const retryGate = Promise.withResolvers<void>();
      let secondAcquired = false;
      const second = acquireServiceSelectionLock(selectionPath, {
        waitForRetry: () => {
          retryStarted.resolve();
          return retryGate.promise;
        },
      }).then((release) => {
        secondAcquired = true;
        return release;
      });
      yield* Effect.promise(() => retryStarted.promise);
      assert.isFalse(secondAcquired);
      releaseFirst();
      retryGate.resolve();
      const releaseSecond = yield* Effect.promise(() => second);
      assert.isTrue(secondAcquired);
      releaseSecond();
      assert.isFalse(yield* fs.exists(lock));
    }),
  );

  it.effect.each(["EPERM", "EACCES", "EBUSY"])(
    "retries a Windows rename refused with %s until it succeeds",
    (code) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-selection-lock-" });
        const selectionPath = path.join(root, "service-state.json");
        const lock = `${selectionPath}.selection-lock`;

        let renameAttempts = 0;
        const release = yield* Effect.promise(() =>
          acquireServiceSelectionLock(selectionPath, {
            platform: "win32",
            waitForRetry: () => Promise.resolve(),
            renameSync: (from, to) => {
              if (String(from).includes(".selection-lock.") && ++renameAttempts <= 2) {
                throw errnoException(code, "rename");
              }
              return NodeFS.renameSync(from, to);
            },
          }),
        );
        assert.isAtLeast(renameAttempts, 3);
        assert.equal((yield* fs.readDirectory(lock)).length, 1);
        release();
        assert.isFalse(yield* fs.exists(lock));
      }),
  );

  it.effect("does not retry Windows file operations failing with other error codes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-selection-lock-" });
      const selectionPath = path.join(root, "service-state.json");

      let renameAttempts = 0;
      const outcome = yield* Effect.promise(() =>
        acquireServiceSelectionLock(selectionPath, {
          platform: "win32",
          waitForRetry: () => Promise.resolve(),
          renameSync: (from, to) => {
            if (String(from).includes(".selection-lock.")) {
              renameAttempts += 1;
              throw errnoException("EIO", "rename");
            }
            return NodeFS.renameSync(from, to);
          },
        }).then(
          () => "acquired" as const,
          (error: unknown) => error,
        ),
      );
      assert.equal((outcome as NodeJS.ErrnoException)?.code, "EIO");
      assert.equal(renameAttempts, 1);
    }),
  );

  it.effect("retries removing a Windows lock directory busy with open handles", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-selection-lock-" });
      const selectionPath = path.join(root, "service-state.json");
      const lock = `${selectionPath}.selection-lock`;
      const stale = `${process.pid}.1.00000000-0000-4000-8000-000000000000`;
      yield* fs.makeDirectory(lock, { recursive: true });
      yield* fs.writeFileString(path.join(lock, stale), "");

      let renameAttempts = 0;
      let rmdirAttempts = 0;
      let busy = true;
      const release = yield* Effect.promise(() =>
        acquireServiceSelectionLock(selectionPath, {
          platform: "win32",
          waitForRetry: () => Promise.resolve(),
          renameSync: (from, to) => {
            if (String(from).includes(".selection-lock.") && ++renameAttempts <= 2) {
              throw errnoException("EEXIST", "rename");
            }
            return NodeFS.renameSync(from, to);
          },
          rmdirSync: (target) => {
            if (String(target) === lock) {
              rmdirAttempts += 1;
              if (busy) {
                busy = false;
                throw errnoException("EBUSY", "rmdir");
              }
            }
            return NodeFS.rmdirSync(target);
          },
        }),
      );
      assert.isAtLeast(rmdirAttempts, 2);
      assert.isFalse(yield* fs.exists(path.join(lock, stale)));
      release();
      assert.isFalse(yield* fs.exists(lock));
    }),
  );
});
