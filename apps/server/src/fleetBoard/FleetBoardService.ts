// node:net and node:child_process are the probe transport and the detached launcher spawn;
// both are injectable through FleetBoardServiceOptions for tests.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import type { FleetBoardEnsureResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";

const DEFAULT_PORT = 4587;
/** Must match the launcher and board-server identity token. */
const APP_ID = "fleet-board";

const INSTALL_DETAIL =
  "没找到看板启动程序。在 fleet-base 的 packages/fleet-board/desktop 用 go build 构建启动器，放到 ~/.fleet-dao/bin/fleet-board(.exe)，或用环境变量 FLEET_BOARD_BIN 指到它的路径";

export class FleetBoardSpawnError extends Schema.TaggedError<FleetBoardSpawnError>()(
  "FleetBoardSpawnError",
  { cause: Schema.Defect() },
) {}

export type FleetBoardProbeState = "running" | "foreign" | "none";

export interface FleetBoardServiceOptions {
  readonly port: number;
  /** Launcher candidates in order; the first existing file wins. */
  readonly binaryPaths: ReadonlyArray<string>;
  readonly spawn?: (
    binaryPath: string,
  ) => Effect.Effect<{ readonly pid: number | undefined }, FleetBoardSpawnError>;
  readonly dialTcp?: (port: number) => Effect.Effect<boolean>;
  /** Cap on waiting for a launched board to answer health probes. */
  readonly launchTimeout?: Duration.Input;
  readonly probeTimeout?: Duration.Input;
  readonly pollInterval?: Duration.Input;
}

export class FleetBoardService extends Context.Service<
  FleetBoardService,
  {
    /**
     * Probes the board port; launches the launcher with `--no-open` when nothing
     * is there. Never starts a second copy and never kills the board.
     */
    readonly ensure: Effect.Effect<FleetBoardEnsureResult>;
    /**
     * Proves the port serves the board before the proxy trusts it. Positive results
     * are cached; a negative probe is re-checked every time, so a board taking the
     * port back from a squatter recovers without a restart.
     */
    readonly verifyIdentity: Effect.Effect<FleetBoardProbeState>;
    /** Drops the cached positive identity after the upstream stops answering. */
    readonly invalidateIdentity: Effect.Effect<void>;
    readonly port: number;
  }
>()("t3/fleetBoard/FleetBoardService") {}

const portTakenDetail = (port: number) =>
  `端口 ${port} 被别的程序占用，看板起不来。请关掉占用它的程序后重试`;

const healthAppId = (text: string): unknown => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed !== null && typeof parsed === "object" && "app" in parsed) {
    return parsed.app;
  }
  return undefined;
};

/** Same three-way read as the launcher's probe: ours, something else listening, or nothing. */
const probePort = Effect.fn("FleetBoardService.probePort")(function* (
  httpClient: HttpClient.HttpClient,
  port: number,
  probeTimeout: Duration.Input,
  dialTcp: (port: number) => Effect.Effect<boolean>,
) {
  const probed = yield* httpClient.get(`http://127.0.0.1:${port}/api/health`).pipe(
    Effect.flatMap((response) =>
      Effect.map(response.text, (text) => ({ status: response.status, text })),
    ),
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: probeTimeout,
      orElse: () => Effect.succeed(null),
    }),
    Effect.orElseSucceed(() => null),
  );
  if (probed !== null) {
    return probed.status === 200 && healthAppId(probed.text) === APP_ID
      ? ("running" as const)
      : ("foreign" as const);
  }
  return (yield* dialTcp(port)) ? ("foreign" as const) : ("none" as const);
});

const spawnLauncher = (binaryPath: string) =>
  Effect.try({
    try: () => {
      const child = NodeChildProcess.spawn(binaryPath, ["--no-open"], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      // ENOENT races (file removed after the exists check) surface as an async error event;
      // without a listener Node throws it unhandled. The health timeout reports the failure.
      child.on("error", () => {});
      child.unref();
      return { pid: child.pid };
    },
    catch: (cause) => new FleetBoardSpawnError({ cause }),
  });

const dialTcpLoopback = (port: number) =>
  Effect.promise(() => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const socket = NodeNet.connect({ host: "127.0.0.1", port, timeout: 800 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    return promise;
  });

const ensureResult = (status: FleetBoardEnsureResult["status"], detail: string | null) =>
  Effect.map(
    DateTime.now,
    (now) =>
      ({ status, detail, checkedAt: DateTime.formatIso(now) }) satisfies FleetBoardEnsureResult,
  );

const make = Effect.fn("FleetBoardService.make")(function* (options: FleetBoardServiceOptions) {
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const launchTimeout = options.launchTimeout ?? Duration.seconds(25);
  const probeTimeout = options.probeTimeout ?? Duration.seconds(2);
  const pollInterval = options.pollInterval ?? Duration.millis(150);
  const spawn = options.spawn ?? spawnLauncher;
  const dialTcp = options.dialTcp ?? dialTcpLoopback;

  const probe = () => probePort(httpClient, options.port, probeTimeout, dialTcp);

  const launchAndAwait = Effect.fn("FleetBoardService.launchAndAwait")(function* () {
    let binaryPath: string | null = null;
    for (const candidate of options.binaryPaths) {
      // An unreadable candidate cannot be executed either; treat it as absent.
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        binaryPath = candidate;
        break;
      }
    }
    if (binaryPath === null) {
      return yield* ensureResult("not-installed", INSTALL_DETAIL);
    }

    const spawned = yield* Effect.exit(spawn(binaryPath));
    if (spawned._tag === "Failure") {
      return yield* ensureResult(
        "failed",
        "启动看板进程失败，看板日志在 ~/.fleet-dao/run/fleet-board.log",
      );
    }

    const deadline = (yield* DateTime.now).epochMilliseconds + Duration.toMillis(launchTimeout);
    for (;;) {
      yield* Effect.sleep(pollInterval);
      const state = yield* probe();
      if (state === "running") return yield* ensureResult("running", null);
      if (state === "foreign") {
        return yield* ensureResult("port-taken", portTakenDetail(options.port));
      }
      if ((yield* DateTime.now).epochMilliseconds >= deadline) {
        return yield* ensureResult(
          "failed",
          "看板进程起来了但健康检查一直没通过，看板日志在 ~/.fleet-dao/run/fleet-board.log",
        );
      }
    }
  });

  const ensureUnlocked = Effect.fn("FleetBoardService.ensure")(function* () {
    const first = yield* probe();
    if (first === "running") return yield* ensureResult("running", null);
    if (first === "foreign") {
      return yield* ensureResult("port-taken", portTakenDetail(options.port));
    }
    return yield* launchAndAwait();
  });

  // Concurrent ensures must not double-spawn; serialized callers reuse the first one's launch.
  const semaphore = yield* Semaphore.make(1);
  let identityVerified = false;
  return FleetBoardService.of({
    ensure: semaphore.withPermits(1)(ensureUnlocked()),
    verifyIdentity: Effect.suspend(() => {
      if (identityVerified) return Effect.succeed<FleetBoardProbeState>("running");
      return Effect.map(probe(), (state) => {
        if (state === "running") identityVerified = true;
        return state;
      });
    }),
    invalidateIdentity: Effect.sync(() => {
      identityVerified = false;
    }),
    port: options.port,
  });
});

export const layer = (
  options: FleetBoardServiceOptions,
): Layer.Layer<FleetBoardService, never, HttpClient.HttpClient | FileSystem.FileSystem> =>
  Layer.effect(FleetBoardService, make(options));

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
};

export const layerLive: Layer.Layer<
  FleetBoardService,
  never,
  HttpClient.HttpClient | FileSystem.FileSystem
> = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const binaryPaths = [
      ...(typeof env.FLEET_BOARD_BIN === "string" && env.FLEET_BOARD_BIN.trim().length > 0
        ? [env.FLEET_BOARD_BIN]
        : []),
      NodePath.join(
        home,
        ".fleet-dao",
        "bin",
        platform === "win32" ? "fleet-board.exe" : "fleet-board",
      ),
    ];
    return layer({ port: parsePort(env.FLEET_BOARD_PORT), binaryPaths });
  }),
);
