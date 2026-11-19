import { describe, expect, it } from "vite-plus/test";

import { resolveFirstRunDecision, transitionFirstRunGateState } from "./firstRun.logic";

const confirmedWorkspace = {
  enabled: true,
  hydrated: true,
  completed: false,
  bootstrapped: true,
  authoritative: true,
  workspaceAuthoritative: true,
  catalogReady: true,
  serverConfigAvailable: true,
} as const;

describe("resolveFirstRunDecision", () => {
  it("opens the session page for a confirmed fresh workspace", () => {
    expect(resolveFirstRunDecision(confirmedWorkspace)).toEqual({
      decision: "app",
      persistCompletion: true,
    });
  });

  it("does not permanently complete onboarding before the server confirms the workspace", () => {
    expect(
      resolveFirstRunDecision({
        ...confirmedWorkspace,
        authoritative: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });

  it("backfills completion once the server confirms an existing workspace", () => {
    expect(resolveFirstRunDecision(confirmedWorkspace)).toEqual({
      decision: "app",
      persistCompletion: true,
    });
  });

  it("enters the app while bootstrap provenance is still pending", () => {
    expect(
      resolveFirstRunDecision({
        ...confirmedWorkspace,
        workspaceAuthoritative: false,
      }),
    ).toEqual({ decision: "app", persistCompletion: false });
  });

  it("does not wait for server data after onboarding is already complete", () => {
    expect(
      resolveFirstRunDecision({
        ...confirmedWorkspace,
        authoritative: false,
        bootstrapped: false,
        completed: true,
        serverConfigAvailable: false,
      }),
    ).toEqual({
      decision: "app",
      persistCompletion: false,
    });
  });

  it("waits until client settings have loaded", () => {
    expect(
      resolveFirstRunDecision({
        ...confirmedWorkspace,
        hydrated: false,
      }),
    ).toEqual({ decision: "pending", persistCompletion: false });
  });
});

describe("transitionFirstRunGateState", () => {
  it("shows recovery without mounting the app when evidence stalls", () => {
    expect(
      transitionFirstRunGateState({ decision: "pending", stalled: false }, { type: "timeout" }),
    ).toEqual({ decision: "pending", stalled: true });
  });

  it("updates pending to app when settings have loaded", () => {
    expect(
      transitionFirstRunGateState(
        { decision: "pending", stalled: false },
        { type: "evidence", decision: "app" },
      ),
    ).toEqual({ decision: "app", stalled: false });
  });

  // regression: #19680 unchanged gate evidence must not produce a new state
  it.each(["pending", "app"] as const)(
    "preserves state identity for unchanged %s evidence",
    (decision) => {
      const state = { decision, stalled: false };
      expect(transitionFirstRunGateState(state, { type: "evidence", decision })).toBe(state);
    },
  );
});
