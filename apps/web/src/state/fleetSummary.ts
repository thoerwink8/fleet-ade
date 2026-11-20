import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  createFleetSummaryAtoms,
  initialFleetSummaryState,
} from "@t3tools/client-runtime/state/fleet-summary";
import {
  AuthOrchestrationReadScope,
  sessionGrantsScope,
  type AuthSessionState,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "./session";

export const waitUntilVisible = Effect.callback<void>((resume) => {
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    resume(Effect.void);
    return;
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resume(Effect.void);
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return Effect.sync(() => document.removeEventListener("visibilitychange", onVisibilityChange));
});
const fleetSummary = createFleetSummaryAtoms(connectionAtomRuntime, waitUntilVisible);
const empty = initialFleetSummaryState("");
const emptyAtom = Atom.make(AsyncResult.success(empty));
const emptySessionAtom = Atom.make(AsyncResult.initial<AuthSessionState>());

export function fleetSessionForbidden(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
): boolean {
  return result._tag === "Success" && !sessionGrantsScope(result.value, AuthOrchestrationReadScope);
}

export function useFleetSummary(sourceEnvironmentId: EnvironmentId | null) {
  const session = useAtomValue(
    sourceEnvironmentId === null
      ? emptySessionAtom
      : environmentSession.sessionStateAtom(sourceEnvironmentId),
  );
  const allowed = !fleetSessionForbidden(session);
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
