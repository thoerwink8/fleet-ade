// @effect-diagnostics nodeBuiltinImport:off -- The extra root is read while building a dispatcher, outside an Effect.
import * as NodeFS from "node:fs";
import * as NodeTls from "node:tls";

import {
  proxyUrlForServerRequest,
  resolveGlobalRoute,
  type ResolvedNetworkRoute,
} from "@t3tools/provider-core/server/networkEnvironment";
import * as Undici from "undici";

import { currentNetworkSnapshot, type NetworkSnapshot } from "./snapshot.ts";

const agents = new Map<string, Undici.Dispatcher>();

function extraCa(path: string): string[] | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  try {
    return [...NodeTls.rootCertificates, NodeFS.readFileSync(trimmed, "utf8")];
  } catch {
    return undefined;
  }
}

function createDispatcher(proxyUrl: string | null, caPath: string): Undici.Dispatcher {
  const ca = extraCa(caPath);
  if (!proxyUrl) {
    return ca
      ? new Undici.Agent({ allowH2: false, connect: { ca } })
      : new Undici.Agent({ allowH2: false });
  }
  if (!ca) {
    return new Undici.ProxyAgent({
      uri: proxyUrl,
      allowH2: false,
      clientFactory: (origin) => new Undici.Pool(origin, { allowH2: false }),
    });
  }
  return new Undici.ProxyAgent({
    uri: proxyUrl,
    allowH2: false,
    requestTls: { ca },
    clientFactory: (origin) => new Undici.Pool(origin, { allowH2: false, connect: { ca } }),
  });
}

function agentFor(proxyUrl: string | null, caPath: string): Undici.Dispatcher {
  const key = `${proxyUrl ?? ""}|${caPath}`;
  const cached = agents.get(key);
  if (cached) return cached;
  const agent = createDispatcher(proxyUrl, caPath);
  agents.set(key, agent);
  return agent;
}

export function openProbeDispatcher(proxyUrl: string | null, caPath: string): Undici.Dispatcher {
  return createDispatcher(proxyUrl, caPath);
}

export function routeForSnapshot(snapshot: NetworkSnapshot): ResolvedNetworkRoute {
  return resolveGlobalRoute(snapshot.settings, snapshot.system);
}

export class NetworkRoutingDispatcher extends Undici.Dispatcher {
  private readonly loadSnapshot: () => NetworkSnapshot;

  constructor(loadSnapshot: () => NetworkSnapshot = currentNetworkSnapshot) {
    super();
    this.loadSnapshot = loadSnapshot;
  }

  override dispatch(
    options: Undici.Dispatcher.DispatchOptions,
    handler: Undici.Dispatcher.DispatchHandler,
  ): boolean {
    const origin =
      options.origin instanceof URL
        ? options.origin
        : new URL(String(options.origin ?? "http://localhost"));
    const snapshot = this.loadSnapshot();
    const route = routeForSnapshot(snapshot);
    const proxyUrl = proxyUrlForServerRequest(origin.hostname, route);
    return agentFor(proxyUrl, snapshot.settings.extraCaCertPath).dispatch(options, handler);
  }

  override close(): Promise<void> {
    return closeAgents();
  }

  override destroy(): Promise<void> {
    return closeAgents();
  }
}

function closeAgents(): Promise<void> {
  const closing = [...agents.values()];
  agents.clear();
  return Promise.all(closing.map((agent) => agent.close())).then(() => undefined);
}

export function installNetworkDispatcher(): void {
  Undici.setGlobalDispatcher(new NetworkRoutingDispatcher());
}
