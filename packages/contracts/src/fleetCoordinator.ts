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

export class FleetCoordinatorError extends Schema.TaggedError<FleetCoordinatorError>()(
  "FleetCoordinatorError",
  {
    reason: Schema.Literals(["storage", "unknown-coordinator"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
