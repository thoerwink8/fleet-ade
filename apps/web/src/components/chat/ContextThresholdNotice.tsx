import {
  contextThresholdPercentFromConfig,
  contextThresholdPrompts,
  sessionContextThreshold,
} from "@t3tools/shared/contextThreshold";
import { formatCountWan } from "@t3tools/shared/usageFormat";

export function ContextThresholdNotice({
  usedTokens,
  maxTokens,
  autoCompactThreshold,
  config,
  driver,
}: {
  readonly usedTokens: number | null;
  readonly maxTokens: number | null;
  readonly autoCompactThreshold: number | null;
  readonly config: unknown;
  readonly driver: string | null;
}) {
  if (usedTokens == null) return null;
  const view = sessionContextThreshold({
    usedTokens,
    maxTokens,
    autoCompactThreshold,
    percentRaw: contextThresholdPercentFromConfig(config),
  });
  // The header shows the share of the window; this line only speaks once the threshold is crossed.
  if (view.thresholdTokens == null || !view.over) return null;
  const prompt = contextThresholdPrompts(driver);
  return (
    <p className="px-3 pb-1 text-meta text-muted-foreground">
      {`上下文 已用 ${formatCountWan(usedTokens)} / 阈值 ${formatCountWan(view.thresholdTokens)}`}
      {prompt ? "。已超过阈值，建议压缩或新开一轮。" : null}
    </p>
  );
}
