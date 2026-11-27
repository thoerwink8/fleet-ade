import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";

/** Windows open-file locks block renames; the same codes can mean permanent denial, so bound retries. */
const isWindowsRenameLock = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

// Saves keep the replaced file's mode and create new files owner-only; chmod, since the umask narrows an open mode.
const replacedMode = (fs: FileSystem.FileSystem, targetPath: string) =>
  fs.stat(targetPath).pipe(
    Effect.map((info) => info.mode & 0o777),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(0o600),
    ),
  );

// Bound denial delays to about two seconds because settings saves hold their write lock.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";
const CHUNK_WRITE_LENGTH = 1 << 20;

type WriteFileContents = string | Uint8Array | Iterable<string>;

const writeContents = Effect.fn("atomicWrite.writeContents")(function* (
  file: FileSystem.File,
  contents: WriteFileContents,
) {
  if (contents instanceof Uint8Array) {
    yield* file.writeAll(contents);
    return;
  }
  const encoder = new TextEncoder();
  if (typeof contents === "string") {
    yield* file.writeAll(encoder.encode(contents));
    return;
  }
  let batch: string[] = [];
  let batchLength = 0;
  for (const chunk of contents) {
    batch.push(chunk);
    batchLength += chunk.length;
    if (batchLength < CHUNK_WRITE_LENGTH) continue;
    yield* file.writeAll(encoder.encode(batch.join("")));
    batch = [];
    batchLength = 0;
  }
  if (batchLength > 0) yield* file.writeAll(encoder.encode(batch.join("")));
});

// A directory sync failure after creation must not fail a write whose bytes are already
// durable; the warning keeps the durability doubt visible. Windows cannot open a
// directory to sync it, and some filesystems answer ENOTSUP, EINVAL or ENOSYS.
const syncDirectory = (fs: FileSystem.FileSystem, directory: string) =>
  fs.open(directory, { flag: "r" }).pipe(
    Effect.flatMap((dir) => dir.sync),
    Effect.scoped,
    Effect.matchEffect({
      onFailure: (error) => Effect.logWarning(error),
      onSuccess: () => Effect.void,
    }),
  );

/**
 * Rewrites the file at its existing directory entry, so owner, group, mode and hard
 * links survive the write and a read-only file still refuses it. Not atomic: a crash
 * mid-write can leave partial contents, so use only where the entry's identity is part
 * of the contract, such as service configuration. Still synced before closing.
 */
export const writeFileStringInPlace = (input: {
  readonly filePath: string;
  readonly contents: WriteFileContents;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const targetDirectory = path.dirname(input.filePath);
      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      // Write-only access, since a service drop-in may be write-only for its owner:
      // "w" truncates and creates, unlike "r+" which demands read access it never uses.
      const file = yield* fs.open(input.filePath, { flag: "w" });
      yield* writeContents(file, input.contents);
      // The scope closes the handle after the sync. The directory sync is unconditional:
      // checking existence first would miss the entry being recreated after the check.
      yield* file.sync;
      if (platform !== "win32") {
        yield* syncDirectory(fs, targetDirectory);
      }
    }),
  );

/** Resolves symlink targets before renaming so writes preserve the link. Iterable contents stream in bounded batches. */
export const writeFileStringAtomically = <E = never>(input: {
  readonly filePath: string;
  readonly contents: WriteFileContents;
  // Runs after the temp file is durable and before every rename attempt, so a
  // publisher can veto the release it is about to make visible.
  readonly beforePublish?: Effect.Effect<void, E>;
  // "follow" (default) writes through a symlink so the link survives; "replace" swaps
  // the directory entry itself, for paths the writer owns, such as a service unit.
  readonly symlink?: "follow" | "replace";
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const targetPath =
        input.symlink === "replace"
          ? path.resolve(input.filePath)
          : yield* resolveSymlinkTarget(input.filePath);
      const targetDirectory = path.dirname(targetPath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      // Cleanup failure must not fail a write that already landed. The prefix stays fixed:
      // carrying the file name into it overflows the 255-byte entry limit for long names.
      const tempDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({
          directory: targetDirectory,
          prefix: "t3-write-",
        }),
        (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.ignore({ log: true })),
      );
      const tempPath = path.join(tempDirectory, "contents.tmp");

      // The sync before the rename keeps a crash right after it from leaving the target empty.
      // Closed before the rename, which Windows refuses for open files.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(tempPath, { flag: "w" });
          yield* writeContents(file, input.contents);
          if (platform !== "win32") {
            yield* fs.chmod(tempPath, yield* replacedMode(fs, targetPath));
          }
          yield* file.sync;
        }),
      );
      if (platform !== "win32") {
        yield* input.beforePublish ?? Effect.void;
        yield* fs.rename(tempPath, targetPath);
        // The rename published the write and cannot be unpublished, so a directory
        // sync failure must not surface as a failed write; the warning keeps the
        // durability doubt visible. Windows cannot open a directory to sync it, and
        // a filesystem without directory sync answers ENOTSUP, EINVAL or ENOSYS.
        return yield* syncDirectory(fs, targetDirectory);
      }

      // Stop retrying if another save changes the target; read-only targets also return permanent EPERM.
      const targetVersion = fs.stat(targetPath).pipe(
        Effect.map((info) => ({
          id: `${Option.getOrUndefined(info.ino)}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`,
          readOnly: (info.mode & 0o200) === 0,
        })),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed({ id: "missing", readOnly: false }),
        ),
        Effect.option,
      );
      const before = yield* targetVersion;
      // The veto runs before every attempt; only rename failures retry, so a
      // failing veto surfaces immediately instead of looping for two seconds.
      const attemptPublish = Effect.fn("atomicWrite.attemptPublish")(function* () {
        yield* input.beforePublish ?? Effect.void;
        return yield* Effect.result(fs.rename(tempPath, targetPath));
      });
      const firstAttempt = yield* attemptPublish();
      if (Result.isSuccess(firstAttempt)) return;
      const lockError = firstAttempt.failure;
      if (!isWindowsRenameLock(lockError) || Option.isNone(before) || before.value.readOnly) {
        return yield* lockError;
      }
      for (let retry = 0; retry < LOCKED_RENAME_RETRIES; retry += 1) {
        yield* Effect.sleep(LOCKED_RENAME_RETRY_DELAY);
        const current = yield* targetVersion;
        if (Option.isNone(current) || current.value.id !== before.value.id) break;
        const attempt = yield* attemptPublish();
        if (Result.isSuccess(attempt)) return;
        if (!isWindowsRenameLock(attempt.failure)) return yield* attempt.failure;
      }
      return yield* lockError;
    }),
  );
