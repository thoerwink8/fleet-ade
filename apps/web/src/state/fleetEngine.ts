import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import type { EnvironmentId, FleetEngineStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export type FleetEngineFailureKind = "unreachable" | "timeout" | "authentication" | "server";

export interface FleetEngineFailure {
  readonly kind: FleetEngineFailureKind;
  readonly title: string;
  readonly description: string;
}

const FLEET_ENGINE_REQUEST_TIMEOUT_MS = 15_000;
const FLEET_ENGINE_STALE_TIME_MS = 60_000;
export const FLEET_ENGINE_RETRY_ATTEMPTS = 2;
export const FLEET_ENGINE_RETRY_INTERVAL_MS = 15_000;
export const FLEET_ENGINE_FAILURE_DISMISSED_STORAGE_KEY =
  "t3code:fleet-engine-failure-dismissed:v1";

type DismissalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const FleetEngineFailureKindSchema = Schema.Literals([
  "unreachable",
  "timeout",
  "authentication",
  "server",
]);
const DismissedFleetEngineFailureMapSchema = Schema.fromJsonString(
  Schema.Record(Schema.String, FleetEngineFailureKindSchema),
);
const decodeDismissedMap = Schema.decodeUnknownOption(DismissedFleetEngineFailureMapSchema);
const encodeDismissedMap = Schema.encodeOption(DismissedFleetEngineFailureMapSchema);

function defaultDismissalStorage(): DismissalStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readDismissedMap(
  storage: DismissalStorage | undefined,
): Record<string, FleetEngineFailureKind> {
  if (!storage) return {};
  let raw: string | null = null;
  try {
    raw = storage.getItem(FLEET_ENGINE_FAILURE_DISMISSED_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  return { ...Option.getOrElse(decodeDismissedMap(raw), () => ({})) };
}

function readDismissedFleetEngineFailure(
  environmentId: EnvironmentId,
  storage: DismissalStorage | undefined = defaultDismissalStorage(),
): FleetEngineFailureKind | null {
  return readDismissedMap(storage)[environmentId] ?? null;
}

function writeDismissedFleetEngineFailure(
  environmentId: EnvironmentId,
  kind: FleetEngineFailureKind | null,
  storage: DismissalStorage | undefined = defaultDismissalStorage(),
): void {
  if (!storage) return;
  try {
    const next = readDismissedMap(storage);
    if (kind === null) {
      delete next[environmentId];
    } else {
      next[environmentId] = kind;
    }
    if (Object.keys(next).length === 0) {
      storage.removeItem(FLEET_ENGINE_FAILURE_DISMISSED_STORAGE_KEY);
      return;
    }
    const encoded = encodeDismissedMap(next);
    if (Option.isSome(encoded)) {
      storage.setItem(FLEET_ENGINE_FAILURE_DISMISSED_STORAGE_KEY, encoded.value);
    }
  } catch {
    // Ignore local storage quota or privacy-mode failures; in-memory dismissal still holds.
  }
}

export function createDismissedFleetEngineFailureAtom(
  environmentId: EnvironmentId,
  storage?: DismissalStorage,
) {
  return Atom.writable(
    (get): FleetEngineFailureKind | null => {
      const current = get.self<FleetEngineFailureKind | null>();
      return Option.isSome(current)
        ? current.value
        : readDismissedFleetEngineFailure(environmentId, storage);
    },
    (ctx, next: FleetEngineFailureKind | null) => {
      writeDismissedFleetEngineFailure(environmentId, next, storage);
      ctx.setSelf(next);
    },
  ).pipe(Atom.keepAlive, Atom.withLabel(`fleet-engine-failure-dismissed:${environmentId}`));
}

/** Per environment, so dismissing on one connection does not hide a failure on another. */
export const dismissedFleetEngineFailureAtom = Atom.family((environmentId: EnvironmentId) =>
  createDismissedFleetEngineFailureAtom(environmentId),
);

export const fetchFleetEngineStatusWithRetry = Effect.fn("fleetEngine.fetchStatusWithRetry")(
  function* <E, R>(
    readStatus: Effect.Effect<FleetEngineStatus, E, R>,
    options?: {
      readonly maxRetries?: number;
      readonly retryIntervalMs?: number;
    },
  ) {
    const maxRetries = Math.max(0, options?.maxRetries ?? FLEET_ENGINE_RETRY_ATTEMPTS);
    const retryIntervalMs = Math.max(0, options?.retryIntervalMs ?? FLEET_ENGINE_RETRY_INTERVAL_MS);
    for (let attempt = 0; ; attempt += 1) {
      const exit = yield* Effect.exit(readStatus);
      if (Exit.isSuccess(exit)) {
        if (
          resolveFleetEngineFailure({ status: exit.value, error: null }) === null ||
          attempt >= maxRetries
        ) {
          return exit.value;
        }
      } else if (Cause.hasInterruptsOnly(exit.cause) || attempt >= maxRetries) {
        return yield* exit;
      }
      yield* Effect.sleep(Duration.millis(retryIntervalMs));
    }
  },
);

const manualRetryEnvironmentIds = new Set<EnvironmentId>();

const engineStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(
      Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) => {
        const isManualRetry = manualRetryEnvironmentIds.delete(environmentId);
        return fetchFleetEngineStatusWithRetry(
          registry.run(
            environmentId,
            executeConnectedEnvironmentHttpRequest({
              group: "fleetEngine",
              method: "GET",
              url: (urls) => urls.status(),
              timeoutMs: FLEET_ENGINE_REQUEST_TIMEOUT_MS,
              request: ({ client, headers }) => client.status({ headers }),
            }),
          ),
          {
            maxRetries: isManualRetry ? 0 : FLEET_ENGINE_RETRY_ATTEMPTS,
            retryIntervalMs: FLEET_ENGINE_RETRY_INTERVAL_MS,
          },
        );
      }),
    )
    .pipe(
      Atom.swr({ staleTime: FLEET_ENGINE_STALE_TIME_MS, revalidateOnMount: true }),
      Atom.withLabel(`fleet-engine-status:${environmentId}`),
    ),
);

export function retryFleetEngineStatus(environmentId: EnvironmentId): void {
  manualRetryEnvironmentIds.add(environmentId);
  appAtomRegistry.refresh(engineStatusAtom(environmentId));
}

/** The fleet service's read translated into one user-facing cause, without the raw transport text. */
export function resolveFleetEngineFailure(input: {
  readonly status: FleetEngineStatus | null;
  readonly error: string | null;
}): FleetEngineFailure | null {
  const status = input.status;
  if (status?.configured !== true) return null;
  const connectionError = input.error ?? (status.reachable === false ? status.reason : null);
  if (connectionError !== null) {
    const kind: FleetEngineFailureKind = /timed? ?out|超时/i.test(connectionError)
      ? "timeout"
      : "unreachable";
    return {
      kind,
      title: "连不上机群服务",
      description:
        kind === "timeout"
          ? "连接机群服务超时，请重试，或去 设置 → 连接 查看。"
          : "机群服务没有响应，请重试，或去 设置 → 连接 查看。",
    };
  }
  const httpStatus = status.httpStatus;
  if (!status.reachable || httpStatus === null || httpStatus >= 400) {
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        kind: "authentication",
        title: "机群服务登录已过期",
        description: "机群服务登录已过期，请重新登录后重试，或去 设置 → 连接 查看。",
      };
    }
    if (status.reachable) {
      return {
        kind: "server",
        title: "机群服务出错",
        description: "机群服务返回异常，请重试，或去 设置 → 连接 查看。",
      };
    }
    return {
      kind: "unreachable",
      title: "连不上机群服务",
      description: "机群服务没有响应，请重试，或去 设置 → 连接 查看。",
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

export function useFleetEngineFailureDismissal(
  environmentId: EnvironmentId,
): readonly [FleetEngineFailureKind | null, (kind: FleetEngineFailureKind | null) => void] {
  const atom = dismissedFleetEngineFailureAtom(environmentId);
  return [useAtomValue(atom), useAtomSet(atom)] as const;
}

export function useFleetEngineStatus(environmentId: EnvironmentId): {
  readonly status: FleetEngineStatus | null;
  readonly error: string | null;
  readonly isRetrying: boolean;
} {
  const result = useAtomValue(engineStatusAtom(environmentId));
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    const message = cause instanceof Error ? cause.message : "读不到接口";
    return {
      status: AsyncResult.getOrElse(result, () => null),
      error: message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "").trim() || "读不到接口",
      isRetrying: result.waiting,
    };
  }
  return {
    status: result._tag === "Success" ? result.value : null,
    error: null,
    isRetrying: result.waiting,
  };
}
