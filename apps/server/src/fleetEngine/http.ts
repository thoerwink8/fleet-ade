import { EnvironmentHttpApi, type FleetEngineStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest } from "../auth/http.ts";

const CHECK_TIMEOUT = Duration.seconds(5);
const BODY_LIMIT = 8_000;
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

const readHealthUrl = Config.String("FLEET_ENGINE_HEALTH_URL").pipe(
  Config.option,
  Config.map(Option.filter((value) => value.trim().length > 0)),
);

function checkedAtFrom(millis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
}

function notConfigured(checkedAt: string): FleetEngineStatus {
  return {
    configured: false,
    reachable: false,
    httpStatus: null,
    body: null,
    checkedAt,
    reason: "没配置",
  };
}

function unreachable(checkedAt: string, reason: string): FleetEngineStatus {
  return {
    configured: true,
    reachable: false,
    httpStatus: null,
    body: null,
    checkedAt,
    reason,
  };
}

/** Drop the target address so a failed check cannot echo it back to the client. */
function unreachableReason(cause: unknown, target: string): string {
  let host = "";
  try {
    host = new URL(target).host;
  } catch {
    host = "";
  }
  const raw = cause instanceof Error ? cause.message : String(cause);
  const stripped = raw
    .split(target)
    .join("")
    .split(host)
    .join("")
    .replace(URL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length === 0) return "连不上";
  return `连不上：${stripped.slice(0, 180)}`;
}

function decodeBody(text: string): unknown {
  if (text.length === 0) return null;
  if (text.length > BODY_LIMIT) return text.slice(0, BODY_LIMIT);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function httpTarget(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url;
}

const readFleetEngineStatus = Effect.fn("environment.fleetEngine.readStatus")(function* (
  httpClient: HttpClient.HttpClient,
  configured: Option.Option<string>,
) {
  const checkedAt = checkedAtFrom(yield* Clock.currentTimeMillis);
  if (Option.isNone(configured)) return notConfigured(checkedAt);

  const target = httpTarget(configured.value);
  if (target === undefined) return unreachable(checkedAt, "地址不是 http(s)");

  const targetUrl = target.toString();
  const fetched = yield* httpClient.get(targetUrl).pipe(
    Effect.flatMap((response) =>
      Effect.map(response.text, (text) => ({
        _tag: "Ok" as const,
        httpStatus: response.status,
        text,
      })),
    ),
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: CHECK_TIMEOUT,
      orElse: () => Effect.succeed({ _tag: "Timeout" as const }),
    }),
    Effect.catch((cause) => Effect.succeed({ _tag: "Failed" as const, cause })),
  );

  if (fetched._tag === "Timeout") return unreachable(checkedAt, "超时");
  if (fetched._tag === "Failed")
    return unreachable(checkedAt, unreachableReason(fetched.cause, targetUrl));

  return {
    configured: true,
    reachable: true,
    httpStatus: fetched.httpStatus,
    body: decodeBody(fetched.text),
    checkedAt,
    reason: null,
  } satisfies FleetEngineStatus;
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "fleetEngine",
  Effect.fnUntraced(function* (handlers) {
    const httpClient = yield* HttpClient.HttpClient;
    const configured = yield* readHealthUrl.pipe(Effect.orElseSucceed(() => Option.none()));
    return handlers.handle(
      "status",
      Effect.fn("environment.fleetEngine.status")(function* () {
        yield* annotateEnvironmentRequest("fleetEngine.status");
        return yield* readFleetEngineStatus(httpClient, configured);
      }),
    );
  }),
);
