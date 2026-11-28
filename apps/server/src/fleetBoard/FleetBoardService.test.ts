// @effect-diagnostics nodeBuiltinImport:off -- fixture servers are plain node:http listeners.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";

import * as FleetBoardService from "./FleetBoardService.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

const healthReply: NodeHttp.RequestListener = (_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ app: "fleet-board" }));
};

const listen = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.promise(() => {
      const { promise, resolve } = Promise.withResolvers<NodeHttp.Server>();
      const server = NodeHttp.createServer(handler);
      server.listen(0, "127.0.0.1", () => resolve(server));
      return promise;
    }),
    (server) =>
      Effect.promise(() => {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
        return promise;
      }),
  );

const closeServer = (server: NodeHttp.Server) =>
  Effect.promise(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (!server.listening) {
      resolve();
      return promise;
    }
    server.closeAllConnections();
    server.close(() => resolve());
    return promise;
  });

const portOf = (server: NodeHttp.Server) => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind a port");
  }
  return address.port;
};

const layerFor = (options: FleetBoardService.FleetBoardServiceOptions) =>
  FleetBoardService.layer(options).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
  );

// A port nothing listens on, for the probe-none path. Racing a real bind is fine:
// the launcher probe would report the foreign listener, which is correct behavior.
const unusedPort = Effect.promise(() => {
  const { promise, resolve } = Promise.withResolvers<number>();
  const server = NodeHttp.createServer((_request, response) => response.end());
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resolve(port));
  });
  return promise;
});

it.live("在跑的看板直接复用，不再启动第二份", () =>
  Effect.gen(function* () {
    const server = yield* listen(healthReply);
    const spawnCalls: Array<string> = [];
    const service = yield* FleetBoardService.FleetBoardService.pipe(
      Effect.provide(
        layerFor({
          port: portOf(server),
          binaryPaths: [],
          spawn: (binaryPath) =>
            Effect.sync(() => {
              spawnCalls.push(binaryPath);
              return { pid: 1 };
            }),
        }),
      ),
    );

    const result = yield* service.ensure;
    expect(result.status).toBe("running");
    expect(result.detail).toBeNull();
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(spawnCalls).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("端口上是别的程序时回报 port-taken，不启动进程", () =>
  Effect.gen(function* () {
    const server = yield* listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ app: "something-else" }));
    });
    const spawnCalls: Array<string> = [];
    const service = yield* FleetBoardService.FleetBoardService.pipe(
      Effect.provide(
        layerFor({
          port: portOf(server),
          binaryPaths: [],
          spawn: (binaryPath) =>
            Effect.sync(() => {
              spawnCalls.push(binaryPath);
              return { pid: 1 };
            }),
        }),
      ),
    );

    const result = yield* service.ensure;
    expect(result.status).toBe("port-taken");
    expect(result.detail).toContain("占用");
    expect(spawnCalls).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("找不到启动程序时回报 not-installed 和安装方法", () =>
  Effect.gen(function* () {
    const port = yield* unusedPort;
    const service = yield* FleetBoardService.FleetBoardService.pipe(
      Effect.provide(
        layerFor({
          port,
          binaryPaths: ["/nonexistent/fleet-board"],
          spawn: () => Effect.die(new Error("spawn must not run")),
        }),
      ),
    );

    const result = yield* service.ensure;
    expect(result.status).toBe("not-installed");
    expect(result.detail).toContain("FLEET_BOARD_BIN");
    expect(result.detail).toContain("fleet-dao");
  }).pipe(Effect.scoped),
);

it.live("没运行时拉起启动程序，健康检查通过后回报 running；并发只起一份", () =>
  Effect.gen(function* () {
    const port = yield* unusedPort;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "fleet-board-test-" });
    const binaryPath = path.join(tempDir, "fleet-board.exe");
    yield* fs.writeFileString(binaryPath, "");

    const spawnCalls: Array<string> = [];
    const replacementServers: Array<NodeHttp.Server> = [];
    const service = yield* FleetBoardService.FleetBoardService.pipe(
      Effect.provide(
        layerFor({
          port,
          binaryPaths: [binaryPath],
          pollInterval: "25 millis",
          spawn: (spawnedPath) =>
            Effect.sync(() => {
              spawnCalls.push(spawnedPath);
              // The launcher binds the port a moment later; the poll loop covers the gap.
              replacementServers.push(NodeHttp.createServer(healthReply).listen(port, "127.0.0.1"));
              return { pid: 4242 };
            }),
        }),
      ),
    );

    const [first, second] = yield* Effect.all([service.ensure, service.ensure], {
      concurrency: 2,
    });
    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(spawnCalls).toEqual([binaryPath]);

    for (const server of replacementServers) {
      yield* closeServer(server);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("拉起后健康检查一直不通过时回报 failed", () =>
  Effect.gen(function* () {
    const port = yield* unusedPort;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "fleet-board-test-" });
    const binaryPath = path.join(tempDir, "fleet-board.exe");
    yield* fs.writeFileString(binaryPath, "");

    const service = yield* FleetBoardService.FleetBoardService.pipe(
      Effect.provide(
        layerFor({
          port,
          binaryPaths: [binaryPath],
          launchTimeout: "300 millis",
          pollInterval: "25 millis",
          probeTimeout: "100 millis",
          spawn: () => Effect.succeed({ pid: 4242 }),
        }),
      ),
    );

    const result = yield* service.ensure;
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("fleet-board.log");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("启动程序抛错时回报 failed", () =>
  Effect.gen(function* () {
    const port = yield* unusedPort;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "fleet-board-test-" });
    const binaryPath = path.join(tempDir, "fleet-board.exe");
    yield* fs.writeFileString(binaryPath, "");

    const service = yield* FleetBoardService.FleetBoardService.pipe(
      Effect.provide(
        layerFor({
          port,
          binaryPaths: [binaryPath],
          spawn: () =>
            Effect.fail(new FleetBoardService.FleetBoardSpawnError({ cause: new Error("EACCES") })),
        }),
      ),
    );

    const result = yield* service.ensure;
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("启动看板进程失败");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("默认拉起用 --no-open、隐藏窗口、脱离父进程", () =>
  Effect.gen(function* () {
    const port = yield* unusedPort;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "fleet-board-test-" });
    const binaryPath = path.join(tempDir, "fleet-board.exe");
    yield* fs.writeFileString(binaryPath, "");

    const spawnMock = vi.mocked(NodeChildProcess.spawn);
    spawnMock.mockClear();
    spawnMock.mockImplementation(
      // Stands in for the launcher process; only the observable contract matters.
      () =>
        ({
          on: () => undefined,
          unref: () => undefined,
          pid: 4321,
        }) as never,
    );

    const service = yield* FleetBoardService.FleetBoardService.pipe(
      Effect.provide(
        layerFor({
          port,
          binaryPaths: [binaryPath],
          launchTimeout: "200 millis",
          pollInterval: "25 millis",
          probeTimeout: "100 millis",
        }),
      ),
    );

    yield* service.ensure;
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(binaryPath, ["--no-open"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
