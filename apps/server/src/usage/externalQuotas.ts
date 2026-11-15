// @effect-diagnostics nodeBuiltinImport:off unknownInEffectCatch:off anyUnknownInErrorContext:off globalFetchInEffect:off -- agy is an external CLI; execFile keeps stderr and the timeout, and magpie failures stay text.
import * as NodeChildProcess from "node:child_process";

import type {
  ExternalQuotaGroups,
  ExternalQuotaWindow,
  ExternalUsageReport,
  ExternalUsageRow,
} from "@t3tools/contracts";
import {
  applyAgentNetworkEnvironment,
  type AgentNetworkSettings,
  type KnownAgentBinary,
  type SystemProxyRead,
} from "@t3tools/provider-core/server/networkEnvironment";
import * as Effect from "effect/Effect";

import { currentNetworkSnapshot } from "../network/snapshot.ts";

const MAGPIE_ORIGIN = "http://127.0.0.1:3425";
const AGY_TIMEOUT_MS = 20_000;

const AGY_WINDOW_LABELS: Readonly<Record<string, string>> = {
  "gemini-weekly": "周额度",
  "gemini-5h": "5 小时额度",
  "3p-weekly": "周额度",
  "3p-5h": "5 小时额度",
};

const AGY_GROUP_LABELS: Readonly<Record<string, string>> = {
  "gemini-weekly": "Gemini",
  "gemini-5h": "Gemini",
  "3p-weekly": "Claude 与 GPT",
  "3p-5h": "Claude 与 GPT",
};

function externalQuotaFailure(message: string): ExternalQuotaGroups {
  return { ok: false, message };
}

function externalUsageFailure(message: string): ExternalUsageReport {
  return { ok: false, message };
}

function stderrExcerpt(error: unknown): string {
  if (error === null || typeof error !== "object") return "";
  const stderr = Reflect.get(error, "stderr");
  if (typeof stderr !== "string") return "";
  return stderr.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function quotaFailureMessage(prefix: string, error: unknown): string {
  if (isUnavailable(error)) return prefix === "magpie" ? "magpie 未运行" : "读取失败：找不到 agy";
  const stderr = stderrExcerpt(error);
  const detail = stderr.length > 0 ? `：${stderr}` : "";
  if (error instanceof Error && Reflect.get(error, "signal") === "SIGTERM") {
    return `读取失败：agy 没有在时限内返回额度${detail}`;
  }
  const text = error instanceof Error ? error.message : "未知原因";
  const line = text.split("\n")[0]?.trim().slice(0, 180) || "未知原因";
  return `读取失败：${line}${detail}`;
}

function isUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown): boolean => {
    if (value == null || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const code = Reflect.get(value, "code");
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ENOENT") return true;
    if (walk(Reflect.get(value, "cause"))) return true;
    const errors = Reflect.get(value, "errors");
    return Array.isArray(errors) && errors.some((entry) => walk(entry));
  };
  return walk(error);
}

function remainingPercent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

function windowFromBucket(bucket: unknown): ExternalQuotaWindow | null {
  if (bucket === null || typeof bucket !== "object") return null;
  const fraction = Reflect.get(bucket, "remaining_fraction");
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  const id = Reflect.get(bucket, "id");
  const reset = Reflect.get(bucket, "reset_time");
  const key = typeof id === "string" ? id : "";
  return {
    label: AGY_WINDOW_LABELS[key] ?? "额度",
    remainingPercent: remainingPercent(fraction),
    ...(typeof reset === "string" && reset.length > 0 ? { resetsAt: reset } : {}),
  };
}

/** Official `agy -p /quota --output-format json`. A bad payload is a failure, never a full bar. */
export function parseAgyQuota(payload: unknown): ExternalQuotaGroups {
  const command =
    payload !== null && typeof payload === "object" ? Reflect.get(payload, "command") : undefined;
  const data =
    command !== null && typeof command === "object" ? Reflect.get(command, "data") : undefined;
  const groups =
    data !== null && typeof data === "object" ? Reflect.get(data, "groups") : undefined;
  if (!Array.isArray(groups)) return externalQuotaFailure("读取失败：输出不是额度数据");

  const byName = new Map<string, ExternalQuotaWindow[]>();
  for (const group of groups) {
    if (group === null || typeof group !== "object") continue;
    const buckets = Reflect.get(group, "buckets");
    if (!Array.isArray(buckets)) continue;
    for (const bucket of buckets) {
      const window = windowFromBucket(bucket);
      if (window === null) return externalQuotaFailure("读取失败：额度窗口缺少剩余比例");
      const id = Reflect.get(bucket, "id");
      const name =
        (typeof id === "string" ? AGY_GROUP_LABELS[id] : undefined) ??
        (typeof Reflect.get(group, "name") === "string"
          ? String(Reflect.get(group, "name"))
          : "额度");
      const list = byName.get(name) ?? [];
      list.push(window);
      byName.set(name, list);
    }
  }
  if (byName.size === 0) return externalQuotaFailure("读取失败：没有额度窗口");
  return {
    ok: true,
    groups: [...byName.entries()].map(([name, windows]) => ({ name, windows })),
  };
}

function quotaWindow(entry: unknown): ExternalQuotaWindow | null {
  if (entry === null || typeof entry !== "object") return null;
  const remaining = Reflect.get(entry, "remaining");
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  const name = Reflect.get(entry, "name");
  const resetsAt = Reflect.get(entry, "resetsAt");
  const raw = typeof name === "string" && name.length > 0 ? name : "额度";
  const hours = /^(\d+) hours?\b/.exec(raw);
  const days = /^(\d+) days?\b/.exec(raw);
  const label = hours
    ? raw.replace(hours[0], `${hours[1]} 小时额度`)
    : days
      ? raw.replace(days[0], Number(days[1]) === 7 ? "周额度" : `${days[1]} 日额度`)
      : raw;
  return {
    label,
    remainingPercent: Math.round(remaining * 10) / 10,
    ...(typeof resetsAt === "string" && resetsAt.length > 0 ? { resetsAt } : {}),
  };
}

export function parseMagpieQuotas(payload: unknown): ExternalQuotaGroups {
  const data =
    payload !== null && typeof payload === "object" ? Reflect.get(payload, "data") : undefined;
  if (!Array.isArray(data)) return externalQuotaFailure("读取失败：输出不是额度数据");
  const groups = data.flatMap((provider) => {
    if (provider === null || typeof provider !== "object") return [];
    const windows = Reflect.get(provider, "windows");
    if (!Array.isArray(windows)) return [];
    const parsed = windows.flatMap((window) => {
      const next = quotaWindow(window);
      return next === null ? [] : [next];
    });
    if (parsed.length === 0) return [];
    const name = Reflect.get(provider, "name");
    return [
      {
        name: typeof name === "string" && name.length > 0 ? name : "渠道",
        windows: parsed,
      },
    ];
  });
  if (groups.length === 0) return externalQuotaFailure("读取失败：没有额度窗口");
  return { ok: true, groups };
}

function usageRow(entry: unknown): ExternalUsageRow | null {
  if (entry === null || typeof entry !== "object") return null;
  const calls = Reflect.get(entry, "calls");
  const cost = Reflect.get(entry, "cost");
  if (typeof calls !== "number" || typeof cost !== "number") return null;
  const parts = ["input", "output", "cache_read", "cache_write"] as const;
  let tokens = 0;
  for (const key of parts) {
    const value = Reflect.get(entry, key);
    if (typeof value === "number" && Number.isFinite(value) && value > 0) tokens += value;
  }
  const name = Reflect.get(entry, "name");
  const model = Reflect.get(entry, "model");
  const id = Reflect.get(entry, "id");
  const label =
    typeof name === "string" && name.length > 0
      ? name
      : typeof model === "string" && model.length > 0
        ? model
        : typeof id === "string"
          ? id
          : "";
  if (label.length === 0) return null;
  return { name: label, calls, tokens, costUsd: cost };
}

export function parseMagpieUsage(payload: unknown): ExternalUsageReport {
  if (payload === null || typeof payload !== "object") {
    return externalUsageFailure("读取失败：输出不是用量数据");
  }
  const agents = Reflect.get(payload, "agents");
  const models = Reflect.get(payload, "models");
  if (!Array.isArray(agents) || !Array.isArray(models)) {
    return externalUsageFailure("读取失败：输出不是用量数据");
  }
  return {
    ok: true,
    agents: agents.flatMap((entry) => {
      const row = usageRow(entry);
      return row === null ? [] : [row];
    }),
    models: models.flatMap((entry) => {
      const row = usageRow(entry);
      return row === null ? [] : [row];
    }),
  };
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  return JSON.parse(start < 0 ? text : text.slice(start));
}

export function agyChildEnv(
  hostEnv: Readonly<Record<string, string | undefined>>,
  snapshot: {
    readonly settings: AgentNetworkSettings;
    readonly system: SystemProxyRead;
    readonly agents: readonly KnownAgentBinary[];
  },
): Record<string, string> {
  return applyAgentNetworkEnvironment({
    hostEnv: { ...hostEnv, MSYS_NO_PATHCONV: "1" },
    settings: snapshot.settings,
    systemProxy: snapshot.system,
    target: { command: "agy", args: ["-p", "/quota", "--output-format", "json"] },
    agents: snapshot.agents,
  });
}

const runAgy = Effect.tryPromise({
  try: () =>
    new Promise<string>((resolve, reject) => {
      // execFile keeps Node's own spawn, so the network patch never sees this call.
      const env = agyChildEnv(process.env, currentNetworkSnapshot());
      NodeChildProcess.execFile(
        "agy",
        ["-p", "/quota", "--output-format", "json"],
        {
          timeout: AGY_TIMEOUT_MS,
          maxBuffer: 1_000_000,
          windowsHide: true,
          encoding: "utf8",
          env,
        },
        (error, out, err) => {
          if (error) {
            if (typeof err === "string" && err.length > 0) Reflect.set(error, "stderr", err);
            reject(error);
            return;
          }
          resolve(out);
        },
      );
    }),
  catch: (cause) => cause,
});

export const readAgyQuota = Effect.fn("readAgyQuota")(function* () {
  return yield* runAgy.pipe(
    Effect.match({
      onFailure: (error) => externalQuotaFailure(quotaFailureMessage("agy", error)),
      onSuccess: (text) => {
        try {
          return parseAgyQuota(parseJson(text));
        } catch {
          return externalQuotaFailure("读取失败：输出不是额度数据");
        }
      },
    }),
  );
});

const fetchMagpie = (path: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(`${MAGPIE_ORIGIN}${path}`).then(async (response) => {
        if (!response.ok) throw new Error(`状态 ${response.status}`);
        return response.json() as Promise<unknown>;
      }),
    catch: (cause) => cause,
  });

export const readMagpieQuotas = Effect.fn("readMagpieQuotas")(function* () {
  return yield* fetchMagpie("/v1/magpie/quotas").pipe(
    Effect.match({
      onFailure: (error) => externalQuotaFailure(quotaFailureMessage("magpie", error)),
      onSuccess: (payload) => parseMagpieQuotas(payload),
    }),
  );
});

export const readMagpieUsage = Effect.fn("readMagpieUsage")(function* () {
  return yield* fetchMagpie("/v1/magpie/usage?period=today").pipe(
    Effect.match({
      onFailure: (error) => externalUsageFailure(quotaFailureMessage("magpie", error)),
      onSuccess: (payload) => parseMagpieUsage(payload),
    }),
  );
});
