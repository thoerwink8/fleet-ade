import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import { writeFileStringAtomically, writeFileStringInPlace } from "./atomicWrite.ts";
import * as HostProcess from "./HostProcess.ts";
import { synchronousFileSystem } from "./testing/syncFileSystem.ts";

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  it.effect.each(HostProcess.Platform.defaultValue() === "linux" ? [39, 40, 41] : [])(
    "matches native file access for a chain of %i symlinks",
    (hops) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
        const destination = path.join(root, "settings.json");
        const first = path.join(root, "link-0");
        yield* fs.writeFileString(destination, "before");
        for (let index = hops - 1; index >= 0; index--) {
          const target = index === hops - 1 ? "settings.json" : `link-${index + 1}`;
          yield* fs.symlink(target, path.join(root, `link-${index}`));
        }

        const read = yield* Effect.exit(fs.readFileString(first));
        const write = yield* Effect.exit(
          writeFileStringAtomically({ filePath: first, contents: "after" }),
        );

        assert.strictEqual(Exit.isSuccess(read), hops <= 40);
        assert.strictEqual(Exit.isSuccess(write), Exit.isSuccess(read));
        assert.strictEqual(
          yield* fs.readFileString(destination),
          Exit.isSuccess(read) ? "after" : "before",
        );
        assert.strictEqual(yield* fs.readLink(first), "link-1");
      }),
  );

  it.effect("streams iterable contents across write batches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "cache.json");
      yield* fs.writeFileString(filePath, "a much longer previous document");
      const chunks = ["é".repeat(700_000), "🙂".repeat(400_000), "end"];

      yield* writeFileStringAtomically({ filePath, contents: chunks.values() });

      assert.strictEqual(yield* fs.readFileString(filePath), chunks.join(""));
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["cache.json"]);
    }),
  );

  it.effect("writes Uint8Array contents byte for byte", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "task.xml");
      const bytes = new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x3f, 0x00, 0x00, 0xff]);

      yield* writeFileStringAtomically({ filePath, contents: bytes });

      assert.deepStrictEqual(Array.from(yield* fs.readFile(filePath)), Array.from(bytes));
    }),
  );

  it.effect("replaces the symlink itself when the writer owns the link path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "separate.service");
      const link = path.join(root, "managed.service");
      yield* fs.writeFileString(destination, "separate definition");
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "updated", symlink: "replace" });

      assert.strictEqual(yield* fs.readFileString(destination), "separate definition");
      assert.strictEqual(yield* fs.readFileString(link), "updated");
      assert.strictEqual(Exit.isFailure(yield* Effect.exit(fs.readLink(link))), true);
    }),
  );

  it.effect.each(HostProcess.Platform.defaultValue() === "linux" ? [255] : [])(
    "saves a file whose name is %i bytes long",
    (length) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
        const filePath = path.join(root, `${"s".repeat(length - 5)}.json`);

        yield* writeFileStringAtomically({ filePath, contents: "after" });

        assert.strictEqual(yield* fs.readFileString(filePath), "after");
      }),
  );

  it.effect("syncs the written contents before the rename and the directory after it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      const events: Array<string> = [];
      const recording = FileSystem.make({
        ...fs,
        open: (openedPath, options) =>
          fs.open(openedPath, options).pipe(
            // The real handle keeps its methods on its prototype, so it is extended, not spread.
            Effect.map((file): FileSystem.File =>
              Object.create(file, {
                writeAll: {
                  value: (buffer: Uint8Array) =>
                    file.writeAll(buffer).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          events.push("write temp file");
                        }),
                      ),
                    ),
                },
                sync: {
                  value: file.sync.pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        events.push(openedPath === root ? "sync directory" : "sync temp file");
                      }),
                    ),
                  ),
                },
              }),
            ),
          ),
        rename: (from, to) =>
          fs.rename(from, to).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                events.push("rename");
              }),
            ),
          ),
      });

      yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, recording),
      );

      assert.strictEqual(yield* fs.readFileString(filePath), "after");
      // Windows cannot open a directory to sync it, so that sync is skipped there.
      assert.deepStrictEqual(
        events,
        HostProcess.Platform.defaultValue() === "win32"
          ? ["write temp file", "sync temp file", "rename"]
          : ["write temp file", "sync temp file", "rename", "sync directory"],
      );
    }),
  );

  // ENOTSUP means this filesystem cannot sync directories at all; EIO means the rename may
  // not survive a crash. Either way the rename already published the write, so the caller
  // must not be told the write failed.
  it.effect.each(HostProcess.Platform.defaultValue() === "win32" ? [] : ["ENOTSUP", "EIO"])(
    "a published write still succeeds when directory sync fails with $code after the rename",
    (code) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
        const filePath = path.join(root, "settings.json");
        const syncFailure = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "sync",
          pathOrDescriptor: root,
          cause: Object.assign(new Error(`${code}, fsync`), { code }),
        });
        const failingDirectorySync = FileSystem.make({
          ...fs,
          open: (openedPath, options) =>
            fs
              .open(openedPath, options)
              .pipe(
                Effect.map((file): FileSystem.File =>
                  openedPath === root
                    ? Object.create(file, { sync: { value: Effect.fail(syncFailure) } })
                    : file,
                ),
              ),
        });

        const exit = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
          Effect.provideService(FileSystem.FileSystem, failingDirectorySync),
          Effect.exit,
        );

        assert.deepStrictEqual(exit, Exit.void);
        assert.strictEqual(yield* fs.readFileString(filePath), "after");
      }),
  );

  // Read-only and unreadable targets still save, since the mode lands after the temp file opens.
  // Windows reports modes that ignore the write bit, so these checks are POSIX-only.
  it.effect.each(HostProcess.Platform.defaultValue() === "win32" ? [] : ["644", "444", "000"])(
    "keeps the %s permissions of the file it replaces",
    (octal) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
        const filePath = path.join(root, "settings.json");
        const mode = Number.parseInt(octal, 8);
        yield* fs.writeFileString(filePath, "before");
        yield* fs.chmod(filePath, mode);

        yield* writeFileStringAtomically({ filePath, contents: "after" });

        assert.strictEqual((yield* fs.stat(filePath)).mode & 0o777, mode);
        yield* fs.chmod(filePath, 0o600);
        assert.strictEqual(yield* fs.readFileString(filePath), "after");
      }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "creates a new file readable only by its owner",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
        const filePath = path.join(root, "settings.json");

        yield* writeFileStringAtomically({ filePath, contents: "fresh" });

        assert.strictEqual(((yield* fs.stat(filePath)).mode & 0o777).toString(8), "600");
      }),
  );

  // Root ignores the missing read bit, so only a regular user sees the failure.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "saves when the umask removes owner read access",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
        const filePath = path.join(root, "settings.json");
        yield* fs.writeFileString(filePath, "before");
        yield* fs.chmod(filePath, 0o600);
        yield* Effect.acquireRelease(
          Effect.sync(() => process.umask(0o400)),
          (previous) => Effect.sync(() => process.umask(previous)),
        );

        yield* writeFileStringAtomically({ filePath, contents: "after" });

        assert.strictEqual(yield* fs.readFileString(filePath), "after");
        assert.strictEqual((yield* fs.stat(filePath)).mode & 0o777, 0o600);
      }),
  );

  it.effect("keeps a symlinked file linked and rewrites its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );

  it.effect("keeps a dangling symlink linked and creates its destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "settings.json");
      const link = path.join(root, "home", "settings.json");
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.symlink(destination, link);

      yield* writeFileStringAtomically({ filePath: link, contents: "fresh" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "fresh");
    }),
  );

  it.effect("fails on a symlink cycle without replacing either link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const first = path.join(root, "first.json");
      const second = path.join(root, "second.json");
      yield* fs.symlink(second, first);
      yield* fs.symlink(first, second);

      const result = yield* Effect.exit(
        writeFileStringAtomically({ filePath: first, contents: "after" }),
      );

      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(yield* fs.readLink(first), second);
      assert.strictEqual(yield* fs.readLink(second), first);
    }),
  );

  it.effect("resolves a relative link through a symlinked parent directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const destination = path.join(root, "dotfiles", "config", "settings.json");
      const linkedState = path.join(root, "dotfiles", "state");
      const home = path.join(root, "home");
      const link = path.join(home, "state", "settings.json");
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.makeDirectory(linkedState, { recursive: true });
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.symlink(linkedState, path.join(home, "state"));
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink("../config/settings.json", link);

      yield* writeFileStringAtomically({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), "../config/settings.json");
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );

  it.effect("does not replace a newer save that landed while the lock was held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const lockedOnce = FileSystem.make({
        ...fs,
        rename: (from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(renameError("EBUSY", to))),
                )
              : fs.rename(from, to);
          }),
      });

      const stale = yield* writeFileStringAtomically({ filePath, contents: "stale" }).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedOnce),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);
      yield* writeFileStringAtomically({ filePath, contents: "newer" });

      yield* TestClock.adjust("100 millis");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(stale)));
      assert.strictEqual(yield* fs.readFileString(filePath), "newer");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );
});

it.layer(NodeServices.layer)("writeFileStringInPlace", (it) => {
  it.effect("rewrites the same directory entry, preserving hard links", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-in-place-write-" });
      const filePath = path.join(root, "service.env");
      const linkPath = path.join(root, "service.env.alias");
      yield* fs.writeFileString(filePath, "before");
      yield* fs.link(filePath, linkPath);

      yield* writeFileStringInPlace({ filePath, contents: "after" });

      assert.strictEqual(yield* fs.readFileString(filePath), "after");
      assert.strictEqual(yield* fs.readFileString(linkPath), "after");
    }),
  );

  it.effect("truncates a longer previous document", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-in-place-write-" });
      const filePath = path.join(root, "service.env");
      yield* fs.writeFileString(filePath, "a much longer previous document");

      yield* writeFileStringInPlace({ filePath, contents: "short" });

      assert.strictEqual(yield* fs.readFileString(filePath), "short");
    }),
  );

  it.effect("writes Uint8Array contents byte for byte", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-in-place-write-" });
      const filePath = path.join(root, "bytes.bin");
      const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x3c]);

      yield* writeFileStringInPlace({ filePath, contents: bytes });

      assert.deepStrictEqual(Array.from(yield* fs.readFile(filePath)), Array.from(bytes));
    }),
  );

  it.effect("syncs the written contents before the close", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-in-place-write-" });
      const filePath = path.join(root, "service.env");
      yield* fs.writeFileString(filePath, "before");
      const events: Array<string> = [];
      const recording = FileSystem.make({
        ...fs,
        open: (openedPath, options) =>
          fs.open(openedPath, options).pipe(
            Effect.map((file): FileSystem.File =>
              openedPath === filePath
                ? Object.create(file, {
                    writeAll: {
                      value: (buffer: Uint8Array) =>
                        file.writeAll(buffer).pipe(
                          Effect.tap(() =>
                            Effect.sync(() => {
                              events.push("write file");
                            }),
                          ),
                        ),
                    },
                    sync: {
                      value: file.sync.pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            events.push("sync file");
                          }),
                        ),
                      ),
                    },
                  })
                : file,
            ),
          ),
      });

      yield* writeFileStringInPlace({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, recording),
      );

      assert.strictEqual(yield* fs.readFileString(filePath), "after");
      assert.deepStrictEqual(events, ["write file", "sync file"]);
    }),
  );

  // The entry can vanish between the writer's creation check and its open, which is
  // exactly what the user drop-in's undo entry does. A recreated entry is new, so the
  // directory must be synced even though the file existed when the write began.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "syncs the directory when the entry is recreated mid-write",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-in-place-write-" });
        const filePath = path.join(root, "90-t3code-protect.conf");
        yield* fs.writeFileString(filePath, "before");
        const events: Array<string> = [];
        let unlinked = false;
        const recording = FileSystem.make({
          ...fs,
          open: (openedPath, options) => {
            const recreate =
              openedPath === filePath && !unlinked
                ? fs.remove(filePath).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        unlinked = true;
                      }),
                    ),
                  )
                : Effect.void;
            return recreate.pipe(
              Effect.andThen(fs.open(openedPath, options)),
              Effect.map((file): FileSystem.File =>
                Object.create(file, {
                  sync: {
                    value: file.sync.pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          events.push(openedPath === filePath ? "sync file" : "sync directory");
                        }),
                      ),
                    ),
                  },
                }),
              ),
            );
          },
        });

        yield* writeFileStringInPlace({ filePath, contents: "after" }).pipe(
          Effect.provideService(FileSystem.FileSystem, recording),
        );

        assert.strictEqual(yield* fs.readFileString(filePath), "after");
        assert.deepStrictEqual(events, ["sync file", "sync directory"]);
      }),
  );

  it.effect("writes through a symlink instead of replacing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-in-place-write-" });
      const destination = path.join(root, "real.env");
      const link = path.join(root, "linked.env");
      yield* fs.writeFileString(destination, "before");
      yield* fs.symlink(destination, link);

      yield* writeFileStringInPlace({ filePath: link, contents: "after" });

      assert.strictEqual(yield* fs.readLink(link), destination);
      assert.strictEqual(yield* fs.readFileString(destination), "after");
    }),
  );
  // Root ignores the missing read bit, so only a regular user exercises the write-only open.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "updates a write-only file without read access, keeping its mode",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-in-place-write-" });
        const filePath = path.join(root, "90-t3code-protect.conf");
        yield* fs.writeFileString(filePath, "MemoryLow=1G\n");
        yield* fs.chmod(filePath, 0o200);
        const before = yield* fs.stat(filePath);

        yield* writeFileStringInPlace({ filePath, contents: "MemoryLow=2G\n" });

        const after = yield* fs.stat(filePath);
        assert.strictEqual(Option.getOrNull(after.ino), Option.getOrNull(before.ino));
        assert.strictEqual(after.mode & 0o777, 0o200);
        yield* fs.chmod(filePath, 0o600);
        assert.strictEqual(yield* fs.readFileString(filePath), "MemoryLow=2G\n");
      }),
  );
});

// stat and rename are the only filesystem operations the retry loop performs. Wrapping
// them in synchronous node calls keeps each retry round inside the task the TestClock
// wake resumes, so one adjustment drains the chain deterministically.
it.effect("retries a locked rename until the lock clears", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
    const filePath = path.join(root, "settings.json");
    yield* fs.writeFileString(filePath, "before");
    const syncFs = synchronousFileSystem(fs);
    const firstAttempt = yield* Deferred.make<void>();
    let attempts = 0;
    const lockedTwice: FileSystem.FileSystem = {
      ...syncFs,
      rename: (from, to) =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts <= 2
            ? (attempts === 1 ? Deferred.succeed(firstAttempt, undefined) : Effect.void).pipe(
                Effect.andThen(Effect.fail(renameError("EPERM", to))),
              )
            : syncFs.rename(from, to);
        }),
    };

    const write = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
      Effect.provideService(FileSystem.FileSystem, lockedTwice),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.exit,
      Effect.forkChild,
    );
    yield* Deferred.await(firstAttempt);
    yield* TestClock.adjust("500 millis");

    assert.deepStrictEqual(yield* Fiber.join(write), Exit.void);
    assert.strictEqual(attempts, 3);
    assert.strictEqual(yield* fs.readFileString(filePath), "after");
    assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails after the retries run out and removes its temp file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
    const filePath = path.join(root, "settings.json");
    yield* fs.writeFileString(filePath, "before");
    const syncFs = synchronousFileSystem(fs);
    const firstAttempt = yield* Deferred.make<void>();
    let attempts = 0;
    const alwaysLocked: FileSystem.FileSystem = {
      ...syncFs,
      rename: (_from, to) =>
        Effect.suspend(() => {
          attempts += 1;
          return (attempts === 1 ? Deferred.succeed(firstAttempt, undefined) : Effect.void).pipe(
            Effect.andThen(Effect.fail(renameError("EBUSY", to))),
          );
        }),
    };

    const write = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
      Effect.provideService(FileSystem.FileSystem, alwaysLocked),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.exit,
      Effect.forkChild,
    );
    yield* Deferred.await(firstAttempt);
    // One first try plus twenty retries at a hundred milliseconds each.
    yield* TestClock.adjust("2100 millis");

    const exit = yield* Fiber.join(write);
    assert.isTrue(Exit.isFailure(exit));
    assert.strictEqual(attempts, 21);
    assert.strictEqual(yield* fs.readFileString(filePath), "before");
    assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const renameError = (code: string, path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
    cause: Object.assign(new Error(`${code}, rename`), { code }),
  });

it.effect("surfaces an unreadable link instead of writing over it", () =>
  Effect.gen(function* () {
    const readLinkFailure = PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readLink",
      pathOrDescriptor: "/home/settings.json",
    });

    const failure = yield* writeFileStringAtomically({
      filePath: "/home/settings.json",
      contents: "after",
    }).pipe(Effect.flip);

    assert.deepStrictEqual(failure, readLinkFailure);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Path.layer,
        FileSystem.layerNoop({
          readLink: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "readLink",
                pathOrDescriptor: "/home/settings.json",
              }),
            ),
          rename: () => Effect.die("an unreadable link must not be replaced"),
        }),
      ),
    ),
  ),
);

it.effect("succeeds when the write lands but its temp directory cannot be removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
    const filePath = path.join(root, "settings.json");
    const removeAttempts: Array<string> = [];
    const unremovable = FileSystem.make({
      ...fs,
      remove: (removedPath) =>
        Effect.suspend(() => {
          removeAttempts.push(removedPath);
          return Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "remove",
              pathOrDescriptor: removedPath,
            }),
          );
        }),
    });

    yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
      Effect.provideService(FileSystem.FileSystem, unremovable),
    );

    assert.strictEqual(yield* fs.readFileString(filePath), "after");
    assert.strictEqual(removeAttempts.length, 1);
    assert.deepStrictEqual(
      (yield* fs.readDirectory(root)).toSorted(),
      [path.basename(removeAttempts[0]!), "settings.json"].toSorted(),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
