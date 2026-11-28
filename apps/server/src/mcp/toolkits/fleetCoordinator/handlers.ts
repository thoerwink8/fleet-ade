import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as FleetCoordinator from "../../../ledger/FleetCoordinator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FleetCoordinatorToolkit } from "./tools.ts";

const linkedClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.filterOrFail(
    (scope) => scope.client?.linked === true,
    () =>
      new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Coordinator term exchange accepts linked T3 environments only.",
      }),
  ),
);

const handlers = {
  fleet_term_exchange: McpToolAccess.writesForLinkedClient((input) =>
    Effect.gen(function* () {
      const scope = yield* linkedClient;
      const environmentId = scope.client?.environmentId;
      if (environmentId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Update the linked environment to exchange coordinator terms; it does not prove its environment identity.",
        });
      }
      const coordinator = yield* FleetCoordinator.FleetCoordinator;
      return yield* coordinator.exchange({ environmentId }, input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code:
                error.reason === "unknown-coordinator" ? "invalid_request" : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
  fleet_term_handover: McpToolAccess.writesForLinkedClient((input) =>
    Effect.gen(function* () {
      const scope = yield* linkedClient;
      const environmentId = scope.client?.environmentId;
      if (environmentId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Update the linked environment to take the fleet coordinator over; it does not prove its environment identity.",
        });
      }
      const coordinator = yield* FleetCoordinator.FleetCoordinator;
      return yield* coordinator
        .requestHandover({ environmentId: EnvironmentId.make(environmentId) }, input.target)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code:
                  error.reason === "third-party-target" || error.reason === "unknown-target"
                    ? "invalid_request"
                    : "orchestration_error",
                message: error.message,
              }),
          ),
        );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof FleetCoordinatorToolkit.tools>;

export const layer = McpToolAccess.toLayer(FleetCoordinatorToolkit, handlers);
