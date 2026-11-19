import {
  FleetClaimClaimInput,
  FleetClaimClaimResult,
  FleetClaimHeartbeatInput,
  FleetClaimHeartbeatResult,
  FleetClaimLeaseInput,
  FleetClaimLeaseResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as FleetClaims from "../../../ledger/FleetClaims.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [FleetClaims.FleetClaims, McpInvocationContext.McpInvocationContext];

const FleetClaimTool = Tool.make("fleet_claim", {
  description: "Claims one fleet task lease on this coordinator.",
  parameters: FleetClaimClaimInput,
  success: FleetClaimClaimResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Claim fleet task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToLinkedClients);

const FleetRenewTool = Tool.make("fleet_renew", {
  description: "Renews one fleet task lease on this coordinator.",
  parameters: FleetClaimLeaseInput,
  success: FleetClaimLeaseResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Renew fleet task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToLinkedClients);

const FleetReleaseTool = Tool.make("fleet_release", {
  description: "Releases one fleet task lease on this coordinator.",
  parameters: FleetClaimLeaseInput,
  success: FleetClaimLeaseResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Release fleet task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToLinkedClients);

const FleetHeartbeatTool = Tool.make("fleet_heartbeat", {
  description: "Renews every fleet lease this linked environment still holds, in one request.",
  parameters: FleetClaimHeartbeatInput,
  success: FleetClaimHeartbeatResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Heartbeat fleet leases")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleToLinkedClients);

export const FleetClaimsToolkit = Toolkit.make(
  FleetClaimTool,
  FleetRenewTool,
  FleetReleaseTool,
  FleetHeartbeatTool,
);
