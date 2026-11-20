import type { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

const CHALLENGE_TTL_MS = 120_000;

export class PeerChallengeRegistry extends Context.Service<
  PeerChallengeRegistry,
  {
    readonly register: (
      challenge: string,
      target: EnvironmentId,
      bearerDigest?: string,
    ) => Effect.Effect<void>;
    readonly consume: (
      challenge: string,
      target: EnvironmentId,
      bearerDigest?: string,
    ) => Effect.Effect<boolean>;
    readonly remove: (challenge: string) => Effect.Effect<void>;
  }
>()("t3/peer/PeerChallengeRegistry") {}

const make = Effect.gen(function* () {
  const pending = yield* Ref.make<
    ReadonlyMap<
      string,
      { readonly target: EnvironmentId; readonly bearerDigest?: string; readonly expiresAt: number }
    >
  >(new Map());
  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(
      pending,
      (current) => new Map([...current].filter(([, entry]) => entry.expiresAt > now)),
    );
  });
  yield* Effect.gen(function* () {
    yield* Effect.sleep(CHALLENGE_TTL_MS);
    yield* prune;
  }).pipe(Effect.forever, Effect.forkScoped);
  return {
    register: (challenge: string, target: EnvironmentId, bearerDigest?: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.update(pending, (current) =>
            new Map(current).set(challenge, {
              target,
              ...(bearerDigest === undefined ? {} : { bearerDigest }),
              expiresAt: now + CHALLENGE_TTL_MS,
            }),
          ),
        ),
      ),
    consume: (challenge: string, target: EnvironmentId, bearerDigest?: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.modify(pending, (current) => {
            const entry = current.get(challenge);
            if (entry === undefined) return [false, current] as const;
            if (
              entry.expiresAt > now &&
              (entry.target !== target || entry.bearerDigest !== bearerDigest)
            )
              return [false, current] as const;
            const next = new Map(current);
            next.delete(challenge);
            return [entry.expiresAt > now, next] as const;
          }),
        ),
      ),
    remove: (challenge: string) =>
      Ref.update(pending, (current) => {
        if (!current.has(challenge)) return current;
        const next = new Map(current);
        next.delete(challenge);
        return next;
      }),
  };
});

export const layer = Layer.effect(PeerChallengeRegistry, make);
