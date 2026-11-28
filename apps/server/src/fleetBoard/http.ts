import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  FLEET_BOARD_ENSURE_PATH,
  FLEET_BOARD_ROUTE_PREFIX,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { requestUrl } from "../requestUrl.ts";
import * as FleetBoardService from "./FleetBoardService.ts";

class FleetBoardRequestRejected extends Schema.TaggedError<FleetBoardRequestRejected>()(
  "FleetBoardRequestRejected",
  {
    status: Schema.Int,
    code: Schema.String,
    message: Schema.String,
  },
) {}

const reject = (status: number, code: string, message: string) =>
  new FleetBoardRequestRejected({ status, code, message });

// Hop-by-hop headers must not cross a proxy; the platforms set their own.
const STRIPPED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const forwardHeaders = (
  headers: Record<string, string | undefined>,
  stripped: ReadonlySet<string>,
): Record<string, string> => {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !stripped.has(name.toLowerCase())) {
      forwarded[name] = value;
    }
  }
  return forwarded;
};

/** Routes answer rejections in-band instead of dying: they are expected client states. */
const respond = (
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    FleetBoardRequestRejected,
    HttpServerRequest.HttpServerRequest
  >,
) =>
  Effect.match(effect, {
    onFailure: (error) =>
      HttpServerResponse.jsonUnsafe(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { "cache-control": "no-store" } },
      ),
    onSuccess: (response) => response,
  });

const routesFor = (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  board: FleetBoardService.FleetBoardService["Service"],
  httpClient: HttpClient.HttpClient,
) => {
  /** Login only: the board proxy carries no per-scope capability beyond reaching it. */
  const requireSession = Effect.fn("FleetBoardHttp.requireSession")(function* (
    scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const principal = yield* auth
      .authenticateHttpRequest(request)
      .pipe(
        Effect.mapError((error) =>
          EnvironmentAuth.isServerAuthCredentialError(error)
            ? reject(401, "login_required", "要登录才能用机群看板")
            : reject(503, "login_unreadable", "登录态读不了，不当成没登录"),
        ),
      );
    if (!principal.scopes.includes(scope)) {
      return yield* reject(403, "insufficient_scope", "缺少机群权限，用不了机群看板");
    }
  });

  const scopeForMethod = (method: string) =>
    method === "GET" || method === "HEAD"
      ? AuthOrchestrationReadScope
      : AuthOrchestrationOperateScope;

  const proxyToBoard = Effect.fn("FleetBoardHttp.proxyToBoard")(function* (
    suffix: string,
    search: string,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* requireSession(scopeForMethod(request.method));

    const upstreamUrl = `http://127.0.0.1:${board.port}${suffix}${search}`;
    const method = request.method as
      | "GET"
      | "POST"
      | "PUT"
      | "PATCH"
      | "DELETE"
      | "HEAD"
      | "OPTIONS";
    const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl, {
      headers: forwardHeaders(request.headers, STRIPPED_REQUEST_HEADERS),
    });
    const withBody =
      method === "GET" || method === "HEAD"
        ? upstreamRequest
        : HttpClientRequest.setBody(upstreamRequest, HttpBody.stream(request.stream));

    const upstream = yield* httpClient
      .execute(withBody)
      .pipe(
        Effect.mapError(() =>
          reject(
            502,
            "board_unreachable",
            "看板没响应。先确认看板在运行（机群页会自动拉起），再刷新重试",
          ),
        ),
      );

    const headers = forwardHeaders(upstream.headers, STRIPPED_RESPONSE_HEADERS);
    // Event streams must reach the browser as they arrive; no-transform keeps the
    // server-wide compression middleware from buffering them.
    if ((upstream.headers["content-type"] ?? "").startsWith("text/event-stream")) {
      const cacheControl = headers["cache-control"];
      headers["cache-control"] =
        cacheControl === undefined ? "no-transform" : `${cacheControl}, no-transform`;
    }

    return HttpServerResponse.stream(upstream.stream, {
      status: upstream.status,
      headers,
    });
  });

  const proxyRoute = respond(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = yield* Effect.fromOption(requestUrl(request)).pipe(
        Effect.mapError(() => reject(400, "bad_request", "请求地址认不出")),
      );
      const pathname = url.pathname;
      if (pathname === FLEET_BOARD_ROUTE_PREFIX) {
        yield* requireSession(AuthOrchestrationReadScope);
        return HttpServerResponse.redirect(`${FLEET_BOARD_ROUTE_PREFIX}/${url.search}`, {
          status: 308,
        });
      }
      const suffix = pathname.slice(FLEET_BOARD_ROUTE_PREFIX.length);
      return yield* proxyToBoard(suffix, url.search);
    }),
  );

  const ensureRoute = respond(
    Effect.gen(function* () {
      yield* requireSession(AuthOrchestrationReadScope);
      const result = yield* board.ensure;
      return HttpServerResponse.jsonUnsafe(result, {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }),
  );

  return Layer.mergeAll(
    HttpRouter.add("GET", FLEET_BOARD_ENSURE_PATH, ensureRoute),
    // find-my-way wildcard mounts also cover the bare prefix path, so /fleet-board
    // (the redirect target) needs no separate registration.
    HttpRouter.add("*", `${FLEET_BOARD_ROUTE_PREFIX}/*`, proxyRoute),
  );
};

// Services are captured at layer construction (the node-reads pattern), so Layer.provide
// chains compose them as ordinary requirements instead of request-level markers.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const board = yield* FleetBoardService.FleetBoardService;
    const httpClient = yield* HttpClient.HttpClient;
    return routesFor(auth, board, httpClient);
  }),
);
