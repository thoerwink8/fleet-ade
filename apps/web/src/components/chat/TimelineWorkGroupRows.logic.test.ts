import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_OUTPUT_SILENCE_MS,
  agentOutputSilenceSince,
  formatAgentOutputSilence,
} from "./TimelineWorkGroupRows.logic";

const since = "2026-01-01T00:00:00.000Z";
const startMs = Date.parse(since);

describe("agent output silence", () => {
  it("stays quiet until a running turn has produced nothing for the threshold", () => {
    expect(formatAgentOutputSilence(since, startMs + AGENT_OUTPUT_SILENCE_MS - 1)).toBeNull();
    expect(formatAgentOutputSilence(since, startMs + AGENT_OUTPUT_SILENCE_MS)).toBe(
      "智能体 60 秒没有输出。可能连不上网，检查 设置→通用→网络。",
    );
    expect(formatAgentOutputSilence(since, startMs + 90_000)).toBe(
      "智能体 90 秒没有输出。可能连不上网，检查 设置→通用→网络。",
    );
    expect(formatAgentOutputSilence("not-a-time", startMs)).toBeNull();
  });

  it("holds the clock while output is in flight and resumes from the last output", () => {
    expect(
      agentOutputSilenceSince({
        turnStartedAt: since,
        agentOutputAt: ["2026-01-01T00:00:20.000Z"],
        outputInFlight: true,
      }),
    ).toBeNull();
    expect(
      agentOutputSilenceSince({
        turnStartedAt: since,
        agentOutputAt: ["2026-01-01T00:00:05.000Z", "2026-01-01T00:00:20.000Z"],
        outputInFlight: false,
      }),
    ).toBe("2026-01-01T00:00:20.000Z");
    expect(
      agentOutputSilenceSince({
        turnStartedAt: since,
        agentOutputAt: [],
        outputInFlight: false,
      }),
    ).toBe(since);
    expect(
      agentOutputSilenceSince({
        turnStartedAt: null,
        agentOutputAt: [],
        outputInFlight: false,
      }),
    ).toBeNull();
  });
});
