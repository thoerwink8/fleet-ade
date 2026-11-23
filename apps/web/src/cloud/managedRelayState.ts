import {
  createManagedRelayQueryManager,
  ManagedRelay,
  managedRelaySessionAtom,
} from "@t3tools/client-runtime/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const managedRelayAtomRuntime = Atom.runtime(
  Layer.effect(
    ManagedRelay.ManagedRelayClient,
    runtime.contextEffect.pipe(
      Effect.map((context) => Context.get(context, ManagedRelay.ManagedRelayClient)),
    ),
  ),
);

const managedRelayQueryManager = createManagedRelayQueryManager(managedRelayAtomRuntime);

/** Refetches the account's environments and T3 Chat plan after a tunnel changes. */
export function refreshManagedTunnelUsage() {
  const accountId = appAtomRegistry.get(managedRelaySessionAtom)?.accountId;
  if (!accountId) return;
  managedRelayQueryManager.refreshEnvironments(appAtomRegistry, accountId);
  managedRelayQueryManager.refreshT3ChatLink(appAtomRegistry, accountId);
}
