import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  FleetSummaryReportInput,
  FleetSummaryRow,
  isBlockingApproval,
  isUserInputRequest,
} from "./fleetSummary.ts";

describe("isBlockingApproval", () => {
  it("recognizes only blocking approval requests", () => {
    for (const kind of [
      "command",
      "file-change",
      "file-read",
      "permission",
      "mcp-elicitation",
    ] as const) {
      expect(isBlockingApproval(kind)).toBe(true);
      expect(isBlockingApproval(kind, true)).toBe(true);
      expect(isBlockingApproval(kind, false)).toBe(false);
    }
    for (const kind of ["user_input", "auth_refresh", "dynamic_tool_call"] as const) {
      expect(isBlockingApproval(kind)).toBe(false);
      expect(isBlockingApproval(kind, true)).toBe(false);
    }
  });
});

describe("isUserInputRequest", () => {
  it("recognizes only blocking user input requests", () => {
    expect(isUserInputRequest("user_input")).toBe(true);
    expect(isUserInputRequest("user_input", true)).toBe(true);
    expect(isUserInputRequest("user_input", false)).toBe(false);
    for (const kind of [
      "command",
      "file-change",
      "file-read",
      "permission",
      "mcp-elicitation",
      "auth_refresh",
      "dynamic_tool_call",
    ] as const) {
      expect(isUserInputRequest(kind)).toBe(false);
      expect(isUserInputRequest(kind, true)).toBe(false);
    }
  });
});

describe("FleetSummaryRow branch and commit fields", () => {
  it("decodes optional branch and commit on summary rows and reports", () => {
    const decodeRow = Schema.decodeUnknownSync(FleetSummaryRow);
    const decodeReport = Schema.decodeUnknownSync(FleetSummaryReportInput);

    const row = decodeRow({
      environmentId: "env-box",
      threadId: "thread-1",
      title: "Fix summary",
      phase: "working",
      reason: "running",
      needsYou: false,
      lastProgress: "running tests",
      branch: " local/118-fleet-row ",
      commit: " abc1234def ",
      updatedAt: "2026-11-24T00:00:00.000Z",
      stale: false,
      revision: 1,
    });
    expect(row.branch).toBe("local/118-fleet-row");
    expect(row.commit).toBe("abc1234def");

    const report = decodeReport({
      type: "upsert-adhoc",
      threadId: "thread-1",
      title: "Fix summary",
      sessionRun: "running",
      reason: "running",
      needsYou: false,
      lastProgress: "running tests",
      branch: "local/118-fleet-row",
      commit: "abc1234def",
    });
    expect(report).toMatchObject({
      branch: "local/118-fleet-row",
      commit: "abc1234def",
    });
  });
});
