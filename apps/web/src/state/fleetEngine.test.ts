import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type FleetEngineStatus } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import {
  FLEET_ENGINE_FAILURE_DISMISSED_STORAGE_KEY,
  FLEET_ENGINE_RETRY_ATTEMPTS,
  FLEET_ENGINE_RETRY_INTERVAL_MS,
  createDismissedFleetEngineFailureAtom,
  dismissedFleetEngineFailureAtom,
  fetchFleetEngineStatusWithRetry,
  reconcileFleetEngineFailureDismissal,
  resolveFleetEngineFailure,
  shouldShowFleetEngineFailure,
} from "./fleetEngine";

const environmentId = EnvironmentId.make("environment-local");
const otherEnvironmentId = EnvironmentId.make("environment-remote");

const configuredBaseStatus: FleetEngineStatus = {
  configured: true,
  reachable: true,
  httpStatus: 200,
  body: null,
  checkedAt: "2026-11-24T00:00:00.000Z",
  reason: null,
};

function createMemoryStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    snapshot: () => Object.fromEntries(store),
  };
}

describe("fleet engine failure dismissal", () => {
  it("returns null when fleet service is not configured, even on transport or read error", () => {
    const unconfiguredFailure = resolveFleetEngineFailure({
      status: {
        configured: false,
        reachable: false,
        httpStatus: null,
        body: null,
        checkedAt: "2026-11-24T00:00:00.000Z",
        reason: "没配置",
      },
      error: "Transport error (GET )",
    });
    expect(unconfiguredFailure).toBeNull();
    expect(shouldShowFleetEngineFailure(unconfiguredFailure, null)).toBe(false);

    expect(
      resolveFleetEngineFailure({
        status: {
          configured: false,
          reachable: false,
          httpStatus: 500,
          body: null,
          checkedAt: "2026-11-24T00:00:00.000Z",
          reason: "没配置",
        },
        error: null,
      }),
    ).toBeNull();

    expect(
      resolveFleetEngineFailure({
        status: null,
        error: "Transport error (GET )",
      }),
    ).toBeNull();
  });

  it("keeps the same failure dismissed across chat mounts until recovery or another failure", () => {
    vi.useFakeTimers();
    try {
      const registry = AtomRegistry.make();
      const dismissal = dismissedFleetEngineFailureAtom(environmentId);
      const failure = resolveFleetEngineFailure({
        status: {
          ...configuredBaseStatus,
          reachable: false,
          httpStatus: null,
          reason: "Connection refused",
        },
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
          resolveFleetEngineFailure({
            status: {
              ...configuredBaseStatus,
              reachable: false,
              httpStatus: null,
              reason: "Request timed out",
            },
            error: "Request timed out",
          }),
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

  it("persists dismissal locally per environment across reloads until recovery or a new failure", () => {
    const storage = createMemoryStorage();
    const timeoutFailure = resolveFleetEngineFailure({
      status: {
        ...configuredBaseStatus,
        reachable: false,
        httpStatus: null,
        reason: "Request timed out",
      },
      error: null,
    });
    const serverFailure = resolveFleetEngineFailure({
      status: { ...configuredBaseStatus, httpStatus: 500 },
      error: null,
    });

    const firstSession = AtomRegistry.make();
    const firstAtom = createDismissedFleetEngineFailureAtom(environmentId, storage);
    firstSession.mount(firstAtom);
    firstSession.set(firstAtom, timeoutFailure?.kind ?? null);
    expect(storage.snapshot()[FLEET_ENGINE_FAILURE_DISMISSED_STORAGE_KEY]).toContain('"timeout"');
    firstSession.dispose();

    const reloadedSession = AtomRegistry.make();
    const reloadedAtom = createDismissedFleetEngineFailureAtom(environmentId, storage);
    const otherEnvironmentAtom = createDismissedFleetEngineFailureAtom(otherEnvironmentId, storage);
    expect(reloadedSession.get(reloadedAtom)).toBe("timeout");
    expect(shouldShowFleetEngineFailure(timeoutFailure, reloadedSession.get(reloadedAtom))).toBe(
      false,
    );
    expect(
      shouldShowFleetEngineFailure(timeoutFailure, reloadedSession.get(otherEnvironmentAtom)),
    ).toBe(true);
    expect(shouldShowFleetEngineFailure(serverFailure, reloadedSession.get(reloadedAtom))).toBe(
      true,
    );
    expect(
      reconcileFleetEngineFailureDismissal(
        { status: null, error: null },
        reloadedSession.get(reloadedAtom),
      ),
    ).toBe("timeout");

    const nextDismissed = reconcileFleetEngineFailureDismissal(
      { status: configuredBaseStatus, error: null },
      reloadedSession.get(reloadedAtom),
    );
    expect(nextDismissed).toBeNull();
    reloadedSession.set(reloadedAtom, nextDismissed);
    expect(storage.snapshot()[FLEET_ENGINE_FAILURE_DISMISSED_STORAGE_KEY]).toBeUndefined();
    reloadedSession.dispose();

    const nextFailureSession = AtomRegistry.make();
    const nextFailureAtom = createDismissedFleetEngineFailureAtom(environmentId, storage);
    expect(
      shouldShowFleetEngineFailure(timeoutFailure, nextFailureSession.get(nextFailureAtom)),
    ).toBe(true);
    nextFailureSession.dispose();

    const corruptStorage = createMemoryStorage({
      [FLEET_ENGINE_FAILURE_DISMISSED_STORAGE_KEY]: "{not-valid-json",
    });
    const corruptSession = AtomRegistry.make();
    expect(
      corruptSession.get(createDismissedFleetEngineFailureAtom(environmentId, corruptStorage)),
    ).toBeNull();
    corruptSession.dispose();
  });

  it("classifies configured failures without mentioning 引擎 and includes clickable next steps", () => {
    const failures = [
      resolveFleetEngineFailure({
        status: { ...configuredBaseStatus, httpStatus: 401 },
        error: null,
      }),
      resolveFleetEngineFailure({
        status: { ...configuredBaseStatus, httpStatus: 500 },
        error: null,
      }),
      resolveFleetEngineFailure({
        status: {
          ...configuredBaseStatus,
          reachable: false,
          httpStatus: null,
          reason: "Remote environment endpoint timed out after 15000ms.",
        },
        error: null,
      }),
      resolveFleetEngineFailure({
        status: {
          ...configuredBaseStatus,
          reachable: false,
          httpStatus: null,
          reason: "ECONNREFUSED",
        },
        error: null,
      }),
    ];

    expect(failures.map((failure) => failure?.kind)).toEqual([
      "authentication",
      "server",
      "timeout",
      "unreachable",
    ]);
    for (const failure of failures) {
      expect(failure).not.toBeNull();
      expect(failure!.title).not.toContain("引擎");
      expect(failure!.description).not.toContain("引擎");
      expect(failure!.description).toContain("机群服务");
      expect(failure!.description).toContain("重试");
      expect(failure!.description).toContain("设置 → 连接");
    }
    expect(failures[2]).toMatchObject({
      kind: "timeout",
      title: "连不上机群服务",
      description: "连接机群服务超时，请重试，或去 设置 → 连接 查看。",
    });
    expect(failures[3]).toMatchObject({
      kind: "unreachable",
      title: "连不上机群服务",
      description: "机群服务没有响应，请重试，或去 设置 → 连接 查看。",
    });
    expect(
      resolveFleetEngineFailure({
        status: configuredBaseStatus,
        error: null,
      }),
    ).toBeNull();
    expect(reconcileFleetEngineFailureDismissal({ status: null, error: null }, "unreachable")).toBe(
      "unreachable",
    );
    expect(
      reconcileFleetEngineFailureDismissal(
        { status: configuredBaseStatus, error: null },
        "unreachable",
      ),
    ).toBeNull();
    expect(
      reconcileFleetEngineFailureDismissal(
        { status: { ...configuredBaseStatus, httpStatus: 500 }, error: null },
        "unreachable",
      ),
    ).toBe("unreachable");
  });

  it.effect(
    "retries configured failures silently before surfacing them and stops after recovery",
    () =>
      Effect.gen(function* () {
        const failedStatus: FleetEngineStatus = {
          ...configuredBaseStatus,
          reachable: false,
          httpStatus: null,
          reason: "Remote environment endpoint timed out after 15000ms.",
        };

        const recoveryAttempts = yield* Ref.make(0);
        const recoveryAttemptQueue = yield* Queue.unbounded<number>();
        const recoverySettled = yield* Deferred.make<void>();
        const recoveryFiber = yield* fetchFleetEngineStatusWithRetry(
          Effect.gen(function* () {
            const attempt = yield* Ref.updateAndGet(recoveryAttempts, (count) => count + 1);
            yield* Queue.offer(recoveryAttemptQueue, attempt);
            return attempt === 1 ? failedStatus : configuredBaseStatus;
          }),
        ).pipe(
          Effect.tap(() => Deferred.succeed(recoverySettled, undefined)),
          Effect.forkScoped,
        );

        expect(yield* Queue.take(recoveryAttemptQueue)).toBe(1);
        expect(yield* Deferred.isDone(recoverySettled)).toBe(false);

        yield* TestClock.adjust(Duration.millis(FLEET_ENGINE_RETRY_INTERVAL_MS));
        expect(yield* Queue.take(recoveryAttemptQueue)).toBe(2);
        const recovered = yield* Fiber.join(recoveryFiber);
        expect(recovered).toEqual(configuredBaseStatus);
        expect(yield* Ref.get(recoveryAttempts)).toBe(2);

        const exhaustedAttempts = yield* Ref.make(0);
        const exhaustedAttemptQueue = yield* Queue.unbounded<number>();
        const exhaustedSettled = yield* Deferred.make<void>();
        const exhaustedFiber = yield* fetchFleetEngineStatusWithRetry(
          Effect.gen(function* () {
            const attempt = yield* Ref.updateAndGet(exhaustedAttempts, (count) => count + 1);
            yield* Queue.offer(exhaustedAttemptQueue, attempt);
            return failedStatus;
          }),
        ).pipe(
          Effect.tap(() => Deferred.succeed(exhaustedSettled, undefined)),
          Effect.forkScoped,
        );

        expect(yield* Queue.take(exhaustedAttemptQueue)).toBe(1);
        expect(yield* Deferred.isDone(exhaustedSettled)).toBe(false);

        for (let retry = 2; retry <= FLEET_ENGINE_RETRY_ATTEMPTS + 1; retry += 1) {
          yield* TestClock.adjust(Duration.millis(FLEET_ENGINE_RETRY_INTERVAL_MS));
          expect(yield* Queue.take(exhaustedAttemptQueue)).toBe(retry);
        }

        const exhaustedStatus = yield* Fiber.join(exhaustedFiber);
        expect(exhaustedStatus).toEqual(failedStatus);
        expect(yield* Ref.get(exhaustedAttempts)).toBe(FLEET_ENGINE_RETRY_ATTEMPTS + 1);

        const transportErrorAttempts = yield* Ref.make(0);
        const transportAttemptQueue = yield* Queue.unbounded<number>();
        const transportFiber = yield* fetchFleetEngineStatusWithRetry(
          Effect.gen(function* () {
            const attempt = yield* Ref.updateAndGet(transportErrorAttempts, (count) => count + 1);
            yield* Queue.offer(transportAttemptQueue, attempt);
            return yield* Effect.fail("Transport error");
          }),
        ).pipe(Effect.exit, Effect.forkScoped);

        expect(yield* Queue.take(transportAttemptQueue)).toBe(1);
        yield* TestClock.adjust(Duration.millis(FLEET_ENGINE_RETRY_INTERVAL_MS));
        expect(yield* Queue.take(transportAttemptQueue)).toBe(2);
        yield* TestClock.adjust(Duration.millis(FLEET_ENGINE_RETRY_INTERVAL_MS));
        expect(yield* Queue.take(transportAttemptQueue)).toBe(3);
        const transportExit = yield* Fiber.join(transportFiber);
        expect(Exit.isFailure(transportExit)).toBe(true);

        const manualRetryAttempts = yield* Ref.make(0);
        const manualResult = yield* fetchFleetEngineStatusWithRetry(
          Ref.updateAndGet(manualRetryAttempts, (count) => count + 1).pipe(Effect.as(failedStatus)),
          { maxRetries: 0 },
        );
        expect(manualResult).toEqual(failedStatus);
        expect(yield* Ref.get(manualRetryAttempts)).toBe(1);
      }),
  );
});
