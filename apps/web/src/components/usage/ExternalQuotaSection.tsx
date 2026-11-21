import {
  RETIRED_USAGE_PROVIDER_KINDS,
  type EnvironmentId,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { formatCountWan } from "@t3tools/shared/usageFormat";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { ExternalQuotaCards } from "./ExternalQuotaCards";

const RETIRED_USAGE_PROVIDERS: ReadonlySet<string> = new Set(RETIRED_USAGE_PROVIDER_KINDS);

const LOCAL_PROVIDER_LABEL = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  antigravity: "Antigravity",
} as const;

export function ExternalQuotaSection({
  environmentId,
  localProviders,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly localProviders: ReadonlyArray<{
    readonly provider: UsageProviderKind;
    readonly totalTokens: number;
    readonly records: number;
  }>;
}) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.externalQuotas({ environmentId, input: {} }),
  );
  const localLines = localProviders.flatMap((provider) => {
    if (RETIRED_USAGE_PROVIDERS.has(provider.provider)) return [];
    const label = LOCAL_PROVIDER_LABEL[provider.provider as keyof typeof LOCAL_PROVIDER_LABEL];
    return [`${label}：${provider.records} 次，${formatCountWan(provider.totalTokens)} 词元`];
  });
  return (
    <ExternalQuotaCards
      agy={query.data?.agy ?? null}
      magpieQuotas={query.data?.magpieQuotas ?? null}
      magpieUsage={query.data?.magpieUsage ?? null}
      localLines={localLines}
      pending={query.isPending}
      error={query.error}
      onRefresh={() => query.refresh()}
    />
  );
}
