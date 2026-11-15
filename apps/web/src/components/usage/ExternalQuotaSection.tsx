import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { ExternalQuotaCards } from "./ExternalQuotaCards";

const LOCAL_PROVIDER_LABEL: Readonly<Record<UsageProviderKind, string>> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  pi: "Pi",
  muse: "Muse",
};

function formatCount(value: number): string {
  if (value >= 10_000) {
    const wan = value / 10_000;
    const text = wan >= 10 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, "");
    return `${text}万`;
  }
  return String(Math.round(value));
}

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
  const localLines = localProviders.map(
    (provider) =>
      `${LOCAL_PROVIDER_LABEL[provider.provider]}：${provider.records} 次，${formatCount(provider.totalTokens)} token`,
  );
  return (
    <ExternalQuotaCards
      agy={query.data?.agy ?? null}
      magpieQuotas={query.data?.magpieQuotas ?? null}
      magpieUsage={query.data?.magpieUsage ?? null}
      localLines={localLines}
      pending={query.isPending}
      onRefresh={() => query.refresh()}
    />
  );
}
