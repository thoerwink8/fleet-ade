export interface DeferredWorkLoadState {
  readonly status: "idle" | "loading" | "error";
  readonly autoRetriedOnReconnect: boolean;
  readonly awaitingReconnectRetry: boolean;
  readonly showManualRetry: boolean;
}

export const INITIAL_DEFERRED_WORK_LOAD_STATE: DeferredWorkLoadState = {
  status: "idle",
  autoRetriedOnReconnect: false,
  awaitingReconnectRetry: false,
  showManualRetry: false,
};

export function startDeferredWorkLoad(
  state: DeferredWorkLoadState,
  options?: { readonly manual?: boolean | undefined },
): DeferredWorkLoadState {
  return {
    status: "loading",
    autoRetriedOnReconnect: options?.manual ? false : state.autoRetriedOnReconnect,
    awaitingReconnectRetry: false,
    showManualRetry: false,
  };
}

export function succeedDeferredWorkLoad(): DeferredWorkLoadState {
  return INITIAL_DEFERRED_WORK_LOAD_STATE;
}

export function failDeferredWorkLoad(
  state: DeferredWorkLoadState,
  input: { readonly isConnected: boolean },
): DeferredWorkLoadState {
  const canAwaitReconnect = !state.autoRetriedOnReconnect;
  return {
    status: "error",
    autoRetriedOnReconnect: state.autoRetriedOnReconnect,
    awaitingReconnectRetry: canAwaitReconnect,
    showManualRetry: !canAwaitReconnect || input.isConnected,
  };
}

export function handleDeferredWorkReconnect(state: DeferredWorkLoadState): {
  readonly shouldRetry: boolean;
  readonly nextState: DeferredWorkLoadState;
} {
  if (state.status !== "error" || !state.awaitingReconnectRetry || state.autoRetriedOnReconnect) {
    return { shouldRetry: false, nextState: state };
  }
  return {
    shouldRetry: true,
    nextState: {
      status: "loading",
      autoRetriedOnReconnect: true,
      awaitingReconnectRetry: false,
      showManualRetry: false,
    },
  };
}

export function resetDeferredWorkLoad(): DeferredWorkLoadState {
  return INITIAL_DEFERRED_WORK_LOAD_STATE;
}
