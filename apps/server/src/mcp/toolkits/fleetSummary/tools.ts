import {
  FleetSummaryReportInput,
  FleetSummaryWriteResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as FleetSummary from "../../../ledger/FleetSummary.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [FleetSummary.FleetSummary, McpInvocationContext.McpInvocationContext];
const FleetSummaryReportTool = Tool.make("fleet_summary_report", {
  description: "Report one fleet summary row from this linked environment.",
  parameters: FleetSummaryReportInput,
  success: FleetSummaryWriteResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
});
export const FleetSummaryToolkit = Toolkit.make(FleetSummaryReportTool);
