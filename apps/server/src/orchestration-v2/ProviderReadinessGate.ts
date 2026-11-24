import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";

/**
 * A status checked longer ago than this is re-probed before it can refuse a send. The background
 * check runs every 5 minutes and re-checks a failed result after 30 seconds, so a refusal based on
 * anything older than that recheck delay may predate a sign-in the user just finished.
 */
export const PROVIDER_STATUS_FRESH_WINDOW_MS = 30_000;

type RegistryService = ProviderRegistry.ProviderRegistry["Service"];

/** Why a send must be refused for this status, or null. Antigravity's unknown sign-in state is allowed. */
function providerRefusalReason(provider: ServerProvider): string | null {
  const agentName = provider.displayName?.trim() || provider.instanceId;
  if (!provider.installed) return `这台电脑上没装 ${agentName}。`;
  if (provider.auth.status === "unauthenticated") return `${agentName} 需要重新登录。`;
  return null;
}

/**
 * The refusal for a send to this instance, or null when it may go out. The cached status decides
 * the normal path without a probe. Only when it would refuse, and was not just checked, the
 * instance is probed once more; the registry publishes that result to clients.
 */
export const providerRefusal = Effect.fn("ProviderReadinessGate.providerRefusal")(function* (
  registry: RegistryService,
  instanceId: ProviderInstanceId,
) {
  const cached = (yield* registry.getProviders).find((entry) => entry.instanceId === instanceId);
  if (cached === undefined) return null;
  const cachedReason = providerRefusalReason(cached);
  if (cachedReason === null) return null;
  const checkedAt = Date.parse(cached.checkedAt);
  const now = yield* Clock.currentTimeMillis;
  if (Number.isFinite(checkedAt) && now - checkedAt <= PROVIDER_STATUS_FRESH_WINDOW_MS) {
    return cachedReason;
  }
  const probed = (yield* registry.refreshInstance(instanceId)).find(
    (entry) => entry.instanceId === instanceId,
  );
  return probed === undefined ? null : providerRefusalReason(probed);
});
