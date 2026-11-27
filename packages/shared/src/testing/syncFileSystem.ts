// @effect-diagnostics nodeBuiltinImport:off - test-only wrapper; synchronous fs keeps retried effects on the TestClock scheduler.
import * as NodeFS from "node:fs";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

// Retried effects must stay on the TestClock scheduler, but Effect's
// filesystem answers through the libuv thread pool: wrapping stat and rename
// in synchronous node calls lets one adjustment drain a whole retry chain.

const errnoError = (method: string, path: string, err: NodeJS.ErrnoException) =>
  PlatformError.systemError({
    _tag:
      err.code === "ENOENT"
        ? "NotFound"
        : err.code === "EACCES" || err.code === "EPERM"
          ? "PermissionDenied"
          : err.code === "EEXIST"
            ? "AlreadyExists"
            : err.code === "EBUSY"
              ? "Busy"
              : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    syscall: err.syscall,
    cause: err,
  });

// Same conversion the node platform filesystem applies, reading through
// `statSync` instead of the thread pool.
const syncStat = (path: string): Effect.Effect<FileSystem.File.Info, PlatformError.PlatformError> =>
  Effect.try({
    try: (): FileSystem.File.Info => {
      const stat = NodeFS.statSync(path, { bigint: true });
      return {
        type: stat.isFile()
          ? "File"
          : stat.isDirectory()
            ? "Directory"
            : stat.isSymbolicLink()
              ? "SymbolicLink"
              : "Unknown",
        mtime: Option.fromNullishOr(stat.mtime),
        atime: Option.fromNullishOr(stat.atime),
        birthtime: Option.fromNullishOr(stat.birthtime),
        dev: BigInt.asUintN(64, stat.dev),
        ino: Option.fromNullishOr(stat.ino),
        mode: Number(stat.mode),
        nlink: Option.fromNullishOr(stat.nlink),
        uid: Option.fromNullishOr(stat.uid === undefined ? undefined : Number(stat.uid)),
        gid: Option.fromNullishOr(stat.gid === undefined ? undefined : Number(stat.gid)),
        rdev: Option.none(),
        size: ByteSize.bytes(stat.size),
        blksize:
          stat.blksize !== undefined ? Option.some(ByteSize.bytes(stat.blksize)) : Option.none(),
        blocks: Option.fromNullishOr(stat.blocks),
      };
    },
    catch: (error) => errnoError("stat", path, error as NodeJS.ErrnoException),
  });

/** Wraps the filesystem's stat and rename in synchronous node calls; override either further for failure injection. */
export const synchronousFileSystem = (fs: FileSystem.FileSystem): FileSystem.FileSystem => ({
  ...fs,
  stat: syncStat,
  rename: (from, to) =>
    Effect.try({
      try: () => {
        NodeFS.renameSync(from, to);
      },
      catch: (error) => errnoError("rename", `${from} -> ${to}`, error as NodeJS.ErrnoException),
    }),
});
