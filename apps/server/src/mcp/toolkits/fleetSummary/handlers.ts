import { FleetSummaryError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as FleetSummary from "../../../ledger/FleetSummary.ts";
import { FleetSummaryToolkit } from "./tools.ts";

const handlers = {
  fleet_summary_report: McpToolAccess.writesForLinkedClient((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.client?.linked !== true || scope.client.environmentId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Linked environment required.",
        });
      const service = yield* FleetSummary.FleetSummary;
      return yield* service.report(scope.client.environmentId, input).pipe(
        Effect.mapError((error: FleetSummaryError) =>
          error.reason === "lease-required"
            ? new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "fleet-summary:lease-required",
              })
            : new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof FleetSummaryToolkit.tools>;
export const layer = McpToolAccess.toLayer(FleetSummaryToolkit, handlers);
