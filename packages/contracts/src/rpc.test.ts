import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import { FleetClaim } from "./fleetClaims.ts";
import { FleetSummaryReportInput, phaseFromSessionRun } from "./fleetSummary.ts";
import { ORCHESTRATION_V2_WS_METHODS, OrchestrationV2AppThreadJson } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);

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
    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.resume",
          commandId: "resume-1",
          threadId: "thread-1",
          requestId: "rollback-1",
        }),
      ),
    ).toBe(true);
    for (const command of [
      {
        type: "thread.stop-and-rollback",
        commandId: "stop-rewind-1",
        threadId: "thread-1",
        turnCount: 0,
      },
      {
        type: "thread.pending-rollback.cancel",
        commandId: "cancel-rewind-1",
        threadId: "thread-1",
      },
      { type: "thread.stop", commandId: "stop-1", threadId: "thread-1" },
    ]) {
      expect(Exit.isSuccess(decode(command))).toBe(true);
    }
  });

  it("decodes threads and capabilities written before stop-and-rewind", () => {
    const thread = decodeThread({
      createdBy: "user",
      creationSource: "web",
      id: "thread-1",
      projectId: "project-1",
      title: "Legacy",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
      forkedFrom: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      rollbackRequestId: "rollback-1",
      rollbackFailure: { requestId: "rollback-1", message: "The provider could not roll back." },
    });
    expect(thread.pendingRollback).toBeUndefined();
    expect(thread.rollbackCompletedRequestId).toBeUndefined();
    expect(thread.rollbackFailure?.reason).toBeUndefined();
    const capabilities = decodeCapabilities({
      repositoryIdentity: true,
      threadStop: true,
    });
    expect(capabilities.threadStopAndRollback).toBeUndefined();
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });

  it("maps idle and terminal session runs to done", () => {
    for (const run of [
      "idle",
      "completed",
      "interrupted",
      "failed",
      "cancelled",
      "rolled_back",
    ] as const) {
      expect(phaseFromSessionRun(run)).toBe("done");
    }
    expect(phaseFromSessionRun("waiting")).toBe("stuck");
    expect(phaseFromSessionRun("running")).toBe("working");
  });
});
