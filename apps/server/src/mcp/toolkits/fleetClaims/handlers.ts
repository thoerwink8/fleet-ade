import { FleetClaimsError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as FleetClaims from "../../../ledger/FleetClaims.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FleetClaimsToolkit } from "./tools.ts";

const linkedClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.filterOrFail(
    (scope) => scope.client?.linked === true,
    () =>
      new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Fleet control RPCs accept linked T3 environments only.",
      }),
  ),
);

export const missingLinkedEnvironment = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "旧链接，请重新链接",
  });
const fromFleetClaimsError = (error: FleetClaimsError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "unknown-repo" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const handlers = {
  fleet_claim: McpToolAccess.writesForLinkedClient((input) =>
    Effect.gen(function* () {
      const scope = yield* linkedClient;
      const environmentId = scope.client?.environmentId;
      if (environmentId === undefined) return yield* missingLinkedEnvironment();
      const claims = yield* FleetClaims.FleetClaims;
      return yield* claims
        .claim({ sessionId: scope.client!.sessionId, environmentId }, input)
        .pipe(Effect.mapError(fromFleetClaimsError));
    }),
  ),
  fleet_renew: McpToolAccess.writesForLinkedClient((input) =>
    Effect.gen(function* () {
      const scope = yield* linkedClient;
      const environmentId = scope.client?.environmentId;
      if (environmentId === undefined) return yield* missingLinkedEnvironment();
      const claims = yield* FleetClaims.FleetClaims;
      return yield* claims
        .renew({ sessionId: scope.client!.sessionId, environmentId }, input)
        .pipe(Effect.mapError(fromFleetClaimsError));
    }),
  ),
  fleet_release: McpToolAccess.writesForLinkedClient((input) =>
    Effect.gen(function* () {
      const scope = yield* linkedClient;
      const environmentId = scope.client?.environmentId;
      if (environmentId === undefined) return yield* missingLinkedEnvironment();
      const claims = yield* FleetClaims.FleetClaims;
      return yield* claims
        .release({ sessionId: scope.client!.sessionId, environmentId }, input)
        .pipe(Effect.mapError(fromFleetClaimsError));
    }),
  ),
  fleet_heartbeat: McpToolAccess.writesForLinkedClient((input) =>
    Effect.gen(function* () {
      const scope = yield* linkedClient;
      const environmentId = scope.client?.environmentId;
      if (environmentId === undefined) return yield* missingLinkedEnvironment();
      const claims = yield* FleetClaims.FleetClaims;
      return yield* claims
        .heartbeat(environmentId, input)
        .pipe(Effect.mapError(fromFleetClaimsError));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof FleetClaimsToolkit.tools>;

export const layer = McpToolAccess.toLayer(FleetClaimsToolkit, handlers);
