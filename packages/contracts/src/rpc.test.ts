import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { FleetClaim } from "./fleetClaims.ts";
import { FleetSummaryReportInput } from "./fleetSummary.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("WebSocket RPC contracts", () => {
  it("decodes legacy fleet payloads without added fields", () => {
    const claim = {
      fleetId: "fleet-1",
      repo: "example/one",
      issue: 7,
      taskId: "root",
      holder: "session-a",
      attempt: 1,
      fencing: "1",
      leaseUntil: "2999-01-01T00:00:00.000Z",
    };
    const report = {
      type: "upsert-task",
      repo: "example/one",
      issue: 7,
      taskId: "root",
      threadId: "thread-root",
      title: "Root",
      sessionRun: "running",
      reason: "working",
      needsYou: false,
      lastProgress: "building",
    };
    const claimDecode = Schema.decodeUnknownSync(FleetClaim);
    const reportDecode = Schema.decodeUnknownSync(FleetSummaryReportInput);
    expect(claimDecode(claim)).toEqual(claim);
    expect(reportDecode(report)).toEqual(report);
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});
