import { describe, expect, it } from "vite-plus/test";

import {
  TERMINAL_UNAVAILABLE_MESSAGE,
  terminalSendFailureMessage,
} from "./providerAuthTerminalSend.logic";

const sent = { flowId: "flow-1", interactionId: "terminal" };
const terminal = { type: "terminal", id: "terminal", output: "", outputOffset: 0 } as const;

describe("terminalSendFailureMessage", () => {
  it("stays silent once the login command exited with failure", () => {
    expect(
      terminalSendFailureMessage({
        interrupted: false,
        sent,
        latest: { flowId: "flow-1", phase: "failed", interaction: null },
      }),
    ).toBeNull();
  });

  it("stays silent after success or cancel, or when a newer flow replaced it", () => {
    for (const latest of [
      { flowId: "flow-1", phase: "succeeded", interaction: null },
      { flowId: "flow-1", phase: "cancelled", interaction: null },
      { flowId: "flow-2", phase: "waiting", interaction: { ...terminal } },
    ] as const) {
      expect(terminalSendFailureMessage({ interrupted: false, sent, latest })).toBeNull();
    }
  });

  it("still reports an unavailable terminal while the login process is running", () => {
    expect(
      terminalSendFailureMessage({
        interrupted: false,
        sent,
        latest: { flowId: "flow-1", phase: "waiting", interaction: { ...terminal } },
      }),
    ).toBe(TERMINAL_UNAVAILABLE_MESSAGE);
  });

  it("ignores interrupted sends", () => {
    expect(
      terminalSendFailureMessage({
        interrupted: true,
        sent,
        latest: { flowId: "flow-1", phase: "waiting", interaction: { ...terminal } },
      }),
    ).toBeNull();
  });
});
