import { describe, expect, it } from "@effect/vitest";

import { isBlockingApproval } from "./fleetSummary.ts";

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
