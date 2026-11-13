// @effect-diagnostics nodeBuiltinImport:off -- the case starts a local HTTP server as the upstream.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
  type FleetEngineStatus,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import { FetchHttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as FleetEngineHttp from "./http.ts";

const TEST_AUTHORIZATION = "Bearer test";
const decodeSessionId = Schema.decodeUnknownSync(AuthSessionId);

const authenticated = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.authorization !== TEST_AUTHORIZATION) {
      return yield* new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId: "test",
      });
    }
    return yield* effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: decodeSessionId("fleet-engine-test"),
        subject: "test",
        method: "bearer-access-token",
        scopes: new Set<AuthEnvironmentScope>(),
      }),
    );
  }),
);

class FleetEngineTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.fleetEngine,
) {}

const BODY_LIMIT = 8_000;

const layerFor = (env: Record<string, string>) =>
  HttpApiBuilder.layer(FleetEngineTestApi).pipe(
    Layer.provide(FleetEngineHttp.layer),
    Layer.provide(authenticated),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Layer.provide(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const readRaw = (env: Record<string, string>, authorization?: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layerFor(env), { disableLogger: true })),
    (web) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request(
            "http://127.0.0.1/api/fleet/engine-status",
            authorization === undefined ? undefined : { headers: { authorization } },
          ),
        );
        return { status: response.status, text: await response.text() };
      }),
    (web) => Effect.promise(() => web.dispose()),
  );

const readStatus = (env: Record<string, string>) =>
  readRaw(env, TEST_AUTHORIZATION).pipe(
    Effect.map((response) => {
      expect(response.status).toBe(200);
      return JSON.parse(response.text) as FleetEngineStatus;
    }),
  );

const listen = (hits: { n: number }) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer((request, response) => {
            hits.n += 1;
            if (request.url === "/json") {
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify({ ok: true, service: "engine" }));
              return;
            }
            if (request.url === "/text") {
              response.end("x".repeat(BODY_LIMIT + 50));
              return;
            }
            if (request.url === "/down") {
              response.statusCode = 503;
              response.end("nope");
              return;
            }
            response.statusCode = 404;
            response.end();
          });
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
  );

it.live("reads a local upstream, a missing address, and a refused connection", () =>
  Effect.gen(function* () {
    const hits = { n: 0 };
    const upstream = yield* listen(hits);
    const address = upstream.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.die("upstream did not bind a port");
    }
    const origin = `http://127.0.0.1:${address.port}`;

    const anonymous = yield* readRaw({ FLEET_ENGINE_HEALTH_URL: `${origin}/json` });
    expect(anonymous.status).toBe(401);
    expect(anonymous.text).not.toContain('"service":"engine"');
    expect(hits.n).toBe(0);

    const missing = yield* readStatus({});
    expect(missing).toMatchObject({
      configured: false,
      reachable: false,
      httpStatus: null,
      body: null,
      reason: "没配置",
    });
    expect(missing.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const blank = yield* readStatus({ FLEET_ENGINE_HEALTH_URL: "  " });
    expect(blank.reason).toBe("没配置");

    const json = yield* readStatus({ FLEET_ENGINE_HEALTH_URL: `${origin}/json` });
    expect(json).toMatchObject({
      configured: true,
      reachable: true,
      httpStatus: 200,
      body: { ok: true, service: "engine" },
      reason: null,
    });
    expect(JSON.stringify(json)).not.toContain(origin);

    const text = yield* readStatus({ FLEET_ENGINE_HEALTH_URL: `${origin}/text` });
    expect(text.reachable).toBe(true);
    expect(text.httpStatus).toBe(200);
    expect(text.body).toBe("x".repeat(BODY_LIMIT));

    const down = yield* readStatus({ FLEET_ENGINE_HEALTH_URL: `${origin}/down` });
    expect(down).toMatchObject({
      configured: true,
      reachable: true,
      httpStatus: 503,
      body: "nope",
      reason: null,
    });

    const invalid = yield* readStatus({ FLEET_ENGINE_HEALTH_URL: "ftp://engine.example/health" });
    expect(invalid).toMatchObject({
      configured: true,
      reachable: false,
      httpStatus: null,
      body: null,
      reason: "地址不是 http(s)",
    });
    expect(JSON.stringify(invalid)).not.toContain("ftp://");

    const closedPort = yield* Effect.promise(async () => {
      const server = NodeHttp.createServer();
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const bound = server.address();
      if (bound === null || typeof bound === "string") throw new Error("closed port did not bind");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return bound.port;
    });
    const refused = yield* readStatus({
      FLEET_ENGINE_HEALTH_URL: `http://127.0.0.1:${closedPort}/health`,
    });
    expect(refused.configured).toBe(true);
    expect(refused.reachable).toBe(false);
    expect(refused.httpStatus).toBeNull();
    expect(refused.body).toBeNull();
    expect(refused.reason === "超时" || refused.reason?.startsWith("连不上")).toBe(true);
    expect(refused.reason).not.toContain("127.0.0.1");
    expect(refused.reason).not.toContain("http://");
    expect(refused.reason).not.toContain("https://");
  }).pipe(Effect.scoped),
);
