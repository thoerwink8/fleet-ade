import {
  FleetTermExchangeInput,
  FleetTermExchangeResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as FleetCoordinator from "../../../ledger/FleetCoordinator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const FleetTermExchangeTool = Tool.make("fleet_term_exchange", {
  description:
    "Exchanges coordinator terms with this environment, which adopts the larger one and answers with its converged snapshot.",
  parameters: FleetTermExchangeInput,
  success: FleetTermExchangeResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [FleetCoordinator.FleetCoordinator, McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Exchange coordinator term")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToLinkedClients);

export const FleetCoordinatorToolkit = Toolkit.make(FleetTermExchangeTool);
