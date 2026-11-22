import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration instructions", () => {
  it("reach prompt-carried providers only until the first delivery", () => {
    const firstRun = t3OrchestrationPrompt({
      prompt: "Check the login screen.",
      hasT3Mcp: true,
      orchestrationDelivered: false,
    });
    assert.include(firstRun, T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        orchestrationDelivered: true,
      }),
      "Check the login screen.",
    );
    assert.equal(
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: false,
        orchestrationDelivered: false,
      }),
      "Check the login screen.",
    );
  });

  it("reach system-prompt providers only when the session has T3 tools", () => {
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    assert.isUndefined(t3OrchestrationSystemPrompt(false));
  });

  it("reach ACP agents again when tool access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: false } as const;
    const withTools = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasT3Mcp: true },
      previousState: state,
    });
    assert.include(withTools, T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.notInclude(withTools, "## T3 Code devices");
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
  });
});
