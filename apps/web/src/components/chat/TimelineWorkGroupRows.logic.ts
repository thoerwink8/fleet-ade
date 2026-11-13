import { formatDuration } from "@t3tools/shared/orchestrationTiming";

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} 秒`;
  }

  return formatDuration(elapsedSeconds * 1_000);
}

export function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0 秒";
}

export const AGENT_OUTPUT_SILENCE_MS = 60_000;

export function formatAgentOutputSilence(silenceSinceIso: string, nowMs: number): string | null {
  const startedAtMs = Date.parse(silenceSinceIso);
  if (!Number.isFinite(startedAtMs)) return null;
  const silentMs = nowMs - startedAtMs;
  if (silentMs < AGENT_OUTPUT_SILENCE_MS) return null;
  const seconds = Math.floor(silentMs / 1000);
  return `智能体 ${seconds} 秒没有输出。可能连不上网，检查 设置→网络。`;
}

export function agentOutputSilenceSince(input: {
  readonly turnStartedAt: string | null;
  readonly agentOutputAt: readonly string[];
  readonly outputInFlight: boolean;
}): string | null {
  if (input.outputInFlight) return null;
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestIso: string | null = null;
  for (const iso of input.agentOutputAt) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms) || ms < latestMs) continue;
    latestMs = ms;
    latestIso = iso;
  }
  if (latestIso !== null) return latestIso;
  if (input.turnStartedAt !== null && Number.isFinite(Date.parse(input.turnStartedAt))) {
    return input.turnStartedAt;
  }
  return null;
}
