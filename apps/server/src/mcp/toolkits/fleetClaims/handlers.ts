import { FleetClaimsError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as FleetClaims from "../../../ledger/FleetClaims.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FleetClaimsToolkit } from "./tools.ts";

const requireLinkedClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.filterOrFail(
    (scope) => scope.client?.linked === true,
    () =>
      new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Fleet control RPCs accept linked T3 environments only.",
      }),
  ),
);

const fromFleetClaimsError = (error: FleetClaimsError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "unknown-repo" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const handlers = {
  fleet_claim: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        yield* requireLinkedClient;
        const claims = yield* FleetClaims.FleetClaims;
        return yield* claims.claim(input).pipe(Effect.mapError(fromFleetClaimsError));
      }),
    { linkedCallers: "allowed" },
  ),
  fleet_renew: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        yield* requireLinkedClient;
        const claims = yield* FleetClaims.FleetClaims;
        return yield* claims.renew(input).pipe(Effect.mapError(fromFleetClaimsError));
      }),
    { linkedCallers: "allowed" },
  ),
  fleet_release: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        yield* requireLinkedClient;
        const claims = yield* FleetClaims.FleetClaims;
        return yield* claims.release(input).pipe(Effect.mapError(fromFleetClaimsError));
      }),
    { linkedCallers: "allowed" },
  ),
} satisfies McpToolAccess.Handlers<typeof FleetClaimsToolkit.tools>;

export const layer = McpToolAccess.toLayer(FleetClaimsToolkit, handlers);
