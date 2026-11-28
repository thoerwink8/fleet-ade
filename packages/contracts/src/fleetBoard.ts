import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Route prefix the same-origin fleet board proxy is served under. */
export const FLEET_BOARD_ROUTE_PREFIX = "/fleet-board";

/** Endpoint that probes or launches the machine-local board. */
export const FLEET_BOARD_ENSURE_PATH = "/api/fleet-board/ensure";

/**
 * What `POST /api/fleet-board/ensure` found or did. `detail` is user-facing
 * Chinese: why the board is not usable and how to fix it, or null when running.
 */
export const FleetBoardEnsureResult = Schema.Struct({
  status: Schema.Literals(["running", "not-installed", "port-taken", "failed"]),
  detail: Schema.NullOr(TrimmedNonEmptyString),
  checkedAt: Schema.String,
});
export type FleetBoardEnsureResult = typeof FleetBoardEnsureResult.Type;
