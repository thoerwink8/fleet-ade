// @effect-diagnostics nodeBuiltinImport:off -- fixture upstream is a plain node:http listener.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type FleetBoardEnsureResult,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerHttp from "../http.ts";
import * as FleetBoardService from "./FleetBoardService.ts";
import * as FleetBoardHttp from "./http.ts";

const TEST_AUTHORIZATION = "Bearer fleet-board-test";

const principalFor = (
  scopes: ReadonlyArray<typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope>,
): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make("fleet-board-test"),
  subject: "fleet-board-test",
  method: "bearer-access-token" as const,
  scopes,
});

const sessionAuth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: (request) =>
    request.headers.authorization === TEST_AUTHORIZATION
      ? Effect.succeed(principalFor([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]))
      : request.headers.authorization === "Bearer fleet-board-noscope"
        ? Effect.succeed(principalFor([]))
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
});

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

interface Upstream {
  readonly server: NodeHttp.Server;
  readonly hits: Array<{ method: string; url: string | undefined }>;
  readonly bodies: Array<string>;
  readonly sseClose: Promise<void>;
  readonly sseRequestCount: () => number;
}

const listenUpstream = () =>
  Effect.promise(() => {
    const { promise, resolve } = Promise.withResolvers<Upstream>();
    const hits: Upstream["hits"] = [];
    const bodies: Array<string> = [];
    const sseClosed = Promise.withResolvers<void>();
    let sseRequests = 0;
    const server = NodeHttp.createServer((request, response) => {
      hits.push({ method: request.method ?? "", url: request.url });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/events") {
        sseRequests += 1;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
        });
        response.write("retry: 2000\n\ndata: first\n\n");
        response.on("close", () => sseClosed.resolve());
        return;
      }
      if (url.pathname === "/api/viewed") {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          bodies.push(Buffer.concat(chunks).toString("utf8"));
          response.statusCode = 204;
          response.end();
        });
        return;
      }
      if (url.pathname === "/api/status") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, query: url.search }));
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<html><body>board</body></html>");
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        hits,
        bodies,
        sseClose: sseClosed.promise,
        sseRequestCount: () => sseRequests,
      }),
    );
    return promise;
  });

const nodePortOf = (server: NodeHttp.Server) => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind a port");
  }
  return address.port;
};

const testBoardService = (upstreamPort: number) =>
  FleetBoardService.layer({
    port: upstreamPort,
    binaryPaths: [],
    spawn: () => Effect.succeed({ pid: 1 }),
  }).pipe(Layer.provideMerge(FetchHttpClient.layer), Layer.provideMerge(NodeServices.layer));

// Services stay ambient (provideMerge, not provide): Layer.provide would remove them from
// the request context. One fetch client serves both the proxy upstream and test requests.
const serveFleetBoard = Effect.fnUntraced(function* (
  serviceLayer: Layer.Layer<FleetBoardService.FleetBoardService, never>,
) {
  const services = yield* Layer.build(
    HttpRouter.serve(Layer.mergeAll(FleetBoardHttp.layer, ServerHttp.layerHttpCompression), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(serviceLayer),
      Layer.provideMerge(sessionAuth),
      Layer.provideMerge(Layer.fresh(FetchHttpClient.layer)),
      Layer.provideMerge(
        NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
      ),
    ),
  );
  const server = Context.get(services, HttpServer.HttpServer);
  const address = server.address;
  if (!("port" in address)) {
    return yield* Effect.die(new Error("test server did not expose a port"));
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    client: Context.get(services, HttpClient.HttpClient),
  };
});

const authed = { headers: { authorization: TEST_AUTHORIZATION } } as const;

it.live("没登录访问 /fleet-board/* 和 ensure 都回 401，转发不触上游", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.acquireRelease(listenUpstream(), (fixture) =>
      closeServer(fixture.server),
    );
    const { origin, client } = yield* serveFleetBoard(
      testBoardService(nodePortOf(upstream.server)),
    );

    const hitsBefore = upstream.hits.length;

    const proxy = yield* client.execute(HttpClientRequest.get(`${origin}/fleet-board/`));
    expect(proxy.status).toBe(401);

    const nested = yield* client.execute(HttpClientRequest.get(`${origin}/fleet-board/api/status`));
    expect(nested.status).toBe(401);

    const ensure = yield* client.execute(HttpClientRequest.get(`${origin}/api/fleet-board/ensure`));
    expect(ensure.status).toBe(401);

    expect(upstream.hits.length).toBe(hitsBefore);
  }).pipe(Effect.scoped),
);

it.live("登录了但没有机群权限时回 403，转发不触上游", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.acquireRelease(listenUpstream(), (fixture) =>
      closeServer(fixture.server),
    );
    const { origin, client } = yield* serveFleetBoard(
      testBoardService(nodePortOf(upstream.server)),
    );

    const response = yield* client.execute(
      HttpClientRequest.get(`${origin}/fleet-board/api/status`, {
        headers: { authorization: "Bearer fleet-board-noscope" },
      }),
    );
    expect(response.status).toBe(403);
    expect(upstream.hits).toHaveLength(0);
  }).pipe(Effect.scoped),
);

it.live("普通 GET 原样透传：状态码、内容和上游路径都对", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.acquireRelease(listenUpstream(), (fixture) =>
      closeServer(fixture.server),
    );
    const { origin, client } = yield* serveFleetBoard(
      testBoardService(nodePortOf(upstream.server)),
    );

    const response = yield* client.execute(
      HttpClientRequest.get(`${origin}/fleet-board/api/status?x=1`, authed),
    );
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { ok: boolean; query: string };
    expect(body.ok).toBe(true);
    expect(body.query).toBe("?x=1");
    expect(upstream.hits.some((hit) => hit.url === "/api/status?x=1")).toBe(true);
  }).pipe(Effect.scoped),
);

it.live("POST 带体透传到上游", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.acquireRelease(listenUpstream(), (fixture) =>
      closeServer(fixture.server),
    );
    const { origin, client } = yield* serveFleetBoard(
      testBoardService(nodePortOf(upstream.server)),
    );

    const response = yield* client.execute(
      HttpClientRequest.post(`${origin}/fleet-board/api/viewed`, {
        ...authed,
        body: HttpBody.uint8Array(
          new TextEncoder().encode(JSON.stringify({ at: "now" })),
          "application/json",
        ),
      }),
    );
    expect(response.status).toBe(204);
    expect(upstream.bodies).toContain(JSON.stringify({ at: "now" }));
    expect(upstream.hits.some((hit) => hit.method === "POST" && hit.url === "/api/viewed")).toBe(
      true,
    );
  }).pipe(Effect.scoped),
);

it.live("/fleet-board 重定向到带斜杠的地址", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.acquireRelease(listenUpstream(), (fixture) =>
      closeServer(fixture.server),
    );
    const { origin, client } = yield* serveFleetBoard(
      testBoardService(nodePortOf(upstream.server)),
    );

    const response = yield* client
      .execute(HttpClientRequest.get(`${origin}/fleet-board`, authed))
      // fetch follows redirects at the transport level; manual keeps the 308 visible.
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe("/fleet-board/");
  }).pipe(Effect.scoped),
);

it.live("EventSource 流式透传：数据先到不等连接结束，前端断开后上游连接也断", () =>
  Effect.gen(function* () {
    const upstream = yield* Effect.acquireRelease(listenUpstream(), (fixture) =>
      closeServer(fixture.server),
    );
    const { origin, client } = yield* serveFleetBoard(
      testBoardService(nodePortOf(upstream.server)),
    );

    const response = yield* client.execute(
      HttpClientRequest.get(`${origin}/fleet-board/api/events`, authed),
    );
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["cache-control"]).toContain("no-transform");

    // The fake writes one event immediately and never closes; receiving it proves streaming.
    const chunks = yield* Stream.runCollect(Stream.take(response.stream, 1));
    const text = new TextDecoder().decode(Array.from(chunks)[0]);
    expect(text).toContain("data: first");
    expect(upstream.sseRequestCount()).toBe(1);

    // runCollect returning means the consumer stopped early; the abort finalizer
    // must tear down the upstream connection too, or the board never goes idle.
    yield* Effect.promise(() => upstream.sseClose);
  }).pipe(Effect.scoped),
);

it.live("ensure 路由返回服务的结果", () =>
  Effect.gen(function* () {
    const ensureResult: FleetBoardEnsureResult = {
      status: "not-installed",
      detail: "测试原因",
      checkedAt: "2026-11-28T00:00:00.000Z",
    };
    const { origin, client } = yield* serveFleetBoard(
      Layer.succeed(FleetBoardService.FleetBoardService, {
        ensure: Effect.succeed(ensureResult),
        port: 1,
      }),
    );

    const response = yield* client.execute(
      HttpClientRequest.get(`${origin}/api/fleet-board/ensure`, authed),
    );
    expect(response.status).toBe(200);
    expect(yield* response.json).toEqual(ensureResult);
  }).pipe(Effect.scoped),
);
