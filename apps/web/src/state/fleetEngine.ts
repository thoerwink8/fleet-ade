import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { describeRequestFailure } from "@t3tools/client-runtime/errors";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import type { EnvironmentId, FleetEngineStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
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
export const FLEET_ENGINE_RETRY_INTERVAL_MS = 5_000;
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

export interface FleetEngineManualRetryState {
  readonly inFlight: boolean;
  readonly lastFailedAt: number | null;
  readonly failureCount: number;
}

const INITIAL_MANUAL_RETRY_STATE: FleetEngineManualRetryState = {
  inFlight: false,
  lastFailedAt: null,
  failureCount: 0,
};

const manualRetryStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<FleetEngineManualRetryState>(INITIAL_MANUAL_RETRY_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`fleet-engine-manual-retry:${environmentId}`),
  ),
);

const manualRetryEnvironmentIds = new Set<EnvironmentId>();

export const executeFleetEngineStatusCheck = Effect.fn("fleetEngine.executeStatusCheck")(function* <
  E,
  R,
>(input: {
  readonly readStatus: Effect.Effect<FleetEngineStatus, E, R>;
  readonly isManualRetry: boolean;
  readonly retryIntervalMs?: number;
  readonly onManualRetryState?: (
    update: (previous: FleetEngineManualRetryState) => FleetEngineManualRetryState,
  ) => void;
}) {
  if (input.isManualRetry) {
    input.onManualRetryState?.((previous) => ({
      ...previous,
      inFlight: true,
    }));
  }

  const exit = yield* Effect.exit(
    fetchFleetEngineStatusWithRetry(input.readStatus, {
      maxRetries: input.isManualRetry ? 0 : FLEET_ENGINE_RETRY_ATTEMPTS,
      retryIntervalMs: input.retryIntervalMs ?? FLEET_ENGINE_RETRY_INTERVAL_MS,
    }),
  );

  if (Exit.isSuccess(exit)) {
    if (resolveFleetEngineFailure({ status: exit.value, error: null }) === null) {
      input.onManualRetryState?.(() => INITIAL_MANUAL_RETRY_STATE);
    } else if (input.isManualRetry) {
      const now = yield* Clock.currentTimeMillis;
      input.onManualRetryState?.((previous) => ({
        inFlight: false,
        lastFailedAt: now,
        failureCount: previous.failureCount + 1,
      }));
    }
    return exit.value;
  }

  if (input.isManualRetry) {
    if (Cause.hasInterruptsOnly(exit.cause)) {
      input.onManualRetryState?.((previous) => ({
        ...previous,
        inFlight: false,
      }));
    } else {
      const now = yield* Clock.currentTimeMillis;
      input.onManualRetryState?.((previous) => ({
        inFlight: false,
        lastFailedAt: now,
        failureCount: previous.failureCount + 1,
      }));
    }
  }
  return yield* exit;
});

const engineStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(
      Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) => {
        const isManualRetry = manualRetryEnvironmentIds.delete(environmentId);
        const retryAtom = manualRetryStateAtom(environmentId);
        return executeFleetEngineStatusCheck({
          readStatus: registry.run(
            environmentId,
            executeConnectedEnvironmentHttpRequest({
              group: "fleetEngine",
              method: "GET",
              url: (urls) => urls.status(),
              timeoutMs: FLEET_ENGINE_REQUEST_TIMEOUT_MS,
              request: ({ client, headers }) => client.status({ headers }),
            }),
          ),
          isManualRetry,
          retryIntervalMs: FLEET_ENGINE_RETRY_INTERVAL_MS,
          onManualRetryState: (update) => {
            appAtomRegistry.set(retryAtom, update(appAtomRegistry.get(retryAtom)));
          },
        });
      }),
    )
    .pipe(
      Atom.swr({ staleTime: FLEET_ENGINE_STALE_TIME_MS, revalidateOnMount: true }),
      Atom.withLabel(`fleet-engine-status:${environmentId}`),
    ),
);

export function retryFleetEngineStatus(environmentId: EnvironmentId): void {
  const retryAtom = manualRetryStateAtom(environmentId);
  const previous = appAtomRegistry.get(retryAtom);
  if (previous.inFlight) return;
  appAtomRegistry.set(retryAtom, { ...previous, inFlight: true });
  manualRetryEnvironmentIds.add(environmentId);
  appAtomRegistry.refresh(engineStatusAtom(environmentId));
}

function formatFleetEngineRetryTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatFleetEngineFailureDescription(
  kind: FleetEngineFailureKind,
  lastRetryFailedAt?: number | null,
  retryFailureCount?: number,
): string {
  if (lastRetryFailedAt !== undefined && lastRetryFailedAt !== null) {
    const time = formatFleetEngineRetryTime(lastRetryFailedAt);
    const prefix =
      retryFailureCount !== undefined && retryFailureCount > 1
        ? `${time} 第 ${retryFailureCount} 次重试，`
        : `${time} 重试过，`;
    switch (kind) {
      case "timeout":
        return `${prefix}连接机群服务依然超时，请稍后再试，或去 设置 → 连接 查看。`;
      case "authentication":
        return `${prefix}机群服务登录仍已过期，请重新登录后再试，或去 设置 → 连接 查看。`;
      case "server":
        return `${prefix}机群服务依然返回异常，请稍后再试，或去 设置 → 连接 查看。`;
      case "unreachable":
        return `${prefix}还是连不上机群服务，请稍后再试，或去 设置 → 连接 查看。`;
    }
  }
  switch (kind) {
    case "timeout":
      return "连接机群服务超时，请重试，或去 设置 → 连接 查看。";
    case "authentication":
      return "机群服务登录已过期，请重新登录后重试，或去 设置 → 连接 查看。";
    case "server":
      return "机群服务返回异常，请重试，或去 设置 → 连接 查看。";
    case "unreachable":
      return "机群服务没有响应，请重试，或去 设置 → 连接 查看。";
  }
}

/** The fleet service's read translated into one user-facing cause, without the raw transport text. */
export function resolveFleetEngineFailure(input: {
  readonly status: FleetEngineStatus | null;
  readonly error: string | null;
  readonly lastRetryFailedAt?: number | null;
  readonly retryFailureCount?: number;
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
      description: formatFleetEngineFailureDescription(
        kind,
        input.lastRetryFailedAt,
        input.retryFailureCount,
      ),
    };
  }
  const httpStatus = status.httpStatus;
  if (!status.reachable || httpStatus === null || httpStatus >= 400) {
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        kind: "authentication",
        title: "机群服务登录已过期",
        description: formatFleetEngineFailureDescription(
          "authentication",
          input.lastRetryFailedAt,
          input.retryFailureCount,
        ),
      };
    }
    if (status.reachable) {
      return {
        kind: "server",
        title: "机群服务出错",
        description: formatFleetEngineFailureDescription(
          "server",
          input.lastRetryFailedAt,
          input.retryFailureCount,
        ),
      };
    }
    return {
      kind: "unreachable",
      title: "连不上机群服务",
      description: formatFleetEngineFailureDescription(
        "unreachable",
        input.lastRetryFailedAt,
        input.retryFailureCount,
      ),
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
  readonly lastRetryFailedAt: number | null;
  readonly retryFailureCount: number;
} {
  const result = useAtomValue(engineStatusAtom(environmentId));
  const manualRetry = useAtomValue(manualRetryStateAtom(environmentId));
  const isRetrying = result.waiting || manualRetry.inFlight;
  if (result._tag === "Failure") {
    const cause = describeRequestFailure(result.cause);
    const message = cause instanceof Error ? cause.message : "读不到接口";
    return {
      status: AsyncResult.getOrElse(result, () => null),
      error: message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "").trim() || "读不到接口",
      isRetrying,
      lastRetryFailedAt: manualRetry.lastFailedAt,
      retryFailureCount: manualRetry.failureCount,
    };
  }
  return {
    status: result._tag === "Success" ? result.value : null,
    error: null,
    isRetrying,
    lastRetryFailedAt: manualRetry.lastFailedAt,
    retryFailureCount: manualRetry.failureCount,
  };
}
