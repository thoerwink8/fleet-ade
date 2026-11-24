import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { PROVIDER_STATUS_FRESH_WINDOW_MS, providerRefusal } from "./ProviderReadinessGate.ts";

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const instanceId = ProviderInstanceId.make("codex");

function makeProvider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(0),
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const signedOutAt = (ms: number) =>
  makeProvider({
    status: "error",
    auth: { status: "unauthenticated" },
    checkedAt: iso(ms),
  });

function makeRegistry(cached: ServerProvider, probed: ServerProvider) {
  return Effect.gen(function* () {
    const probes = yield* Ref.make(0);
    const registry = {
      getProviders: Effect.succeed([cached]),
      refreshInstance: () => Ref.update(probes, (n) => n + 1).pipe(Effect.as([probed])),
    } as unknown as ProviderRegistry.ProviderRegistry["Service"];
    return { registry, probes };
  });
}

it.effect("a stale signed-out status that is actually signed in does not refuse the send", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(PROVIDER_STATUS_FRESH_WINDOW_MS * 10);
    const { registry, probes } = yield* makeRegistry(signedOutAt(0), makeProvider({}));
    expect(yield* providerRefusal(registry, instanceId)).toBeNull();
    expect(yield* Ref.get(probes)).toBe(1);
  }),
);

it.effect(
  "a stale signed-out status that is still signed out refuses after exactly one probe",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(PROVIDER_STATUS_FRESH_WINDOW_MS * 10);
      const { registry, probes } = yield* makeRegistry(signedOutAt(0), signedOutAt(1));
      expect(yield* providerRefusal(registry, instanceId)).toBe("Codex 需要重新登录。");
      expect(yield* Ref.get(probes)).toBe(1);
    }),
);

it.effect("a freshly checked signed-out status refuses without probing again", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(PROVIDER_STATUS_FRESH_WINDOW_MS * 10);
    const checkedAt = PROVIDER_STATUS_FRESH_WINDOW_MS * 10 - PROVIDER_STATUS_FRESH_WINDOW_MS;
    const { registry, probes } = yield* makeRegistry(signedOutAt(checkedAt), makeProvider({}));
    expect(yield* providerRefusal(registry, instanceId)).toBe("Codex 需要重新登录。");
    expect(yield* Ref.get(probes)).toBe(0);
  }),
);

it.effect("a ready status never probes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(PROVIDER_STATUS_FRESH_WINDOW_MS * 10);
    const { registry, probes } = yield* makeRegistry(makeProvider({}), signedOutAt(1));
    expect(yield* providerRefusal(registry, instanceId)).toBeNull();
    expect(yield* Ref.get(probes)).toBe(0);
  }),
);

it.effect("a stale missing install is re-probed once and refused when still missing", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(PROVIDER_STATUS_FRESH_WINDOW_MS * 10);
    const missing = makeProvider({ installed: false, status: "error" });
    const { registry, probes } = yield* makeRegistry(missing, missing);
    expect(yield* providerRefusal(registry, instanceId)).toBe("这台电脑上没装 Codex。");
    expect(yield* Ref.get(probes)).toBe(1);
  }),
);
