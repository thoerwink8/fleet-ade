import * as NodeSqlite from "node:sqlite";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { processIdentity } from "../legacyServerOwner.ts";

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
 * Injectable for tests: the probe shells out to `ps` or PowerShell and can fail on hosts without
 * them, so cleanup distinguishes that failure from proof of PID reuse.
 */
export const ProcessIdentityProbe = Context.Reference<
  (pid: number, platform: NodeJS.Platform) => Promise<string | undefined>
>("initializeV2Database/ProcessIdentityProbe", {
  defaultValue: () => processIdentity,
});

const COPY_OWNER_FILE = "owner.json";

/**
 * Whether the copy's writer provably stopped existing. Only a dead PID or an identity mismatch
 * abandons a copy; anything unprovable keeps it. File timestamps never enter the decision: they
 * can be rolled back or truncated by the filesystem.
 */
const copyIsAbandoned = (
  probeIdentity: (pid: number, platform: NodeJS.Platform) => Promise<string | undefined>,
  pid: number,
  ownerContents: string | undefined,
  platform: NodeJS.Platform,
): Promise<boolean> => {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(true);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) {
      return Promise.resolve(true);
    }
  }
  if (ownerContents === undefined) return Promise.resolve(false);
  let owner: unknown;
  try {
    owner = JSON.parse(ownerContents);
  } catch {
    return Promise.resolve(false);
  }
  if (
    typeof owner !== "object" ||
    owner === null ||
    !("pid" in owner) ||
    owner.pid !== pid ||
    !("processIdentity" in owner) ||
    typeof owner.processIdentity !== "string"
  ) {
    return Promise.resolve(false);
  }
  return probeIdentity(pid, platform).then((liveIdentity) =>
    liveIdentity === undefined ? false : liveIdentity !== owner.processIdentity,
  );
};

// Legacy names have no PID; newer copies stay while their process may still own them.
const removeAbandonedCopies = Effect.fn("removeAbandonedCopies")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const probeIdentity = yield* ProcessIdentityProbe;
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
      const ownerContents = yield* fs
        .readFileString(path.join(copyPath, COPY_OWNER_FILE))
        .pipe(Effect.orElseSucceed(() => undefined as string | undefined));
      const abandoned = yield* Effect.promise(() =>
        copyIsAbandoned(probeIdentity, Number(copy[1]), ownerContents, platform),
      );
      if (!abandoned) continue;
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
    // Prove this copy's writer to the next start: cleanup replays the same probe for the
    // recorded PID, and only an exact identity match keeps the copy alive. When the probe
    // cannot answer, the copy is still written — on such a host nothing could verify one.
    const probeIdentity = yield* ProcessIdentityProbe;
    const platform = yield* HostProcess.Platform;
    const identity = yield* Effect.promise(() => probeIdentity(process.pid, platform));
    if (identity !== undefined) {
      yield* fs.writeFileString(
        path.join(temporaryDirectory, COPY_OWNER_FILE),
        // @effect-diagnostics-next-line globalJsonInEffect:off - fixed shape; a defect here fails the import, which is correct.
        JSON.stringify({ pid: process.pid, processIdentity: identity }),
      );
    }
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
