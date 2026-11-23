import { describe, expect, it } from "vite-plus/test";

import { ignoreRetiredDesktopUpdateIpc } from "./channels.ts";

describe("retired desktop update IPC", () => {
  it("decodes an old update channel message and drops its payload keys", () => {
    const decoded = ignoreRetiredDesktopUpdateIpc({
      channel: "desktop:update-set-channel",
      updateChannel: "nightly",
      updateChannelConfiguredByUser: true,
      minimumVersion: "9.9.9",
    });

    expect(decoded).toEqual({ channel: "desktop:update-set-channel" });
    expect(decoded).not.toHaveProperty("updateChannel");
    expect(decoded).not.toHaveProperty("updateChannelConfiguredByUser");
    expect(decoded).not.toHaveProperty("minimumVersion");
  });
});
