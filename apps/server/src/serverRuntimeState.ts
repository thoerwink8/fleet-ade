// @effect-diagnostics nodeBuiltinImport:off - The ownership probe opens the lock file directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { formatHostForUrl, isWildcardHost } from "@t3tools/shared/hostClassification";
import packageJson from "../package.json" with { type: "json" };
import type * as ServerConfig from "./config.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { processIdentity } from "./legacyServerOwner.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  ownerId: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  privateNetworkOnly: Schema.optional(Schema.Boolean),
  port: Schema.Int,
  origin: Schema.String,
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
  // The raw process start time the writer probed for its own PID. Verification replays the same
  // probe and requires exact equality — a reused PID never matches, whatever the wall clock says.
  processIdentity: Schema.optional(Schema.String),
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export class ServerRuntimeStateError extends Schema.TaggedError<ServerRuntimeStateError>()(
  "ServerRuntimeStateError",
  {
    operation: Schema.Literals(["persist", "read", "decode", "clear"]),
    statePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} server runtime state at ${this.statePath}.`;
  }
}

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const runtimeOriginForConfig = (
  config: Pick<ServerConfig.ServerConfig["Service"], "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<
    ServerConfig.ServerConfig["Service"],
    "host" | "privateNetworkOnly" | "devUrl"
  >;
  readonly port: number;
  readonly serviceManaged?: boolean;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    ...(input.config.privateNetworkOnly ? { privateNetworkOnly: true } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
    ...(input.serviceManaged ? { serviceManaged: true } : {}),
    serverVersion: packageJson.version,
  }));

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "persist",
          statePath: input.path,
          cause,
        }),
    ),
  );

export const clearPersistedServerRuntimeState = Effect.fn(
  "serverRuntimeState.clearPersistedServerRuntimeState",
)(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(path, { force: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "clear",
          statePath: path,
          cause,
        }),
    ),
    Effect.catchTags({
      ServerRuntimeStateError: (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            statePath: error.statePath,
            cause: error,
          }),
        ),
    }),
  );
});

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

/**
 * Owners this process acquired. POSIX SQLite locks are per-process, so an in-process owner's
 * busy probe cannot see its own lock; the exact ownerId match is the in-process proof.
 */
const inProcessOwners = new Map<string, string>();

/** While the returned effect's scope is open, this process holds `ownerId` over `statePath`. */
export const registerInProcessOwner = Effect.fn("registerInProcessOwner")(function* (
  statePath: string,
  ownerId: string,
) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      inProcessOwners.set(statePath, ownerId);
    }),
    () =>
      Effect.sync(() => {
        if (inProcessOwners.get(statePath) === ownerId) {
          inProcessOwners.delete(statePath);
        }
      }),
  );
});

type OwnershipLockState = "held" | "free" | "unknown";

/**
 * Whether a process holds the ownership lock. Read-only, so it never creates the lock file.
 * A missing file is free: the owner creates it before locking and never deletes it while running.
 */
const probeServerOwnershipLock = (statePath: string): OwnershipLockState => {
  const lockPath = NodePath.join(NodePath.dirname(statePath), "server-owner.sqlite");
  const stat = (() => {
    try {
      return NodeFS.statSync(lockPath, { throwIfNoEntry: false });
    } catch {
      return "error" as const;
    }
  })();
  if (stat === "error") return "unknown";
  if (stat === undefined) return "free";
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(lockPath, { readOnly: true, timeout: 0 });
    db.prepare("SELECT 1 FROM sqlite_schema").get();
    return "free";
  } catch (cause) {
    return isSqliteBusy(cause) ? "held" : "unknown";
  } finally {
    db?.close();
  }
};

/**
 * Injectable for tests: the real probe shells out to `ps` or PowerShell and can fail on hosts
 * without them, so verification distinguishes that failure from proof of PID reuse.
 */
export const ProcessIdentityProbe = Context.Reference<
  (pid: number, platform: NodeJS.Platform) => Promise<string | undefined>
>("serverRuntimeState/ProcessIdentityProbe", {
  defaultValue: () => processIdentity,
});

export type RecordedServerLiveness = "live" | "stale" | "unknown";

/**
 * Whether the record describes a server that still runs and still owns its home. The stored
 * process identity must equal a fresh probe of the recorded PID exactly — no wall clock, no
 * tolerance. Unverifiable identity is "unknown", never "live".
 */
export const verifyRecordedServerProcessLiveness = Effect.fn("verifyRecordedServerProcessLiveness")(
  function* (
    state: Pick<PersistedServerRuntimeState, "pid" | "ownerId" | "processIdentity">,
    statePath: string,
  ): Effect.fn.Return<RecordedServerLiveness, never, never> {
    if (!isProcessAlive(state.pid)) return "stale";

    // The in-process registry is authoritative for this process's own ownership: POSIX SQLite
    // locks are invisible to their own process, and a registered owner never needs to re-prove
    // itself. Only a defined ownerId with a matching registration binds the record; a missing
    // ownerId or an empty registry never matches, not even on undefined === undefined.
    if (
      state.pid === process.pid &&
      state.ownerId !== undefined &&
      inProcessOwners.get(statePath) === state.ownerId
    ) {
      return "live";
    }

    // Records written before identity tracking carry no proof. While their PID lives, a reused
    // PID and the real legacy server are indistinguishable, so they are never live.
    if (state.processIdentity === undefined) return "unknown";

    const probeIdentity = yield* ProcessIdentityProbe;
    const platform = yield* HostProcess.Platform;
    const liveIdentity = yield* Effect.promise(() => probeIdentity(state.pid, platform));
    if (liveIdentity === undefined) return "unknown";
    if (liveIdentity !== state.processIdentity) return "stale";

    // The identity match proves this process is the recorded owner instance. In-system it holds
    // the lock until it dies; a free lock means it lost the home, and the probe cannot identify
    // another holder, so held plus identity is the binding proof.
    switch (probeServerOwnershipLock(statePath)) {
      case "held":
        return "live";
      case "free":
        return "stale";
      default:
        return "unknown";
    }
  },
);

/** Signal 0 only probes existence; EPERM still means alive. */
const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const readPersistedServerRuntimeState = Effect.fn(
  "serverRuntimeState.readPersistedServerRuntimeState",
)(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new ServerRuntimeStateError({
                  operation: "read",
                  statePath: path,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeedSome(contents),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedServerRuntimeState>();
    }

    return yield* decodePersistedServerRuntimeState(trimmed).pipe(
      Effect.asSome,
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  },
  Effect.catchTags({
    ServerRuntimeStateError: (error) =>
      Effect.logWarning(error.message).pipe(
        Effect.annotateLogs({
          operation: error.operation,
          statePath: error.statePath,
          cause: error,
        }),
        Effect.as(Option.none<PersistedServerRuntimeState>()),
      ),
  }),
);

/**
 * The runtime record, only while its server process is alive. Read this before sending
 * credentials to the recorded origin: a killed server leaves its record behind, and
 * another process may own its port by now.
 */
export const readLiveServerRuntimeState = Effect.fn(
  "serverRuntimeState.readLiveServerRuntimeState",
)(function* (
  path: string,
): Effect.fn.Return<Option.Option<PersistedServerRuntimeState>, never, FileSystem.FileSystem> {
  const state = yield* readPersistedServerRuntimeState(path);
  if (Option.isNone(state)) return state;
  return (yield* verifyRecordedServerProcessLiveness(state.value, path)) === "live"
    ? state
    : Option.none();
});
