import {
  contextThresholdPercentFromConfig,
  contextThresholdPrompts,
  sessionContextThreshold,
} from "@t3tools/shared/contextThreshold";

function formatCount(value: number): string {
  if (value >= 10_000) {
    const wan = value / 10_000;
    const text = wan >= 10 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, "");
    return `${text}万`;
  }
  return String(Math.round(value));
}

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
  if (view.thresholdTokens == null) return null;
  const prompt = view.over && contextThresholdPrompts(driver);
  return (
    <p className="px-3 pb-1 text-xs text-muted-foreground">
      {`上下文 已用 ${formatCount(usedTokens)} / 阈值 ${formatCount(view.thresholdTokens)}`}
      {prompt ? "。已超过阈值，建议压缩或新开一轮。" : null}
    </p>
  );
}
