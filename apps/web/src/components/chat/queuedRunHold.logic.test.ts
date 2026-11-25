import { describe, expect, it } from "vite-plus/test";
import { QUEUED_RUN_HELD_LABEL, queuedRunHeldLabel } from "./queuedRunHold.logic";

describe("queuedRunHeldLabel", () => {
  it("says a held queued message will not be sent by itself", () => {
    expect(queuedRunHeldLabel({ queueHeld: true })).toBe(QUEUED_RUN_HELD_LABEL);
  });

  it("says nothing for a message that is not held, or one not saved yet", () => {
    expect(queuedRunHeldLabel({ queueHeld: false })).toBeNull();
    expect(queuedRunHeldLabel({})).toBeNull();
    expect(queuedRunHeldLabel(null)).toBeNull();
  });
});
