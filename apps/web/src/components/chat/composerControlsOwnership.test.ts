import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

describe("resolveComposerControlsOwnership", () => {
  it("never shows a permissions chip and lets the model picker answer composer.mode", () => {
    expect(resolveComposerControlsOwnership()).toMatchObject({
      accessDisplay: "hidden",
      showModeBlock: false,
      hiddenBlockIds: [],
      overflowShowsPermissions: false,
      pickerOwnsModeShortcut: true,
    });
  });
});
