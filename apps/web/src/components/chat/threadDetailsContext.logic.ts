import { formatContextWindowTokens } from "../../lib/contextWindow";
import { formatHeaderCostUsd } from "./threadHeaderMeta.logic";

export interface ContextDetailUsage {
  readonly inputTokens?: number | null | undefined;
  readonly cachedInputTokens?: number | null | undefined;
  readonly outputTokens?: number | null | undefined;
  readonly reasoningOutputTokens?: number | null | undefined;
  readonly promptCacheExpiresAt?: string | null | undefined;
  readonly sessionCostUsd?: number | null | undefined;
}

export interface ContextDetailRow {
  readonly key: "cache-hit" | "turn-output" | "prompt-cache" | "session-cost";
  readonly label: string;
  readonly fill: number | null;
  readonly value: string;
  readonly tooltipLines: readonly string[];
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function buildContextDetailRows(
  usage: ContextDetailUsage,
  nowMs: number,
): readonly ContextDetailRow[] {
  const rows: ContextDetailRow[] = [];

  const inputTokens = finiteNonNegative(usage.inputTokens);
  const cachedInputTokens = finiteNonNegative(usage.cachedInputTokens);
  if (inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null) {
    const percent = Math.round(Math.max(0, Math.min(100, (cachedInputTokens / inputTokens) * 100)));
    rows.push({
      key: "cache-hit",
      label: "缓存命中",
      fill: percent,
      value: `${percent}%`,
      tooltipLines: [
        `缓存命中：${percent}%`,
        `命中 ${cachedInputTokens.toLocaleString("en-US")} / 输入 ${inputTokens.toLocaleString("en-US")} 词元`,
      ],
    });
  }

  const outputTokens = finiteNonNegative(usage.outputTokens);
  if (outputTokens !== null) {
    const reasoningOutputTokens = finiteNonNegative(usage.reasoningOutputTokens);
    const tooltipLines = [`本轮输出：${outputTokens.toLocaleString("en-US")} 词元`];
    if (reasoningOutputTokens !== null && reasoningOutputTokens > 0) {
      tooltipLines.push(`其中推理 ${reasoningOutputTokens.toLocaleString("en-US")} 词元`);
    }
    rows.push({
      key: "turn-output",
      label: "本轮输出",
      fill: null,
      value: formatContextWindowTokens(outputTokens),
      tooltipLines,
    });
  }

  if (typeof usage.promptCacheExpiresAt === "string" && usage.promptCacheExpiresAt.trim() !== "") {
    const expiresAtMs = Date.parse(usage.promptCacheExpiresAt);
    if (Number.isFinite(expiresAtMs) && Number.isFinite(nowMs)) {
      const remainingMs = expiresAtMs - nowMs;
      if (remainingMs <= 0) {
        rows.push({
          key: "prompt-cache",
          label: "提示缓存",
          fill: null,
          value: "已过期",
          tooltipLines: ["提示缓存：已过期"],
        });
      } else {
        const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
        const value = `约 ${remainingMinutes} 分钟后过期`;
        rows.push({
          key: "prompt-cache",
          label: "提示缓存",
          fill: null,
          value,
          tooltipLines: [`提示缓存：${value}`],
        });
      }
    }
  }

  const sessionCost = formatHeaderCostUsd(usage.sessionCostUsd);
  if (sessionCost !== null) {
    rows.push({
      key: "session-cost",
      label: "本会话花费",
      fill: null,
      value: sessionCost,
      tooltipLines: [`本会话花费：${sessionCost}`, "按用量页口径计费"],
    });
  }

  return rows;
}
