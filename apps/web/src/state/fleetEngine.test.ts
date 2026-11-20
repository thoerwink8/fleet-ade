import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  dismissedFleetEngineFailureAtom,
  reconcileFleetEngineFailureDismissal,
  resolveFleetEngineFailure,
  shouldShowFleetEngineFailure,
} from "./fleetEngine";

const environmentId = EnvironmentId.make("environment-local");

describe("fleet engine failure dismissal", () => {
  it("keeps the same failure dismissed across chat mounts until recovery or another failure", () => {
    vi.useFakeTimers();
    try {
      const registry = AtomRegistry.make();
      const dismissal = dismissedFleetEngineFailureAtom(environmentId);
      const failure = resolveFleetEngineFailure({
        status: null,
        error: "Transport error (GET )",
      });
      expect(failure?.kind).toBe("unreachable");
      expect(shouldShowFleetEngineFailure(failure, null)).toBe(true);

      const unmountFirstChat = registry.mount(dismissal);
      registry.set(dismissal, failure?.kind ?? null);
      unmountFirstChat();
      vi.runAllTimers();
      const unmountSecondChat = registry.mount(dismissal);
      expect(shouldShowFleetEngineFailure(failure, registry.get(dismissal))).toBe(false);
      expect(
        shouldShowFleetEngineFailure(
          resolveFleetEngineFailure({ status: null, error: "Request timed out" }),
          registry.get(dismissal),
        ),
      ).toBe(true);
      expect(shouldShowFleetEngineFailure(null, registry.get(dismissal))).toBe(false);
      unmountSecondChat();
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("classifies engine failures without exposing raw transport text", () => {
    const status = {
      configured: true,
      reachable: true,
      body: null,
      checkedAt: "2026-11-20T00:00:00.000Z",
      reason: null,
    };
    expect(
      resolveFleetEngineFailure({ status: { ...status, httpStatus: 401 }, error: null }),
    ).toMatchObject({ kind: "authentication" });
    expect(
      resolveFleetEngineFailure({ status: { ...status, httpStatus: 500 }, error: null }),
    ).toMatchObject({ kind: "server" });
    expect(
      resolveFleetEngineFailure({
        status: {
          ...status,
          reachable: false,
          httpStatus: null,
          reason: "Remote environment endpoint timed out after 15000ms.",
        },
        error: null,
      }),
    ).toMatchObject({ kind: "timeout", description: "连接引擎超时，请检查引擎是否正常。" });
    expect(
      resolveFleetEngineFailure({
        status: { ...status, reachable: true, httpStatus: 200 },
        error: null,
      }),
    ).toBeNull();
    expect(reconcileFleetEngineFailureDismissal({ status: null, error: null }, "unreachable")).toBe(
      "unreachable",
    );
    expect(
      reconcileFleetEngineFailureDismissal(
        { status: { ...status, reachable: true, httpStatus: 200 }, error: null },
        "unreachable",
      ),
    ).toBeNull();
    expect(
      reconcileFleetEngineFailureDismissal(
        { status: { ...status, httpStatus: 500 }, error: null },
        "unreachable",
      ),
    ).toBe("unreachable");
  });
});
