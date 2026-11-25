import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironment } from "../../state/environments";
import {
  type AgentSetupCardModel,
  resolveAgentSetupCard,
  toAgentSetupProvider,
} from "./agentSetupCard.logic";

/** The setup card for one computer, or null while any agent there can be used. */
export function useAgentSetupCard(input: {
  readonly environmentId: EnvironmentId;
  readonly providers: readonly ServerProvider[];
  readonly catalogKnown: boolean;
}): AgentSetupCardModel | null {
  const environment = useEnvironment(input.environmentId);
  const providerInstances = useEnvironmentSettings(
    input.environmentId,
    (settings) => settings.providerInstances,
  );
  return resolveAgentSetupCard({
    providers: input.providers.map(toAgentSetupProvider),
    catalogKnown: input.catalogKnown,
    computerName:
      environment?.entry.target._tag === "PrimaryConnectionTarget"
        ? null
        : (environment?.label ?? null),
    configuredInstanceIds: new Set(Object.keys(providerInstances ?? {})),
  });
}
