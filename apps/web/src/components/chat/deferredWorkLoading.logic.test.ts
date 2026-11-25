import { describe, expect, it } from "vite-plus/test";

import {
  failDeferredWorkLoad,
  handleDeferredWorkReconnect,
  INITIAL_DEFERRED_WORK_LOAD_STATE,
  resetDeferredWorkLoad,
  startDeferredWorkLoad,
  succeedDeferredWorkLoad,
} from "./deferredWorkLoading.logic";

describe("deferredWorkLoading logic", () => {
  it("auto-retries strictly once on reconnect after failing disconnected, then shows manual retry button", () => {
    expect(INITIAL_DEFERRED_WORK_LOAD_STATE).toEqual({
      status: "idle",
      autoRetriedOnReconnect: false,
      awaitingReconnectRetry: false,
      showManualRetry: false,
    });

    const started = startDeferredWorkLoad(INITIAL_DEFERRED_WORK_LOAD_STATE);
    expect(started).toEqual({
      status: "loading",
      autoRetriedOnReconnect: false,
      awaitingReconnectRetry: false,
      showManualRetry: false,
    });

    const failedOffline = failDeferredWorkLoad(started, { isConnected: false });
    expect(failedOffline).toEqual({
      status: "error",
      autoRetriedOnReconnect: false,
      awaitingReconnectRetry: true,
      showManualRetry: false,
    });

    const firstReconnect = handleDeferredWorkReconnect(failedOffline);
    expect(firstReconnect).toEqual({
      shouldRetry: true,
      nextState: {
        status: "loading",
        autoRetriedOnReconnect: true,
        awaitingReconnectRetry: false,
        showManualRetry: false,
      },
    });

    const failedAgain = failDeferredWorkLoad(firstReconnect.nextState, { isConnected: true });
    expect(failedAgain).toEqual({
      status: "error",
      autoRetriedOnReconnect: true,
      awaitingReconnectRetry: false,
      showManualRetry: true,
    });

    const secondReconnect = handleDeferredWorkReconnect(failedAgain);
    expect(secondReconnect).toEqual({
      shouldRetry: false,
      nextState: failedAgain,
    });
  });

  it("shows manual retry button immediately when failing while connected and still auto-retries once on reconnect", () => {
    const started = startDeferredWorkLoad(INITIAL_DEFERRED_WORK_LOAD_STATE);
    const failedOnline = failDeferredWorkLoad(started, { isConnected: true });
    expect(failedOnline).toEqual({
      status: "error",
      autoRetriedOnReconnect: false,
      awaitingReconnectRetry: true,
      showManualRetry: true,
    });

    const reconnect = handleDeferredWorkReconnect(failedOnline);
    expect(reconnect.shouldRetry).toBe(true);

    const failedAfterReconnect = failDeferredWorkLoad(reconnect.nextState, { isConnected: true });
    expect(failedAfterReconnect.showManualRetry).toBe(true);
    expect(handleDeferredWorkReconnect(failedAfterReconnect).shouldRetry).toBe(false);
  });

  it("resets reconnect budget on manual retry, success, or collapse reset", () => {
    const exhausted = {
      status: "error" as const,
      autoRetriedOnReconnect: true,
      awaitingReconnectRetry: false,
      showManualRetry: true,
    };

    const manualRetry = startDeferredWorkLoad(exhausted, { manual: true });
    expect(manualRetry).toEqual({
      status: "loading",
      autoRetriedOnReconnect: false,
      awaitingReconnectRetry: false,
      showManualRetry: false,
    });

    expect(succeedDeferredWorkLoad()).toEqual(INITIAL_DEFERRED_WORK_LOAD_STATE);
    expect(resetDeferredWorkLoad()).toEqual(INITIAL_DEFERRED_WORK_LOAD_STATE);
  });
});
