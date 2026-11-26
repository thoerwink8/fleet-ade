import { describe, expect, it, vi } from "vite-plus/test";

import { resetSentComposerPrompt } from "./composerSend.logic";

describe("resetSentComposerPrompt", () => {
  it("preserves the visible prompt after navigating during a send", () => {
    const clearPrompt = vi.fn();
    const resetCursor = vi.fn();

    resetSentComposerPrompt({
      currentRouteThreadKey: "environment:test:thread:other",
      sentRouteThreadKey: "environment:test:thread:sent",
      clearPrompt,
      resetCursor,
    });

    expect(clearPrompt).not.toHaveBeenCalled();
    expect(resetCursor).not.toHaveBeenCalled();
  });

  it("resets the prompt when the sent thread is still visible", () => {
    const clearPrompt = vi.fn();
    const resetCursor = vi.fn();

    resetSentComposerPrompt({
      currentRouteThreadKey: "environment:test:thread:sent",
      sentRouteThreadKey: "environment:test:thread:sent",
      clearPrompt,
      resetCursor,
    });

    expect(clearPrompt).toHaveBeenCalledOnce();
    expect(resetCursor).toHaveBeenCalledOnce();
  });
});
