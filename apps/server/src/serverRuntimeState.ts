// @effect-diagnostics nodeBuiltinImport:off - The ownership probe opens the lock file directly.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

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
import {
  legacyOwnerStartedBeforeRecord,
  legacyOwnerStartTimeCommand,
} from "./legacyServerOwner.ts";

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

/** Whether a running server holds the ownership lock. Read-only, so it never creates the lock file. */
const isServerOwnershipHeld = (statePath: string): boolean => {
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(
      NodePath.join(NodePath.dirname(statePath), "server-owner.sqlite"),
      { readOnly: true, timeout: 0 },
    );
    db.prepare("SELECT 1 FROM sqlite_schema").get();
    return false;
  } catch (cause) {
    return isSqliteBusy(cause);
  } finally {
    db?.close();
  }
};

/**
 * The recorded server process, only while this exact process still runs. A lock-aware record is
 * live while its owner holds `server-owner.sqlite`, which the OS releases even on SIGKILL. A
 * pre-lock record needs process start-time proof: signal 0 cannot tell a reused PID apart.
 */
export const verifyRecordedServerProcess = Effect.fn("verifyRecordedServerProcess")(function* (
  state: Pick<PersistedServerRuntimeState, "pid" | "ownerId" | "startedAt">,
  statePath: string,
): Effect.fn.Return<boolean, never, never> {
  if (!isProcessAlive(state.pid)) return false;
  if (state.ownerId !== undefined) return isServerOwnershipHeld(statePath);
  const recordedAt = Date.parse(state.startedAt);
  if (!Number.isFinite(recordedAt)) return true;
  const platform = yield* HostProcess.Platform;
  const { command, args, env } = legacyOwnerStartTimeCommand(state.pid, platform);
  // Raw execFile: the CLI runtime does not carry a process runner everywhere this is read.
  const output = yield* Effect.promise(
    () =>
      new Promise<string | undefined>((resolve) =>
        NodeChildProcess.execFile(
          command,
          args,
          { env: { ...process.env, ...env }, timeout: 2_000, maxBuffer: 16_384 },
          (error, stdout) => resolve(error === null ? stdout : undefined),
        ),
      ),
  );
  return legacyOwnerStartedBeforeRecord(output, recordedAt, platform);
});

/** Signal 0 only probes existence; EPERM still means alive. */
export const isProcessAlive = (pid: number): boolean => {
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
  if (state.value.pid === process.pid) return state;
  return (yield* verifyRecordedServerProcess(state.value, path)) ? state : Option.none();
});
