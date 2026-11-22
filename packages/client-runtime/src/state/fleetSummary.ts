import type {
  FleetSummaryChangeEvent,
  FleetSummaryEvent,
  FleetSummaryRow,
  FleetSummaryTombstoneKey,
} from "@t3tools/contracts";
import { type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  isAuthorizationFailure,
  subscribeFleetSummaryInSession,
  subscriptionRetryDelay,
} from "../rpc/client.ts";
import { followStreamInEnvironment, provideEnvironmentStreamPermissions } from "./runtime.ts";

export type FleetSummaryState = {
  readonly epoch: number;
  readonly status: "loading" | "live" | "updating" | "error";
  readonly sourceId: string;
  readonly rows: ReadonlyMap<string, FleetSummaryRow>;
  readonly cursor: number | null;
  readonly pending: {
    readonly epoch: number;
    readonly snapshotRevision: number;
    readonly pageCount: number;
    readonly pages: ReadonlyMap<number, readonly FleetSummaryRow[]>;
  } | null;
  readonly eventBuffer: readonly FleetSummaryChangeEvent[];
  readonly error: "forbidden" | "storage" | null;
};

export const fleetSummaryRowKey = (row: FleetSummaryTombstoneKey): string =>
  row.repo !== undefined && row.issue !== undefined && row.taskId !== undefined
    ? `task\n${row.environmentId}\n${row.repo}\n${row.issue}\n${row.taskId}`
    : `adhoc\n${row.environmentId}\n${row.threadId}`;

export const initialFleetSummaryState = (sourceId: string): FleetSummaryState => ({
  epoch: 0,
  status: "loading",
  sourceId,
  rows: new Map(),
  cursor: null,
  pending: null,
  eventBuffer: [],
  error: null,
});

export function beginFleetSummarySubscription(
  state: FleetSummaryState,
  reset = false,
): FleetSummaryState {
  return {
    ...state,
    epoch: state.epoch + 1,
    status: state.rows.size || state.cursor !== null ? "updating" : "loading",
    cursor: reset ? null : state.cursor,
    pending: null,
    eventBuffer: [],
    error: null,
  };
}

function applyChange(state: FleetSummaryState, event: FleetSummaryChangeEvent): FleetSummaryState {
  if (state.cursor === null) return { ...state, eventBuffer: [...state.eventBuffer, event] };
  if (event.revision <= state.cursor) return state;
  const key = fleetSummaryRowKey(event.type === "upsert" ? event.row : event.key);
  const rows = new Map(state.rows);
  if (event.type === "tombstone") rows.delete(key);
  else if ((rows.get(key)?.revision ?? -1) < event.row.revision) rows.set(key, event.row);
  return { ...state, rows, cursor: event.revision };
}

export function applyFleetSummaryEvent(
  state: FleetSummaryState,
  event: FleetSummaryEvent,
  epoch = state.epoch,
): FleetSummaryState {
  if (epoch !== state.epoch) return state;
  if (event.type === "resync") return beginFleetSummarySubscription(state, true);
  if (event.type !== "snapshot")
    return state.pending === null
      ? applyChange(state, event)
      : { ...state, eventBuffer: [...state.eventBuffer, event] };
  const pending = state.pending;
  if (
    event.page > event.pageCount ||
    (pending !== null &&
      (pending.snapshotRevision !== event.revision || pending.pageCount !== event.pageCount))
  ) {
    return beginFleetSummarySubscription(state, true);
  }
  if (pending?.pages.has(event.page)) return state;
  const pages = new Map(pending?.pages ?? []);
  pages.set(event.page, event.rows);
  if (pages.size !== event.pageCount)
    return {
      ...state,
      pending: { epoch, snapshotRevision: event.revision, pageCount: event.pageCount, pages },
    };
  const rows = new Map<string, FleetSummaryRow>();
  for (let page = 1; page <= event.pageCount; page++) {
    const entries = pages.get(page);
    if (entries === undefined) return state;
    for (const row of entries) rows.set(fleetSummaryRowKey(row), row);
  }
  let next: FleetSummaryState = {
    ...state,
    rows,
    cursor: event.revision,
    pending: null,
    eventBuffer: [],
  };
  for (const change of [...state.eventBuffer].sort((a, b) => a.revision - b.revision))
    next = applyChange(next, change);
  return next;
}

export type ResumeCache = {
  snapshot: {
    sourceId: string;
    rows: ReadonlyMap<string, FleetSummaryRow>;
    cursor: number | null;
  } | null;
};

export function fleetSummaryChanges(
  sourceId: EnvironmentId,
  cache: ResumeCache,
  waitUntilVisible: Effect.Effect<void> = Effect.void,
) {
  return followStreamInEnvironment(
    sourceId,
    Stream.unwrap(
      Effect.gen(function* () {
        const saved = cache.snapshot?.sourceId === sourceId ? cache.snapshot : null;
        const initial = initialFleetSummaryState(sourceId);
        const state = yield* SubscriptionRef.make<FleetSummaryState>(
          saved === null
            ? initial
            : { ...initial, rows: saved.rows, cursor: saved.cursor, status: "updating" },
        );
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const sessions = SubscriptionRef.changes(supervisor.session).pipe(
          Stream.switchMap((session) => {
            if (Option.isNone(session))
              return Stream.fromEffect(
                SubscriptionRef.update(state, (current): FleetSummaryState => ({
                  ...current,
                  epoch: current.epoch + 1,
                  pending: null,
                  eventBuffer: [],
                  status: current.rows.size || current.cursor !== null ? "updating" : "loading",
                })),
              ).pipe(Stream.drain);
            return Stream.unwrap(
              Effect.gen(function* () {
                const wake = yield* Queue.unbounded<void>();
                const run = Effect.gen(function* () {
                  let retries = 0;
                  const pauseBeforeRetry = Effect.fn("FleetSummary.pauseBeforeRetry")(function* (
                    storageFailure: boolean,
                  ) {
                    const jitter = yield* Random.next;
                    yield* Effect.sleep(
                      storageFailure
                        ? 60_000
                        : Duration.toMillis(subscriptionRetryDelay(250, retries++)) *
                            (0.5 + jitter * 0.5),
                    );
                  });
                  while (true) {
                    yield* waitUntilVisible;
                    yield* SubscriptionRef.update(state, (current) =>
                      beginFleetSummarySubscription(current),
                    );
                    const started = yield* SubscriptionRef.get(state);
                    let quiet: Fiber.Fiber<void> | undefined;
                    const quietTimer = Effect.sleep("2 seconds").pipe(
                      Effect.andThen(
                        SubscriptionRef.update(state, (value): FleetSummaryState =>
                          value.epoch === started.epoch &&
                          value.cursor !== null &&
                          value.pending === null &&
                          value.error === null
                            ? { ...value, status: "live" }
                            : value,
                        ),
                      ),
                    );
                    const outcome = yield* Effect.exit(
                      Effect.gen(function* () {
                        const stream = yield* subscribeFleetSummaryInSession(
                          session.value,
                          started.cursor === null ? {} : { cursor: started.cursor },
                        );
                        quiet = yield* Effect.forkChild(quietTimer);
                        return yield* Stream.runForEach(stream, (event) =>
                          Effect.gen(function* () {
                            if (quiet !== undefined) yield* Fiber.interrupt(quiet);
                            yield* SubscriptionRef.update(state, (current) =>
                              applyFleetSummaryEvent(current, event, started.epoch),
                            );
                            const current = yield* SubscriptionRef.get(state);
                            if (current.epoch !== started.epoch) {
                              cache.snapshot = { sourceId, rows: current.rows, cursor: null };
                              yield* Queue.offer(wake, undefined);
                              return;
                            }
                            if (current.cursor !== null)
                              cache.snapshot = {
                                sourceId,
                                rows: current.rows,
                                cursor: current.cursor,
                              };
                            retries = 0;
                            quiet = yield* Effect.forkChild(quietTimer);
                          }),
                        ).pipe(Effect.raceFirst(Queue.take(wake)));
                      }),
                    );
                    if (quiet !== undefined) yield* Fiber.interrupt(quiet);
                    const current = yield* SubscriptionRef.get(state);
                    if (current.epoch !== started.epoch) {
                      yield* pauseBeforeRetry(false);
                      continue;
                    }
                    if (outcome._tag === "Failure" && isAuthorizationFailure(outcome.cause)) {
                      yield* SubscriptionRef.update(state, (value): FleetSummaryState => ({
                        ...value,
                        status: "error",
                        error: "forbidden",
                        pending: null,
                        eventBuffer: [],
                      }));
                      return;
                    }
                    const failure = outcome._tag === "Failure" ? Cause.squash(outcome.cause) : null;
                    const storage =
                      typeof failure === "object" &&
                      failure !== null &&
                      "reason" in failure &&
                      failure.reason === "storage";
                    yield* SubscriptionRef.update(state, (value): FleetSummaryState => ({
                      ...value,
                      status: storage ? "error" : "updating",
                      error: storage ? "storage" : null,
                      pending: null,
                      eventBuffer: [],
                    }));
                    yield* pauseBeforeRetry(storage);
                  }
                });
                yield* Effect.forkScoped(run);
                return Stream.never;
              }),
            );
          }),
        );
        yield* Effect.forkScoped(Stream.runDrain(sessions));
        return SubscriptionRef.changes(state);
      }),
    ),
  );
}

export function createFleetSummaryAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  waitUntilVisible: Effect.Effect<void> = Effect.void,
) {
  const resumeFamily = Atom.family((sourceId: EnvironmentId) =>
    Atom.make((): ResumeCache => ({ snapshot: null })).pipe(
      Atom.setIdleTTL(600_000),
      Atom.withLabel(`fleet-summary-resume:${sourceId}`),
    ),
  );
  const family = Atom.family((sourceId: EnvironmentId) => {
    const resume = resumeFamily(sourceId);
    return runtime
      .atom(
        (get) => {
          get.mount(resume);
          return provideEnvironmentStreamPermissions(
            runtime,
            fleetSummaryChanges(sourceId, get.once(resume), waitUntilVisible),
          );
        },
        { initialValue: initialFleetSummaryState(sourceId) },
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`fleet-summary:${sourceId}`));
  });
  return { stateAtom: family };
}
