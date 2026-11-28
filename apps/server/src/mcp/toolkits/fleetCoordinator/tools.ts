import {
  FleetTermExchangeInput,
  FleetTermExchangeResult,
  FleetTermHandoverInput,
  FleetTermHandoverResult,
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

const FleetTermHandoverTool = Tool.make("fleet_term_handover", {
  description:
    "Asks this environment to hand the fleet coordinator over to the calling machine. The target can only be the caller itself.",
  parameters: FleetTermHandoverInput,
  success: FleetTermHandoverResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [FleetCoordinator.FleetCoordinator, McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Hand over the fleet coordinator")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToLinkedClients);

export const FleetCoordinatorToolkit = Toolkit.make(FleetTermExchangeTool, FleetTermHandoverTool);
