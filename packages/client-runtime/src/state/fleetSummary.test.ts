import { describe, expect, it } from "@effect/vitest";
import type { FleetSummaryRow } from "@t3tools/contracts";
import {
  EnvironmentId,
  FleetSummaryError,
  WS_METHODS,
  type FleetSummaryEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import {
  applyFleetSummaryEvent,
  beginFleetSummarySubscription,
  fleetSummaryRowKey,
  fleetSummaryChanges,
  initialFleetSummaryState,
} from "./fleetSummary.ts";

const isFleetSummaryError = Schema.is(FleetSummaryError);

const row = (id: number, revision = 1): FleetSummaryRow => ({
  environmentId: "env",
  threadId: String(id),
  title: String(id),
  phase: "working",
  reason: "",
  needsYou: false,
  lastProgress: "",
  updatedAt: "2026-01-01T00:00:00Z",
  stale: false,
  revision,
});

describe("fleet summary snapshots", () => {
  it("commits five pages together and applies buffered changes in order", () => {
    let state = beginFleetSummarySubscription(initialFleetSummaryState("source"));
    const epoch = state.epoch;
    for (let page = 1; page <= 5; page++) {
      state = applyFleetSummaryEvent(state, {
        type: "snapshot",
        revision: 10,
        page,
        pageCount: 5,
        rows: Array.from({ length: 200 }, (_, i) => row((page - 1) * 200 + i)),
      });
      if (page === 1)
        state = applyFleetSummaryEvent(state, { type: "upsert", revision: 12, row: row(1, 12) });
      if (page < 5) expect(state.rows.size).toBe(0);
    }
    expect(state.rows.size).toBe(1000);
    expect(state.cursor).toBe(12);
    expect(state.rows.get(fleetSummaryRowKey(row(1)))?.revision).toBe(12);
    state = applyFleetSummaryEvent(state, { type: "upsert", revision: 20, row: row(1, 2) });
    expect(state.rows.get(fleetSummaryRowKey(row(1)))?.revision).toBe(12);
    expect(state.epoch).toBe(epoch);
    expect(state.cursor).toBe(20);
    state = applyFleetSummaryEvent(state, { type: "tombstone", revision: 22, key: row(1) });
    expect(state.rows.has(fleetSummaryRowKey(row(1)))).toBe(false);
    state = applyFleetSummaryEvent(state, { type: "resync", reason: "gap" });
    expect(state.rows.size).toBe(999);
    expect(state.cursor).toBeNull();
    expect(
      applyFleetSummaryEvent(state, { type: "tombstone", revision: 23, key: row(2) }, epoch),
    ).toBe(state);
    state = applyFleetSummaryEvent(state, {
      type: "snapshot",
      revision: 23,
      page: 1,
      pageCount: 1,
      rows: [row(2)],
    });
    expect(state.rows.size).toBe(1);
  });
  it("discards partial pages on reconnect without a cursor", () => {
    let state = beginFleetSummarySubscription(initialFleetSummaryState("source"));
    state = applyFleetSummaryEvent(state, {
      type: "snapshot",
      revision: 1,
      page: 1,
      pageCount: 2,
      rows: [row(1)],
    });
    state = beginFleetSummarySubscription(state);
    expect(state.pending).toBeNull();
    expect(state.cursor).toBeNull();
  });
  it("uses the server task and ad-hoc row identities", () => {
    expect(fleetSummaryRowKey(row(1))).toBe("adhoc\nenv\n1");
    expect(
      fleetSummaryRowKey({ environmentId: "env", repo: "repo", issue: 3, taskId: "task" }),
    ).toBe("task\nenv\nrepo\n3\ntask");
  });
});

it.effect("resubscribes with the committed cursor and clears it on resync", () =>
  Effect.gen(function* () {
    const source = EnvironmentId.make("source");
    const inputs = yield* Queue.unbounded<{ cursor?: number }>();
    const events = yield* Queue.unbounded<FleetSummaryEvent | FleetSummaryError>();
    const states = yield* Queue.unbounded<{ cursor: number; ids: (string | undefined)[] }>();
    const initialStates = yield* Queue.unbounded<(string | undefined)[]>();
    const visible = yield* Deferred.make<void>();
    const waitForVisible = yield* Ref.make(false);
    const failed = yield* Queue.unbounded<void>();
    const partial = yield* Queue.unbounded<void>();
    const session = {
      client: {
        [WS_METHODS.fleetSummarySubscribe]: (input: { cursor?: number }) =>
          Stream.fromEffect(Queue.offer(inputs, input)).pipe(
            Stream.drain,
            Stream.concat(
              Stream.fromQueue(events).pipe(
                Stream.mapEffect((event) =>
                  isFleetSummaryError(event) ? Effect.fail(event) : Effect.succeed(event),
                ),
              ),
            ),
          ),
      },
    } as unknown as RpcSession;
    const sessions = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.some(session));
    const supervisor = {
      target: { environmentId: source },
      session: sessions,
    } as unknown as typeof EnvironmentSupervisor.EnvironmentSupervisor.Service;
    const registry = {
      followStream: (
        _id: EnvironmentId,
        stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor.EnvironmentSupervisor>,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as unknown as typeof EnvironmentRegistry.EnvironmentRegistry.Service;
    const cache = {
      snapshot: {
        sourceId: "other-source",
        rows: new Map([[fleetSummaryRowKey(row(8)), row(8)]]),
        cursor: 44,
      },
    };
    const follow = fleetSummaryChanges(
      source,
      cache,
      Effect.gen(function* () {
        if (yield* Ref.get(waitForVisible)) yield* Deferred.await(visible);
      }),
    ).pipe(
      Stream.runForEach((state) =>
        state.error === "storage"
          ? Queue.offer(failed, undefined)
          : state.pending !== null
            ? Queue.offer(partial, undefined)
            : state.cursor === null
              ? Queue.offer(
                  initialStates,
                  [...state.rows.values()].map((entry) => entry.threadId),
                )
              : Queue.offer(states, {
                  cursor: state.cursor,
                  ids: [...state.rows.values()].map((entry) => entry.threadId),
                }),
      ),
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
    );
    let follower = yield* Effect.forkScoped(follow);
    expect(yield* Queue.take(inputs)).toEqual({});
    expect(yield* Queue.take(initialStates)).toEqual([]);
    yield* Queue.offer(events, {
      type: "snapshot",
      revision: 8,
      page: 1,
      pageCount: 2,
      rows: [row(9)],
    });
    yield* Queue.take(partial);
    expect(yield* Queue.take(initialStates)).toEqual([]);
    yield* SubscriptionRef.set(sessions, Option.none());
    yield* SubscriptionRef.set(sessions, Option.some(session));
    expect(yield* Queue.take(inputs)).toEqual({});
    yield* Queue.offer(events, {
      type: "snapshot",
      revision: 10,
      page: 1,
      pageCount: 2,
      rows: [row(1)],
    });
    yield* Queue.take(partial);
    yield* Queue.offer(events, {
      type: "snapshot",
      revision: 10,
      page: 2,
      pageCount: 2,
      rows: [row(2)],
    });
    expect(yield* Queue.take(states)).toEqual({ cursor: 10, ids: ["1", "2"] });
    yield* SubscriptionRef.set(sessions, Option.none());
    yield* SubscriptionRef.set(sessions, Option.some(session));
    expect(yield* Queue.take(inputs)).toEqual({ cursor: 10 });
    expect(yield* Queue.take(states)).toEqual({ cursor: 10, ids: ["1", "2"] });
    yield* SubscriptionRef.set(sessions, Option.none());
    yield* SubscriptionRef.set(sessions, Option.some(session));
    expect(yield* Queue.take(inputs)).toEqual({ cursor: 10 });
    expect(yield* Queue.take(states)).toEqual({ cursor: 10, ids: ["1", "2"] });
    yield* Ref.set(waitForVisible, true);
    yield* Queue.offer(events, new FleetSummaryError({ reason: "storage", message: "failed" }));
    yield* Queue.take(failed);
    yield* Fiber.interrupt(follower);
    follower = yield* Effect.forkScoped(follow);
    yield* Deferred.succeed(visible, undefined);
    expect(yield* Queue.take(inputs)).toEqual({ cursor: 10 });
    yield* Queue.offer(events, { type: "resync", reason: "gap" });
    expect(yield* Queue.take(inputs)).toEqual({});
  }),
);
