import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { NetworkProbeFailure, ServerNetworkResult } from "@t3tools/contracts";
import { openProbeDispatcher, routeForSnapshot } from "./outbound.ts";
import { refreshNetworkSystemProxy } from "./snapshot.ts";
import {
  proxyUrlForServerRequest,
  resolveAgentRoute,
} from "@t3tools/provider-core/server/networkEnvironment";
import * as Undici from "undici";

const PROBE_TIMEOUT_MS = 8_000;

class ProbeRequestFailed extends Schema.TaggedError<ProbeRequestFailed>()("ProbeRequestFailed", {
  cause: Schema.Defect(),
}) {}

const GLOBAL_PROBES = [
  { name: "GitHub", url: "https://github.com" },
  { name: "npm", url: "https://registry.npmjs.org" },
] as const;

const AGENT_PROBES: Readonly<
  Record<string, readonly { readonly name: string; readonly url: string }[]>
> = {
  grok: [
    { name: "Grok", url: "https://api.x.ai" },
    { name: "Grok 聊天", url: "https://cli-chat-proxy.grok.com" },
  ],
  codex: [
    { name: "Codex", url: "https://api.openai.com" },
    { name: "ChatGPT", url: "https://chatgpt.com" },
  ],
  claudeAgent: [{ name: "Claude", url: "https://api.anthropic.com" }],
};

const AGENT_LABELS: Readonly<Record<string, string>> = {
  grok: "Grok",
  codex: "Codex",
  claudeAgent: "Claude",
  antigravity: "Antigravity",
};

function classify(error: unknown): NetworkProbeFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${code} ${message}`.toUpperCase();
  if (
    text.includes("CERT") ||
    text.includes("CERTIFICATE") ||
    text.includes("UNABLE_TO_VERIFY") ||
    text.includes("SELF_SIGNED") ||
    text.includes("TLS")
  ) {
    return "certificate";
  }
  if (text.includes("TIMEOUT") || text.includes("ABORT") || code.startsWith("UND_ERR_")) {
    if (code.startsWith("UND_ERR_CONNECT") || code === "ECONNREFUSED" || code === "ENOTFOUND") {
      return "connect";
    }
    if (text.includes("TIMEOUT") || text.includes("ABORT")) return "timeout";
  }
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET") return "connect";
  return "connect";
}

function failureDetail(failure: NetworkProbeFailure): string {
  if (failure === "timeout") return "超时";
  if (failure === "certificate") return "证书不受信任";
  return "连不上";
}

const probeOne = Effect.fn("Network.probe")(function* (input: {
  readonly name: string;
  readonly url: string;
  readonly dispatcher: Undici.Dispatcher;
}) {
  const started = yield* Clock.currentTimeMillis;
  const result = yield* Effect.tryPromise({
    try: async () => {
      const response = await Undici.request(input.url, {
        method: "GET",
        dispatcher: input.dispatcher,
        headersTimeout: PROBE_TIMEOUT_MS,
        bodyTimeout: PROBE_TIMEOUT_MS,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await response.body.dump();
      return response.statusCode;
    },
    catch: (cause) => new ProbeRequestFailed({ cause }),
  }).pipe(Effect.result);
  const elapsedMs = (yield* Clock.currentTimeMillis) - started;
  if (result._tag === "Success") {
    return {
      name: input.name,
      url: input.url,
      ok: true,
      status: result.success,
      failure: null,
      detail: `通 ${result.success}`,
      elapsedMs,
    };
  }
  const failure = classify(result.failure.cause);
  return {
    name: input.name,
    url: input.url,
    ok: false,
    status: null,
    failure,
    detail: failureDetail(failure),
    elapsedMs,
  };
});

export const inspectNetwork = Effect.fn("Network.inspect")(function* (input: {
  readonly probe: boolean;
}) {
  const snapshot = refreshNetworkSystemProxy(true);
  const route = routeForSnapshot(snapshot);
  const probes = input.probe
    ? yield* Effect.forEach(
        [
          ...GLOBAL_PROBES.map((target) => ({
            ...target,
            proxyUrl: proxyUrlForServerRequest(new URL(target.url).hostname, route),
          })),
          ...snapshot.agents.flatMap((agent) => {
            const targets = AGENT_PROBES[agent.driver] ?? [];
            const agentRoute = resolveAgentRoute(snapshot.settings, snapshot.system, agent.driver);
            return targets.map((target) => ({
              name: `${AGENT_LABELS[agent.driver] ?? agent.driver} · ${target.name}`,
              url: target.url,
              proxyUrl: proxyUrlForServerRequest(new URL(target.url).hostname, agentRoute),
            }));
          }),
        ],
        (target) => {
          const dispatcher = openProbeDispatcher(
            target.proxyUrl,
            snapshot.settings.extraCaCertPath,
          );
          return probeOne({
            name: target.name,
            url: target.url,
            dispatcher,
          }).pipe(Effect.ensuring(Effect.promise(() => dispatcher.close())));
        },
        { concurrency: 4 },
      )
    : [];
  const result: ServerNetworkResult = {
    proxyUrl: route.proxyUrl,
    source: route.source,
    detail: route.detail,
    noProxy: route.noProxy,
    probes,
  };
  return result;
});
