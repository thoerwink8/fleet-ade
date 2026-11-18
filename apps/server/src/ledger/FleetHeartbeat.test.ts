import { assert, it } from "@effect/vitest";
import {
  FleetClaim,
  FleetClaimHeartbeatInput,
  FleetClaimHeartbeatResult,
  FleetClaimKey,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as FleetHeartbeat from "./FleetHeartbeat.ts";

type Send = FleetHeartbeat.FleetHeartbeatTransport["Service"]["send"];

const key = (taskId: string): FleetClaimKey => ({
  repo: "example/one",
  issue: 7,
  taskId,
});

const claim = (taskId: string, attempt = 1): FleetClaim => ({
  fleetId: "coordinator",
  ...key(taskId),
  holder: "session",
  holderEnvironment: "node-a",
  attempt,
  fencing: String(attempt),
  leaseUntil: "1970-01-01T00:01:30.000Z",
});

const renewed = (
  input: FleetClaimHeartbeatInput,
  outcomes: ReadonlyArray<FleetClaimHeartbeatResult["results"][number]["outcome"]> = [],
): FleetClaimHeartbeatResult => ({
  sequence: input.sequence,
  results: input.leases.map((lease, index) => ({
    repo: lease.repo,
    issue: lease.issue,
    taskId: lease.taskId,
    attempt: lease.attempt,
    outcome: outcomes[index] ?? "renewed",
    claim:
      (outcomes[index] ?? "renewed") === "renewed"
        ? { ...claim(lease.taskId, lease.attempt), leaseUntil: "1970-01-01T00:03:00.000Z" }
        : null,
  })),
});

const layer = (send: Send) =>
  FleetHeartbeat.layer.pipe(
    Layer.provide(Layer.succeed(FleetHeartbeat.FleetHeartbeatTransport, { send })),
    Layer.provide(
      Layer.succeed(
        FleetHeartbeat.FleetHeartbeatConfigService,
        FleetHeartbeat.defaultFleetHeartbeatConfig,
      ),
    ),
  );
it.effect("observe starts unconfirmed", () =>
  Effect.gen(function* () {
    const send: Send = (input) => Effect.succeed(renewed(input));
    yield* Effect.gen(function* () {
      const heartbeat = yield* FleetHeartbeat.FleetHeartbeat;
      yield* heartbeat.observe(claim("initial"));
      assert.strictEqual(yield* heartbeat.confirmation(key("initial")), "unconfirmed");
      yield* heartbeat.beat;
      assert.strictEqual(yield* heartbeat.confirmation(key("initial")), "confirmed");
    }).pipe(Effect.provide(layer(send)));
  }),
);

it.effect("a takeover answered with a newer attempt is ignored", () =>
  Effect.gen(function* () {
    const send: Send = (input) =>
      input.sequence === 1
        ? Effect.succeed(renewed(input))
        : Effect.succeed({
            sequence: input.sequence,
            results: input.leases.map((lease) => ({
              ...key(lease.taskId),
              attempt: lease.attempt + 1,
              outcome: "taken-over" as const,
              claim: null,
            })),
          });
    yield* Effect.gen(function* () {
      const heartbeat = yield* FleetHeartbeat.FleetHeartbeat;
      yield* heartbeat.observe(claim("attempt"));
      yield* heartbeat.beat;
      assert.strictEqual(yield* heartbeat.confirmation(key("attempt")), "confirmed");
      yield* heartbeat.beat;
      assert.strictEqual(yield* heartbeat.confirmation(key("attempt")), "confirmed");
    }).pipe(Effect.provide(layer(send)));
  }),
);

it.effect("transport timeout is ten seconds", () =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<void>();
    const send: Send = () =>
      Effect.never.pipe(Effect.ensuring(Deferred.succeed(completed, undefined)));
    yield* Effect.gen(function* () {
      const heartbeat = yield* FleetHeartbeat.FleetHeartbeat;
      yield* heartbeat.observe(claim("timeout"));
      yield* heartbeat.beat.pipe(Effect.forkDetach);
      yield* TestClock.adjust(Duration.seconds(10));
      yield* Deferred.await(completed);
      assert.strictEqual(yield* heartbeat.confirmation(key("timeout")), "unconfirmed");
    }).pipe(Effect.provide(layer(send)));
  }),
);

it.effect("late response does not extend the send-time confirmation window", () =>
  Effect.gen(function* () {
    const response = yield* Deferred.make<void>();
    const send: Send = (input) => Deferred.await(response).pipe(Effect.as(renewed(input)));
    yield* Effect.gen(function* () {
      const heartbeat = yield* FleetHeartbeat.FleetHeartbeat;
      yield* heartbeat.observe(claim("late"));
      const beat = yield* heartbeat.beat.pipe(Effect.forkDetach);
      yield* TestClock.adjust(Duration.seconds(9));
      yield* Deferred.succeed(response, undefined);
      yield* Fiber.join(beat);
      assert.strictEqual(yield* heartbeat.confirmation(key("late")), "confirmed");
      yield* TestClock.adjust(
        Duration.millis(FleetHeartbeat.defaultFleetHeartbeatConfig.confirmedWindowMs - 9_000),
      );
      assert.strictEqual(yield* heartbeat.confirmation(key("late")), "confirmed");
      yield* TestClock.adjust(Duration.millis(1));
      assert.strictEqual(yield* heartbeat.confirmation(key("late")), "unconfirmed");
    }).pipe(Effect.provide(layer(send)));
  }),
);

it.effect("not-owned becomes lost", () =>
  Effect.gen(function* () {
    const send: Send = (input) => Effect.succeed(renewed(input, ["not-owned"]));
    yield* Effect.gen(function* () {
      const heartbeat = yield* FleetHeartbeat.FleetHeartbeat;
      yield* heartbeat.observe(claim("not-owned"));
      yield* heartbeat.beat;
      assert.strictEqual(yield* heartbeat.confirmation(key("not-owned")), "lost");
    }).pipe(Effect.provide(layer(send)));
  }),
);

it.effect("run sends 50 leases once per cycle", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<FleetClaimHeartbeatInput>();
    const send: Send = (input) =>
      Queue.offer(calls, input).pipe(Effect.andThen(Effect.succeed(renewed(input))));
    yield* Effect.gen(function* () {
      const heartbeat = yield* FleetHeartbeat.FleetHeartbeat;
      yield* Effect.forEach(
        Array.from({ length: 50 }, (_, index) => index),
        (index) => heartbeat.observe(claim(`run-${index}`)),
      );
      const runner = yield* heartbeat.run.pipe(Effect.forkDetach);
      assert.strictEqual((yield* Queue.take(calls)).leases.length, 50);
      yield* TestClock.adjust(
        Duration.millis(FleetHeartbeat.defaultFleetHeartbeatConfig.heartbeatIntervalMs),
      );
      assert.strictEqual((yield* Queue.take(calls)).leases.length, 50);
      assert.strictEqual(yield* Queue.size(calls), 0);
      yield* Fiber.interrupt(runner);
    }).pipe(Effect.provide(layer(send)));
  }),
);
it.effect("一次心跳里成功和 stale 一起回来，超时不会变成接管", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<FleetClaimHeartbeatInput>>([]);
    const sendRef = yield* Ref.make<Send>(() =>
      Effect.fail(new FleetHeartbeat.FleetHeartbeatUnconfirmed({ reason: "timeout" })),
    );
    const send: Send = (input) => Ref.get(sendRef).pipe(Effect.flatMap((doSend) => doSend(input)));
    yield* Effect.gen(function* () {
      const heartbeat = yield* FleetHeartbeat.FleetHeartbeat;
      yield* heartbeat.observe(claim("root"));
      yield* heartbeat.observe(claim("child"));
      yield* Ref.set(sendRef, (input) =>
        Ref.update(calls, (current) => [...current, input]).pipe(
          Effect.as(renewed(input, ["renewed", "taken-over"])),
        ),
      );
      yield* heartbeat.beat;
      assert.strictEqual(yield* heartbeat.confirmation(key("root")), "confirmed");
      assert.strictEqual(yield* heartbeat.confirmation(key("child")), "lost");
      assert.strictEqual(yield* heartbeat.canWriteExternally(key("root")), true);
      assert.strictEqual(yield* heartbeat.canWriteExternally(key("child")), false);
      assert.strictEqual(FleetHeartbeat.pausesLocalWork, false);
      assert.strictEqual((yield* Ref.get(calls)).length, 1);

      yield* Ref.set(sendRef, () =>
        Effect.fail(new FleetHeartbeat.FleetHeartbeatUnconfirmed({ reason: "timeout" })),
      );
      yield* heartbeat.beat;
      assert.strictEqual(yield* heartbeat.confirmation(key("root")), "unconfirmed");
      assert.strictEqual(yield* heartbeat.confirmation(key("child")), "lost");
      assert.strictEqual(yield* heartbeat.canWriteExternally(key("root")), false);
    }).pipe(Effect.provide(layer(send)));
  }),
);

it.effect("旧响应和旧超时盖不过更新的结果", () =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<FleetClaimHeartbeatResult>();

    const sendRef = yield* Ref.make<Send>(() =>
      Effect.fail(new FleetHeartbeat.FleetHeartbeatUnconfirmed({ reason: "timeout" })),
    );
    const send: Send = (input) => Ref.get(sendRef).pipe(Effect.flatMap((doSend) => doSend(input)));
    yield* Effect.gen(function* () {
      const heartbeat = yield* FleetHeartbeat.FleetHeartbeat;
      yield* heartbeat.observe(claim("root"));

      // A slow first response arrives after a newer cycle already confirmed the lease.
      const invoked = yield* Deferred.make<FleetClaimHeartbeatInput>();
      yield* Ref.set(sendRef, (input) =>
        Deferred.succeed(invoked, input).pipe(Effect.andThen(Deferred.await(first))),
      );
      const slow = yield* heartbeat.beat.pipe(Effect.forkDetach);
      const invokedInput = yield* Deferred.await(invoked);
      assert.strictEqual(invokedInput.sequence, 1);
      yield* Ref.set(sendRef, (input) => Effect.succeed(renewed(input)));
      yield* heartbeat.beat;
      assert.strictEqual(yield* heartbeat.confirmation(key("root")), "confirmed");
      yield* Deferred.succeed(first, {
        sequence: 1,
        results: [{ ...key("root"), attempt: 1, outcome: "taken-over", claim: null }],
      });
      yield* Fiber.join(slow);
      assert.strictEqual(yield* heartbeat.confirmation(key("root")), "confirmed");

      // An older timeout landing after a newer confirmation cannot unset it either.
      const invokedTimeout = yield* Deferred.make<FleetClaimHeartbeatInput>();
      const lateTimeout = yield* Deferred.make<void>();
      yield* Ref.set(sendRef, (input) =>
        input.sequence === 3
          ? Deferred.succeed(invokedTimeout, input).pipe(
              Effect.andThen(Deferred.await(lateTimeout)),
              Effect.andThen(
                Effect.fail(new FleetHeartbeat.FleetHeartbeatUnconfirmed({ reason: "timeout" })),
              ),
            )
          : Effect.succeed(renewed(input)),
      );
      const timed = yield* heartbeat.beat.pipe(Effect.forkDetach);
      assert.strictEqual((yield* Deferred.await(invokedTimeout)).sequence, 3);
      yield* heartbeat.beat;
      yield* Deferred.succeed(lateTimeout, undefined);
      yield* Fiber.join(timed);
      assert.strictEqual(yield* heartbeat.confirmation(key("root")), "confirmed");
    }).pipe(Effect.provide(layer(send)));
  }),
);

it.effect("50 条租约每个周期只出站一次，重试另计", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const sizes = yield* Ref.make<ReadonlyArray<number>>([]);
    const send: Send = (input) =>
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.andThen(Ref.update(sizes, (current) => [...current, input.leases.length])),
        Effect.as(renewed(input)),
      );
    yield* Effect.gen(function* () {
      const heartbeat = yield* FleetHeartbeat.FleetHeartbeat;
      yield* Effect.forEach(
        Array.from({ length: 50 }, (_, index) => index),
        (index) => heartbeat.observe(claim(`task-${index}`)),
      );
      yield* heartbeat.beat;
      yield* heartbeat.retry;
      assert.deepEqual(yield* heartbeat.outbound, { cycles: 1, retries: 1 });
    }).pipe(Effect.provide(layer(send)));
    assert.deepEqual(yield* Ref.get(sizes), [50, 50]);
    assert.strictEqual(yield* Ref.get(calls), 2);
  }),
);

it.effect("确认超过 45 秒变未确认，周期仍是 30 秒", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<FleetClaimHeartbeatInput>();
    const send: Send = (input) => Queue.offer(calls, input).pipe(Effect.as(renewed(input)));
    yield* Effect.gen(function* () {
      const heartbeat = yield* FleetHeartbeat.FleetHeartbeat;
      yield* heartbeat.observe(claim("root"));
      yield* heartbeat.beat;
      yield* Queue.take(calls);
      assert.strictEqual(yield* heartbeat.canWriteExternally(key("root")), true);
      yield* TestClock.adjust(
        Duration.millis(FleetHeartbeat.defaultFleetHeartbeatConfig.confirmedWindowMs),
      );
      assert.strictEqual(yield* heartbeat.canWriteExternally(key("root")), true);
      yield* TestClock.adjust(Duration.millis(1));
      assert.strictEqual(yield* heartbeat.canWriteExternally(key("root")), false);
      assert.strictEqual(yield* heartbeat.confirmation(key("root")), "unconfirmed");

      const runner = yield* heartbeat.run.pipe(Effect.forkDetach);
      yield* Queue.take(calls);
      yield* TestClock.adjust(
        Duration.millis(FleetHeartbeat.defaultFleetHeartbeatConfig.heartbeatIntervalMs),
      );
      yield* Queue.take(calls);
      yield* TestClock.adjust(
        Duration.millis(FleetHeartbeat.defaultFleetHeartbeatConfig.heartbeatIntervalMs),
      );
      yield* Queue.take(calls);
      assert.strictEqual(yield* Queue.size(calls), 0);
      yield* Fiber.interrupt(runner);
    }).pipe(Effect.provide(layer(send)));
  }),
);
