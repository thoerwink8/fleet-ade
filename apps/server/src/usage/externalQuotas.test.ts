import { describe, expect, it } from "@effect/vitest";

import {
  agyChildEnv,
  parseAgyQuota,
  parseMagpieQuotas,
  parseMagpieUsage,
  quotaFailureMessage,
} from "./externalQuotas.ts";

const agy = {
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              remaining_fraction: 0.42,
              reset_time: "2026-11-21T14:52:07Z",
            },
            {
              id: "gemini-5h",
              remaining_fraction: 0.8,
              reset_time: "2026-11-15T10:52:07Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", remaining_fraction: 0.5, reset_time: "2026-11-22T04:32:49Z" },
            { id: "3p-5h", remaining_fraction: 0.1, reset_time: "2026-11-15T09:32:49Z" },
          ],
        },
      ],
    },
  },
};

describe("parseAgyQuota", () => {
  it("reads both groups and their windows", () => {
    expect(parseAgyQuota(agy)).toEqual({
      ok: true,
      groups: [
        {
          name: "Gemini",
          windows: [
            { label: "周额度", remainingPercent: 42, resetsAt: "2026-11-21T14:52:07Z" },
            { label: "5 小时额度", remainingPercent: 80, resetsAt: "2026-11-15T10:52:07Z" },
          ],
        },
        {
          name: "Claude 与 GPT",
          windows: [
            { label: "周额度", remainingPercent: 50, resetsAt: "2026-11-22T04:32:49Z" },
            { label: "5 小时额度", remainingPercent: 10, resetsAt: "2026-11-15T09:32:49Z" },
          ],
        },
      ],
    });
  });

  it("does not invent a full quota when the payload is unusable", () => {
    expect(parseAgyQuota(null)).toEqual({ ok: false, message: "读取失败：输出不是额度数据" });
    expect(parseAgyQuota({ command: { data: { groups: [{ buckets: [{}] }] } } })).toEqual({
      ok: false,
      message: "读取失败：额度窗口缺少剩余比例",
    });
  });
});

const autoSettings = {
  line: "auto" as const,
  proxyUrl: "",
  noProxy: "",
  extraCaCertPath: "",
  agentOverrides: {},
};

describe("agy quota failures", () => {
  it("names a missing binary, a timeout, a bad exit, and keeps stderr", () => {
    expect(
      quotaFailureMessage("agy", Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" })),
    ).toBe("读取失败：找不到 agy");
    expect(
      quotaFailureMessage(
        "agy",
        Object.assign(new Error("Command failed: agy -p /quota --output-format json\n"), {
          signal: "SIGTERM",
          stderr: "dial tcp: i/o timeout",
        }),
      ),
    ).toBe("读取失败：agy 没有在时限内返回额度：dial tcp: i/o timeout");
    const stderr = "not json\n".repeat(40);
    const message = quotaFailureMessage(
      "agy",
      Object.assign(new Error("Command failed: agy -p /quota --output-format json\n"), {
        code: 1,
        stderr,
      }),
    );
    expect(
      message.startsWith("读取失败：Command failed: agy -p /quota --output-format json："),
    ).toBe(true);
    expect(
      message.length - "读取失败：Command failed: agy -p /quota --output-format json：".length,
    ).toBe(200);
  });

  it("passes the system proxy through because execFile skips the spawn patch", () => {
    const env = agyChildEnv(
      { PATH: "C:\\Windows\\System32", HTTP_PROXY: "http://stripped.example:1" },
      {
        settings: autoSettings,
        system: {
          proxyUrl: "http://127.0.0.1:7890",
          noProxy: "localhost",
          detail: "来自系统代理",
          available: true,
        },
        agents: [],
      },
    );
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.MSYS_NO_PATHCONV).toBe("1");
  });
});

describe("parseMagpieQuotas", () => {
  it("keeps remaining percent and reset time", () => {
    expect(
      parseMagpieQuotas({
        data: [
          {
            name: "Claude Code",
            windows: [{ name: "5 hours", remaining: 80, resetsAt: "2026-11-15T18:00:00Z" }],
          },
        ],
      }),
    ).toEqual({
      ok: true,
      groups: [
        {
          name: "Claude Code",
          windows: [
            { label: "5 小时额度", remainingPercent: 80, resetsAt: "2026-11-15T18:00:00Z" },
          ],
        },
      ],
    });
  });

  it("fails closed when the body is not a quota list", () => {
    expect(parseMagpieQuotas({ data: [] }).ok).toBe(false);
    expect(parseMagpieQuotas("down")).toEqual({
      ok: false,
      message: "读取失败：输出不是额度数据",
    });
  });
});

describe("parseMagpieUsage", () => {
  it("sums tokens per agent and model", () => {
    expect(
      parseMagpieUsage({
        agents: [{ id: "omp", name: "omp", calls: 3, input: 10, output: 4, cost: 0.2 }],
        models: [{ model: "gpt", calls: 3, input: 10, output: 4, cache_read: 6, cost: 0.2 }],
      }),
    ).toEqual({
      ok: true,
      agents: [{ name: "omp", calls: 3, tokens: 14, costUsd: 0.2 }],
      models: [{ name: "gpt", calls: 3, tokens: 20, costUsd: 0.2 }],
    });
  });

  it("fails closed when the usage shape is missing", () => {
    expect(parseMagpieUsage({})).toEqual({ ok: false, message: "读取失败：输出不是用量数据" });
  });
});
