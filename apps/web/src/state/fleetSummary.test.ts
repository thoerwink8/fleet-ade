import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { fleetSessionForbidden, waitUntilVisible } from "./fleetSummary";

it("does not mistake an unavailable session for a denied grant", () => {
  expect(fleetSessionForbidden(AsyncResult.initial())).toBe(false);
  expect(fleetSessionForbidden(AsyncResult.failure(Cause.fail("offline")))).toBe(false);
  expect(
    fleetSessionForbidden(
      AsyncResult.success({
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "test",
        },
        scopes: [],
        permissions: [],
      }),
    ),
  ).toBe(true);
});
it.effect("removes visibility listeners after visibility changes and interruption", () =>
  Effect.gen(function* () {
    const listeners = new Set<() => void>();
    const fakeDocument = {
      visibilityState: "hidden",
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
    vi.stubGlobal("document", fakeDocument);
    let registered: (() => void) | undefined;
    const add = fakeDocument.addEventListener;
    fakeDocument.addEventListener = (type, listener) => {
      add(type, listener);
      registered?.();
      return listeners;
    };
    try {
      const firstRegistration = Effect.callback<void>((resume) => {
        registered = () => resume(Effect.void);
      });
      const fiber = yield* Effect.forkChild(waitUntilVisible);
      yield* firstRegistration;
      expect(listeners.size).toBe(1);
      fakeDocument.visibilityState = "visible";
      for (const listener of listeners) listener();
      yield* Fiber.join(fiber);
      expect(listeners.size).toBe(0);
      fakeDocument.visibilityState = "hidden";
      const nextRegistration = Effect.callback<void>((resume) => {
        registered = () => resume(Effect.void);
      });
      const interrupted = yield* Effect.forkChild(waitUntilVisible);
      yield* nextRegistration;
      expect(listeners.size).toBe(1);
      yield* Fiber.interrupt(interrupted);
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  }),
);
