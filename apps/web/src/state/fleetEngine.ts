import { useAtomValue } from "@effect/atom-react";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import type { EnvironmentId, FleetEngineStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export type FleetEngineFailureKind = "unreachable" | "timeout" | "authentication" | "server";

export interface FleetEngineFailure {
  readonly kind: FleetEngineFailureKind;
  readonly title: string;
  readonly description: string;
}

/** Per environment, so dismissing on one connection does not hide a failure on another. */
export const dismissedFleetEngineFailureAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<FleetEngineFailureKind | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`fleet-engine-failure-dismissed:${environmentId}`),
  ),
);

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

/** The engine's read translated into one user-facing cause, without the raw transport text. */
export function resolveFleetEngineFailure(input: {
  readonly status: FleetEngineStatus | null;
  readonly error: string | null;
}): FleetEngineFailure | null {
  const status = input.status;
  const connectionError = input.error ?? (status?.reachable === false ? status.reason : null);
  if (connectionError !== null) {
    const kind: FleetEngineFailureKind = /timed? ?out|超时/i.test(connectionError)
      ? "timeout"
      : "unreachable";
    return {
      kind,
      title: kind === "timeout" ? "引擎连接超时" : "引擎不可用",
      description:
        kind === "timeout"
          ? "连接引擎超时，请检查引擎是否正常。"
          : "连不上引擎，请检查引擎是否已启动。",
    };
  }
  if (status?.configured !== true) return null;
  const httpStatus = status.httpStatus;
  if (!status.reachable || httpStatus === null || httpStatus >= 400) {
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        kind: "authentication",
        title: "引擎登录已过期",
        description: "引擎登录已过期，请重新登录。",
      };
    }
    if (status.reachable) {
      return {
        kind: "server",
        title: "引擎服务出错",
        description: "引擎服务出错，请检查引擎日志后重试。",
      };
    }
    return {
      kind: "unreachable",
      title: "引擎不可用",
      description: "连不上引擎，请检查引擎是否已启动。",
    };
  }
  return null;
}

export function shouldShowFleetEngineFailure(
  failure: FleetEngineFailure | null,
  dismissedKind: FleetEngineFailureKind | null,
): boolean {
  return failure !== null && dismissedKind !== failure.kind;
}
/** Only a settled healthy read ends the failure period; loading (`status: null, error: null`) preserves dismissal. */
export function reconcileFleetEngineFailureDismissal(
  health: { readonly status: FleetEngineStatus | null; readonly error: string | null },
  dismissedKind: FleetEngineFailureKind | null,
): FleetEngineFailureKind | null {
  if (dismissedKind === null) return null;
  if (health.error !== null || health.status === null) return dismissedKind;
  if (!health.status.configured) return null;
  const httpStatus = health.status.httpStatus;
  const recovered = health.status.reachable && httpStatus !== null && httpStatus < 400;
  return recovered ? null : dismissedKind;
}

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
