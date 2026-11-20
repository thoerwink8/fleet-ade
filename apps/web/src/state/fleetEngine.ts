import { useAtomValue } from "@effect/atom-react";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import type { EnvironmentId, FleetEngineStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const REQUEST_TIMEOUT_MS = 15_000;

const engineStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(
      Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
        registry.run(
          environmentId,
          executeConnectedEnvironmentHttpRequest({
            group: "fleetEngine",
            method: "GET",
            url: (urls) => urls.status(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.status({ headers }),
          }),
        ),
      ),
    )
    .pipe(
      Atom.swr({ staleTime: 60_000, revalidateOnMount: true }),
      Atom.withLabel(`fleet-engine-status:${environmentId}`),
    ),
);

export function useFleetEngineStatus(environmentId: EnvironmentId): {
  readonly status: FleetEngineStatus | null;
  readonly error: string | null;
} {
  const result = useAtomValue(engineStatusAtom(environmentId));
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    const message = cause instanceof Error ? cause.message : "读不到接口";
    return {
      status: null,
      error: message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "").trim() || "读不到接口",
    };
  }
  return { status: result._tag === "Success" ? result.value : null, error: null };
}
