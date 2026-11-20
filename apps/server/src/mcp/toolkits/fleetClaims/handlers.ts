import { FleetClaimsError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as FleetClaims from "../../../ledger/FleetClaims.ts";
import * as PeerChallengeRegistry from "../../../peer/PeerChallengeRegistry.ts";
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

const missingLinkedEnvironment = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      "Update the linked environment to claim fleet tasks. Existing leases can still be renewed or released.",
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
      // Old leases were owned by this signed session ID, not a machine ID.
      const environmentId = scope.client?.environmentId ?? scope.client!.sessionId;
      const claims = yield* FleetClaims.FleetClaims;
      return yield* claims
        .renew({ sessionId: scope.client!.sessionId, environmentId }, input)
        .pipe(Effect.mapError(fromFleetClaimsError));
    }),
  ),
  fleet_release: McpToolAccess.writesForLinkedClient((input) =>
    Effect.gen(function* () {
      const scope = yield* linkedClient;
      const environmentId = scope.client?.environmentId ?? scope.client!.sessionId;
      const claims = yield* FleetClaims.FleetClaims;
      return yield* claims
        .release({ sessionId: scope.client!.sessionId, environmentId }, input)
        .pipe(Effect.mapError(fromFleetClaimsError));
    }),
  ),
  fleet_heartbeat: McpToolAccess.writesForLinkedClient((input) =>
    Effect.gen(function* () {
      const scope = yield* linkedClient;
      const environmentId = scope.client?.environmentId ?? scope.client!.sessionId;
      const claims = yield* FleetClaims.FleetClaims;
      return yield* claims
        .heartbeat(
          environmentId,
          input,
          scope.client?.environmentId !== undefined,
          scope.client!.sessionId,
        )
        .pipe(Effect.mapError(fromFleetClaimsError));
    }),
  ),
  fleet_peer_proof: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* linkedClient;
      const registry = yield* PeerChallengeRegistry.PeerChallengeRegistry;
      if (!(yield* registry.consume(input.challenge, input.target, input.bearerDigest))) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Peer link challenge is invalid, expired, or already used.",
        });
      }
      return { environmentId: scope.environmentId };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof FleetClaimsToolkit.tools>;

export const layer = McpToolAccess.toLayer(FleetClaimsToolkit, handlers);
