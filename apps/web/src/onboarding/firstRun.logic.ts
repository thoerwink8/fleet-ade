export type FirstRunDecision = "pending" | "app";

export interface FirstRunGateState {
  readonly decision: FirstRunDecision;
  readonly stalled: boolean;
}

type FirstRunGateEvent =
  | { readonly type: "evidence"; readonly decision: FirstRunDecision }
  | { readonly type: "timeout" };

interface FirstRunDecisionInput {
  readonly enabled: boolean;
  readonly hydrated: boolean;
  readonly completed: boolean;
  readonly bootstrapped: boolean;
  readonly authoritative: boolean;
  readonly workspaceAuthoritative: boolean;
  readonly catalogReady: boolean;
  readonly serverConfigAvailable: boolean;
}

export function transitionFirstRunGateState(
  state: FirstRunGateState,
  event: FirstRunGateEvent,
): FirstRunGateState {
  if (event.type === "timeout") {
    return state.decision === "pending" && !state.stalled ? { ...state, stalled: true } : state;
  }

  if (event.decision === "pending" || state.decision === event.decision) {
    return state;
  }

  return { decision: event.decision, stalled: false };
}

/** Completion waits until the server confirms the workspace, so a cached shell cannot mark a new install done. */
export function resolveFirstRunDecision(input: FirstRunDecisionInput): {
  readonly decision: FirstRunDecision;
  readonly persistCompletion: boolean;
} {
  if (!input.enabled || !input.hydrated) {
    return { decision: input.enabled ? "pending" : "app", persistCompletion: false };
  }
  if (input.completed) {
    return { decision: "app", persistCompletion: false };
  }
  return {
    decision: "app",
    persistCompletion:
      input.bootstrapped &&
      input.authoritative &&
      input.workspaceAuthoritative &&
      input.catalogReady &&
      input.serverConfigAvailable,
  };
}

export function resolveHostedFirstRunDecision(hydrated: boolean): {
  readonly decision: FirstRunDecision;
  readonly persistCompletion: boolean;
} {
  return { decision: hydrated ? "app" : "pending", persistCompletion: false };
}
