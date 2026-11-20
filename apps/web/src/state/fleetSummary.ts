import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  createFleetSummaryAtoms,
  initialFleetSummaryState,
} from "@t3tools/client-runtime/state/fleet-summary";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentScope } from "./session";

const waitUntilVisible = Effect.callback<void>((resume) => {
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    resume(Effect.void);
    return;
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") resume(Effect.void);
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return Effect.sync(() => document.removeEventListener("visibilitychange", onVisibilityChange));
});
const fleetSummary = createFleetSummaryAtoms(connectionAtomRuntime, waitUntilVisible);
const empty = initialFleetSummaryState("");
const emptyAtom = Atom.make(AsyncResult.success(empty));

export function useFleetSummary(sourceEnvironmentId: EnvironmentId | null) {
  const allowed = useEnvironmentScope(sourceEnvironmentId, AuthOrchestrationReadScope);
  const result = useAtomValue(
    sourceEnvironmentId !== null && allowed
      ? fleetSummary.stateAtom(sourceEnvironmentId)
      : emptyAtom,
  );
  if (sourceEnvironmentId !== null && !allowed)
    return {
      ...initialFleetSummaryState(sourceEnvironmentId),
      status: "error" as const,
      error: "forbidden" as const,
    };
  return AsyncResult.getOrElse(result, () =>
    sourceEnvironmentId === null ? empty : initialFleetSummaryState(sourceEnvironmentId),
  );
}

export function useFleetSummaryRetry(sourceEnvironmentId: EnvironmentId | null) {
  return useAtomRefresh(
    sourceEnvironmentId === null ? emptyAtom : fleetSummary.stateAtom(sourceEnvironmentId),
  );
}
