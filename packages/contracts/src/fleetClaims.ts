import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FleetClaimKey = Schema.Struct({
  repo: TrimmedNonEmptyString,
  issue: Schema.Int.check(Schema.isGreaterThan(0)),
  taskId: TrimmedNonEmptyString,
});
export type FleetClaimKey = typeof FleetClaimKey.Type;

export const FleetClaim = Schema.Struct({
  fleetId: TrimmedNonEmptyString,
  ...FleetClaimKey.fields,
  holder: TrimmedNonEmptyString,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  fencing: TrimmedNonEmptyString,
  leaseUntil: Schema.String,
  holderEnvironment: Schema.optional(TrimmedNonEmptyString),
});
export type FleetClaim = typeof FleetClaim.Type;

export const FleetClaimClaimInput = Schema.Struct({
  ...FleetClaimKey.fields,
  idempotencyKey: TrimmedNonEmptyString,
});
export type FleetClaimClaimInput = typeof FleetClaimClaimInput.Type;

export const FleetClaimLeaseInput = Schema.Struct({
  ...FleetClaimKey.fields,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  fencing: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
});
export type FleetClaimLeaseInput = typeof FleetClaimLeaseInput.Type;

export const FleetClaimClaimResult = Schema.Struct({
  outcome: Schema.Literals(["claimed", "already-held", "stale"]),
  claim: Schema.NullOr(FleetClaim),
});
export type FleetClaimClaimResult = typeof FleetClaimClaimResult.Type;

export const FleetClaimLeaseResult = Schema.Struct({
  outcome: Schema.Literals(["renewed", "released", "stale"]),
  claim: Schema.NullOr(FleetClaim),
});
export type FleetClaimLeaseResult = typeof FleetClaimLeaseResult.Type;

export const FleetClaimHeartbeatItem = Schema.Struct({
  ...FleetClaimKey.fields,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  fencing: TrimmedNonEmptyString,
});
export type FleetClaimHeartbeatItem = typeof FleetClaimHeartbeatItem.Type;

export const FleetClaimHeartbeatInput = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  leases: Schema.Array(FleetClaimHeartbeatItem),
});
export type FleetClaimHeartbeatInput = typeof FleetClaimHeartbeatInput.Type;

export const FleetClaimHeartbeatOutcome = Schema.Literals([
  "renewed",
  "expired",
  "taken-over",
  "released",
  "not-claimed",
  "not-owned",
]);
export type FleetClaimHeartbeatOutcome = typeof FleetClaimHeartbeatOutcome.Type;

export const FleetClaimHeartbeatItemResult = Schema.Struct({
  ...FleetClaimKey.fields,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  outcome: FleetClaimHeartbeatOutcome,
  claim: Schema.NullOr(FleetClaim),
});
export type FleetClaimHeartbeatItemResult = typeof FleetClaimHeartbeatItemResult.Type;

export const FleetClaimHeartbeatResult = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  results: Schema.Array(FleetClaimHeartbeatItemResult),
});
export type FleetClaimHeartbeatResult = typeof FleetClaimHeartbeatResult.Type;

/** Client-only. A timeout or 503 never becomes `taken-over`. */
export const FleetLeaseConfirmation = Schema.Literals(["confirmed", "unconfirmed", "lost"]);
export type FleetLeaseConfirmation = typeof FleetLeaseConfirmation.Type;

export class FleetClaimsError extends Schema.TaggedError<FleetClaimsError>()("FleetClaimsError", {
  reason: Schema.Literals(["storage", "unknown-repo"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
