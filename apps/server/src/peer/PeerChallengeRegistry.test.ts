import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as PeerChallengeRegistry from "./PeerChallengeRegistry.ts";

it.effect("accepts only a registered challenge for its target, once", () =>
  Effect.gen(function* () {
    const registry = yield* PeerChallengeRegistry.PeerChallengeRegistry;
    const target = EnvironmentId.make("executor");
    const other = EnvironmentId.make("other-executor");

    expect(yield* registry.consume("challenge", target)).toBe(false);
    yield* registry.register("challenge", target);
    expect(yield* registry.consume("challenge", other)).toBe(false);
    expect(yield* registry.consume("challenge", target)).toBe(true);
    expect(yield* registry.consume("challenge", target)).toBe(false);

    yield* registry.register("bound", target, "token-digest");
    expect(yield* registry.consume("bound", target)).toBe(false);
    expect(yield* registry.consume("bound", target, "different-token")).toBe(false);
    expect(yield* registry.consume("bound", other, "token-digest")).toBe(false);
    expect(yield* registry.consume("bound", target, "token-digest")).toBe(true);
    expect(yield* registry.consume("bound", target, "token-digest")).toBe(false);
    yield* registry.register("oauth", target);
    expect(yield* registry.consume("oauth", target, "token-digest")).toBe(false);
    expect(yield* registry.consume("oauth", target)).toBe(true);

    yield* registry.register("removed", target);
    yield* registry.remove("removed");
    yield* registry.register("expired", target);
    yield* TestClock.adjust("121 seconds");
    expect(yield* registry.consume("expired", target)).toBe(false);
    expect(yield* registry.consume("removed", target)).toBe(false);
  }).pipe(Effect.provide(PeerChallengeRegistry.layer)),
);
