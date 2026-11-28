import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";

export const FleetTermExchangeInput = Schema.Struct({
  term: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  coordinatorId: EnvironmentId,
});
export type FleetTermExchangeInput = typeof FleetTermExchangeInput.Type;

/** The answering machine's converged snapshot, so the caller learns the larger term it may not know. */
export const FleetTermExchangeResult = Schema.Struct({
  term: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  coordinatorId: Schema.NullOr(EnvironmentId),
});
export type FleetTermExchangeResult = typeof FleetTermExchangeResult.Type;

export const FleetTermHandoverInput = Schema.Struct({
  /**
   * The machine the coordinator hands over to. It must be the calling machine;
   * omitted means the caller itself.
   */
  target: Schema.optional(EnvironmentId),
});
export type FleetTermHandoverInput = typeof FleetTermHandoverInput.Type;

/**
 * `handed-over` when the target acknowledged the new term, `handed-over-unconfirmed`
 * when the local term moved but the target could not be reached. `stale` carries the
 * snapshot that won instead; this machine adopts it, so the fleet keeps one term.
 */
export const FleetTermHandoverResult = Schema.Struct({
  outcome: Schema.Literals(["handed-over", "handed-over-unconfirmed", "stale"]),
  term: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  coordinatorId: Schema.NullOr(EnvironmentId),
});
export type FleetTermHandoverResult = typeof FleetTermHandoverResult.Type;

/**
 * `taken-over` when this machine is now the coordinator, `needs-confirmation` when
 * the current coordinator cannot be reached and no force was given: nothing changed.
 * `stale` carries the snapshot that won instead; this machine adopts it.
 */
export const FleetTermTakeoverResult = Schema.Struct({
  outcome: Schema.Literals(["taken-over", "needs-confirmation", "stale"]),
  term: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  coordinatorId: Schema.NullOr(EnvironmentId),
});
export type FleetTermTakeoverResult = typeof FleetTermTakeoverResult.Type;

export class FleetCoordinatorError extends Schema.TaggedError<FleetCoordinatorError>()(
  "FleetCoordinatorError",
  {
    reason: Schema.Literals([
      "storage",
      "unknown-coordinator",
      "unknown-target",
      "third-party-target",
      "peer-unreachable",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
