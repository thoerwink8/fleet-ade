import { describe, expect, it } from "vite-plus/test";

import {
  buildContextDetailRows,
  type ContextDetailRow,
  type ContextDetailUsage,
} from "./threadDetailsContext.logic";

const NOW_MS = Date.parse("2026-11-21T10:00:00.000Z");

describe("buildContextDetailRows", () => {
  it.each<{
    readonly name: string;
    readonly usage: ContextDetailUsage;
    readonly nowMs: number;
    readonly expected: readonly ContextDetailRow[];
  }>([
    {
      name: "all fields present with future cache expiry",
      usage: {
        inputTokens: 100_000,
        cachedInputTokens: 82_000,
        outputTokens: 3_400,
        reasoningOutputTokens: null,
        promptCacheExpiresAt: "2026-11-21T10:05:00.000Z",
      },
      nowMs: NOW_MS,
      expected: [
        {
          key: "cache-hit",
          label: "缓存命中",
          fill: 82,
          value: "82%",
          tooltipLines: ["缓存命中：82%", "命中 82,000 / 输入 100,000 词元"],
        },
        {
          key: "turn-output",
          label: "本轮输出",
          fill: null,
          value: "3.4k",
          tooltipLines: ["本轮输出：3,400 词元"],
        },
        {
          key: "prompt-cache",
          label: "提示缓存",
          fill: null,
          value: "约 5 分钟后过期",
          tooltipLines: ["提示缓存：约 5 分钟后过期"],
        },
      ],
    },
    {
      name: "only usedTokens (all detail fields missing)",
      usage: {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        promptCacheExpiresAt: null,
      },
      nowMs: NOW_MS,
      expected: [],
    },
    {
      name: "inputTokens is 0 omits cache-hit row",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 512,
        reasoningOutputTokens: null,
        promptCacheExpiresAt: null,
      },
      nowMs: NOW_MS,
      expected: [
        {
          key: "turn-output",
          label: "本轮输出",
          fill: null,
          value: "512",
          tooltipLines: ["本轮输出：512 词元"],
        },
      ],
    },
    {
      name: "promptCacheExpiresAt in the past shows expired",
      usage: {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        promptCacheExpiresAt: "2026-11-21T09:58:00.000Z",
      },
      nowMs: NOW_MS,
      expected: [
        {
          key: "prompt-cache",
          label: "提示缓存",
          fill: null,
          value: "已过期",
          tooltipLines: ["提示缓存：已过期"],
        },
      ],
    },
    {
      name: "includes reasoning tokens line in output tooltip",
      usage: {
        inputTokens: 50_000,
        cachedInputTokens: 25_000,
        outputTokens: 12_500,
        reasoningOutputTokens: 4_200,
        promptCacheExpiresAt: "2026-11-21T10:00:20.000Z",
      },
      nowMs: NOW_MS,
      expected: [
        {
          key: "cache-hit",
          label: "缓存命中",
          fill: 50,
          value: "50%",
          tooltipLines: ["缓存命中：50%", "命中 25,000 / 输入 50,000 词元"],
        },
        {
          key: "turn-output",
          label: "本轮输出",
          fill: null,
          value: "13k",
          tooltipLines: ["本轮输出：12,500 词元", "其中推理 4,200 词元"],
        },
        {
          key: "prompt-cache",
          label: "提示缓存",
          fill: null,
          value: "约 1 分钟后过期",
          tooltipLines: ["提示缓存：约 1 分钟后过期"],
        },
      ],
    },
  ])("$name", ({ usage, nowMs, expected }) => {
    expect(buildContextDetailRows(usage, nowMs)).toEqual(expected);
  });
});
