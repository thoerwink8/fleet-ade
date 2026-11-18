import {
  FLEET_HEARTBEAT_INTERVAL_MS,
  FLEET_LEASE_CONFIRMED_WINDOW_MS,
  FleetClaim,
  FleetClaimHeartbeatInput,
  FleetClaimHeartbeatResult,
  FleetClaimKey,
  FleetLeaseConfirmation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** Local edits and tests keep going while external writes wait for a confirmed lease. */
export const pausesLocalWork = false;

export class FleetHeartbeatUnconfirmed extends Schema.TaggedError<FleetHeartbeatUnconfirmed>()(
  "FleetHeartbeatUnconfirmed",
  { reason: Schema.Literals(["timeout", "unavailable"]) },
) {
  override get message(): string {
    return this.reason === "timeout"
      ? "The fleet heartbeat timed out."
      : "The fleet heartbeat was not accepted.";
  }
}

export class FleetHeartbeatTransport extends Context.Service<
  FleetHeartbeatTransport,
  {
    readonly send: (
      input: FleetClaimHeartbeatInput,
    ) => Effect.Effect<FleetClaimHeartbeatResult, FleetHeartbeatUnconfirmed>;
  }
>()("t3/ledger/FleetHeartbeat/FleetHeartbeatTransport") {}

interface HeldLease {
  readonly claim: FleetClaim;
  readonly phase: "confirmed" | "unconfirmed" | "lost";
  readonly confirmedAt: number | null;
}

const leaseId = (key: FleetClaimKey) => `${key.repo}\n${key.issue}\n${key.taskId}`;

export class FleetHeartbeat extends Context.Service<
  FleetHeartbeat,
  {
    readonly observe: (claim: FleetClaim) => Effect.Effect<void>;
    readonly beat: Effect.Effect<void>;
    readonly retry: Effect.Effect<void>;
    readonly run: Effect.Effect<void>;
    readonly holds: (key: FleetClaimKey) => Effect.Effect<boolean>;
    readonly canWriteExternally: (key: FleetClaimKey) => Effect.Effect<boolean>;
    readonly confirmation: (key: FleetClaimKey) => Effect.Effect<FleetLeaseConfirmation | null>;
    readonly outbound: Effect.Effect<{ readonly cycles: number; readonly retries: number }>;
  }
>()("t3/ledger/FleetHeartbeat") {}

const make = Effect.gen(function* () {
  const transport = yield* FleetHeartbeatTransport;
  const held = yield* Ref.make(new Map<string, HeldLease>());
  const sequence = yield* Ref.make(0);
  const applied = yield* Ref.make(0);
  const outboundCounts = yield* Ref.make({ cycles: 0, retries: 0 });

  const confirmationOf = (
    record: HeldLease | undefined,
    now: number,
  ): FleetLeaseConfirmation | null => {
    if (record === undefined) return null;
    if (record.phase === "lost") return "lost";
    if (
      record.phase === "confirmed" &&
      record.confirmedAt !== null &&
      now - record.confirmedAt <= FLEET_LEASE_CONFIRMED_WINDOW_MS
    ) {
      return "confirmed";
    }
    return "unconfirmed";
  };

  const observe = Effect.fn("FleetHeartbeat.observe")(function* (claim: FleetClaim) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(held, (current) => {
      const next = new Map(current);
      next.set(leaseId(claim), { claim, phase: "confirmed", confirmedAt: now });
      return next;
    });
  });

  const holds = Effect.fn("FleetHeartbeat.holds")(function* (key: FleetClaimKey) {
    return (yield* Ref.get(held)).has(leaseId(key));
  });

  const confirmation = Effect.fn("FleetHeartbeat.confirmation")(function* (key: FleetClaimKey) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return confirmationOf((yield* Ref.get(held)).get(leaseId(key)), now);
  });

  const canWriteExternally = Effect.fn("FleetHeartbeat.canWriteExternally")(function* (
    key: FleetClaimKey,
  ) {
    return (yield* confirmation(key)) === "confirmed";
  });

  const applyResult = (result: FleetClaimHeartbeatResult, now: number) =>
    Ref.update(held, (current) => {
      const next = new Map(current);
      for (const item of result.results) {
        const id = leaseId(item);
        const previous = next.get(id);
        if (item.outcome === "renewed" && item.claim !== null) {
          next.set(id, { claim: item.claim, phase: "confirmed", confirmedAt: now });
          continue;
        }
        if (
          item.outcome === "taken-over" ||
          item.outcome === "revoked" ||
          item.outcome === "not-owned"
        ) {
          if (previous !== undefined) {
            next.set(id, { ...previous, phase: "lost", confirmedAt: null });
          }
          continue;
        }
        if (previous !== undefined) {
          next.set(id, { ...previous, phase: "unconfirmed", confirmedAt: null });
        }
      }
      return next;
    });

  const send = Effect.fn("FleetHeartbeat.send")(function* (kind: "cycle" | "retry") {
    const seq = yield* Ref.updateAndGet(sequence, (current) => current + 1);
    const leases = [...(yield* Ref.get(held)).values()]
      .filter((record) => record.phase !== "lost")
      .map((record) => ({
        repo: record.claim.repo,
        issue: record.claim.issue,
        taskId: record.claim.taskId,
        attempt: record.claim.attempt,
        fencing: record.claim.fencing,
      }));
    const input = { sequence: seq, leases };
    yield* Ref.update(outboundCounts, (counts) =>
      kind === "cycle"
        ? { ...counts, cycles: counts.cycles + 1 }
        : { ...counts, retries: counts.retries + 1 },
    );
    const result = yield* transport.send(input).pipe(
      Effect.tap((value) =>
        Ref.modify(applied, (current) => {
          if (value.sequence <= current) return [false, current] as const;
          return [true, value.sequence] as const;
        }).pipe(
          Effect.flatMap((fresh) =>
            fresh
              ? DateTime.now.pipe(
                  Effect.flatMap((now) => applyResult(value, DateTime.toEpochMillis(now))),
                )
              : Effect.void,
          ),
        ),
      ),
      Effect.catch((error) =>
        Ref.modify(applied, (current) => {
          // A timeout is not a takeover, and an older timeout cannot cover a newer result.
          if (error.reason !== "timeout" && error.reason !== "unavailable") {
            return [false, current] as const;
          }
          if (seq <= current) return [false, current] as const;
          return [true, seq] as const;
        }).pipe(
          Effect.flatMap((mark) =>
            mark
              ? Ref.update(held, (current) => {
                  const next = new Map(current);
                  for (const [id, record] of next) {
                    if (record.phase !== "lost") {
                      next.set(id, { ...record, phase: "unconfirmed", confirmedAt: null });
                    }
                  }
                  return next;
                })
              : Effect.void,
          ),
        ),
      ),
    );
    return result;
  });

  const beat = send("cycle");
  const retry = send("retry");
  const run = beat.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(FLEET_HEARTBEAT_INTERVAL_MS))),
    Effect.asVoid,
  );
  const outbound = Ref.get(outboundCounts);

  return FleetHeartbeat.of({
    observe,
    beat,
    retry,
    run,
    holds,
    canWriteExternally,
    confirmation,
    outbound,
  });
});

export const layer = Layer.effect(FleetHeartbeat, make);

/** No leases are tracked, so pipeline writes that are not fleet-held stay open. */
export const layerUntracked = layer.pipe(
  Layer.provide(
    Layer.succeed(FleetHeartbeatTransport, {
      send: Effect.fn("FleetHeartbeatTransport.send")(() =>
        Effect.die(new Error("Fleet heartbeat transport is not configured.")),
      ),
    }),
  ),
);
