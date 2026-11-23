import { describe, expect, it } from "@effect/vitest";

import { presentConnectionDiagnosis } from "./diagnosis.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type SupervisorConnectionState,
} from "./model.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const diagnose = (state: SupervisorConnectionState) =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state });

const results = (state: SupervisorConnectionState) =>
  diagnose(state)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  it("names the server when the host did not answer", () => {
    const failure = new ConnectionTransientError({
      reason: "endpoint-unavailable",
      detail: "Mac mini did not answer.",
      hop: "server",
    });
    expect(diagnose(backoff(failure))?.headline).toBe(
      "Mac mini 上的 Fleet ADE 没有响应",
    );
    expect(results(backoff(failure))).toEqual(["device:ok", "server:failed"]);
  });

  it("blames this device when a failure hops at it", () => {
    const failure = new ConnectionTransientError({
      reason: "endpoint-unavailable",
      detail: "Could not prepare the connection.",
      hop: "device",
    });
    expect(results(backoff(failure))).toEqual(["device:failed", "server:unchecked"]);
  });

  it("reports this device as offline before any other hop", () => {
    const state = {
      ...backoff(
        new ConnectionTransientError({
          reason: "endpoint-unavailable",
          detail: "Mac mini did not answer.",
          hop: "server",
        }),
      ),
      network: "offline" as const,
    };
    expect(diagnose(state)?.headline).toBe("此设备离线");
    expect(results(state)?.[0]).toBe("device:failed");
  });

  it("does not report hops as working when the failure names none", () => {
    const failure = new ConnectionBlockedError({
      reason: "authentication",
      detail: "此地址是 T3 Connect 学习到的。请重新配对该环境。",
    });
    expect(results(backoff(failure))).not.toContainEqual(expect.stringMatching(/:ok$/));
  });

  it("names an outdated host and its remedy", () => {
    const failure = new ConnectionBlockedError({
      reason: "unsupported",
      detail: "Server is outdated.",
      serverUpdateRequired: true,
    });
    const diagnosis = diagnose(backoff(failure));
    expect(diagnosis?.headline).toBe("Mac mini 运行的 Fleet ADE 版本较旧");
    expect(diagnosis?.steps.join(" ")).toContain("请更新 Mac mini 上的 Fleet ADE");
  });
});
