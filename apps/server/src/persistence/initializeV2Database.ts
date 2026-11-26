import * as NodeSqlite from "node:sqlite";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { probeProcessStartTime, processStartedBeforeTimestamp } from "../legacyServerOwner.ts";

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

const isV2DatabaseImportError = Schema.is(V2DatabaseImportError);

/**
 * Injectable for tests: copy creation and process start are milliseconds apart, so a fixture
 * cannot put them deterministically on opposite sides of the precision tolerance.
 */
export const ProcessStartTimeProbe = Context.Reference<
  (pid: number, platform: NodeJS.Platform) => Promise<number | undefined>
>("initializeV2Database/ProcessStartTimeProbe", {
  defaultValue: () => probeProcessStartTime,
});

/**
 * The copy survives only while the process that created it still runs. Signal 0 cannot tell a
 * reused PID apart, so compare the process start against the copy's creation time: a process
 * started after the copy was made never wrote it. An unknown start time keeps the copy.
 */
const copyOwnerIsLive = async (
  probeStartTime: (pid: number, platform: NodeJS.Platform) => Promise<number | undefined>,
  pid: number,
  copyCreatedAtMs: number,
  platform: NodeJS.Platform,
): Promise<boolean> => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) return false;
  }
  const startedAtMs = await probeStartTime(pid, platform);
  if (startedAtMs === undefined) return true;
  return processStartedBeforeTimestamp(startedAtMs, copyCreatedAtMs, platform);
};

// Legacy names have no PID; newer copies stay while their process is alive.
const removeAbandonedCopies = Effect.fn("removeAbandonedCopies")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const probeStartTime = yield* ProcessStartTimeProbe;
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );
  for (const entry of entries) {
    const copy = /^\.v2-import-(?:(\d+)-)?[A-Za-z0-9]{6}$/.exec(entry);
    if (copy === null) continue;
    const copyPath = path.join(directory, entry);
    if (copy[1] !== undefined) {
      const createdAtMs = yield* fs.stat(copyPath).pipe(
        Effect.map((info) => {
          // Filesystems without birthtime report the epoch; fall back to the last write.
          const birthtime = Option.getOrUndefined(info.birthtime)?.getTime();
          if (birthtime !== undefined && birthtime > 946684800000) return birthtime;
          return Option.getOrUndefined(info.mtime)?.getTime();
        }),
      );
      if (
        createdAtMs === undefined ||
        (yield* Effect.promise(() =>
          copyOwnerIsLive(probeStartTime, Number(copy[1]), createdAtMs, platform),
        ))
      ) {
        continue;
      }
    }
    yield* fs.remove(copyPath, { recursive: true });
  }
});

/** Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* removeAbandonedCopies(directory).pipe(Effect.ignore({ log: true }));
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: `.v2-import-${process.pid}-`,
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise({
      try: async () => {
        const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
        try {
          await NodeSqlite.backup(database, snapshotPath);
        } finally {
          database.close();
        }
      },
      catch: (cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs.link(snapshotPath, destinationPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        (_error) => Effect.void,
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      isV2DatabaseImportError(cause)
        ? cause
        : new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
    ),
  );
});
