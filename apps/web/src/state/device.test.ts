import { describe, expect, it } from "vite-plus/test";

import { isDeviceSupportOffered } from "./device";

describe("device support availability", () => {
  it("does not offer Device when support and agent access are disabled", () => {
    expect(
      isDeviceSupportOffered(true, {
        hostStatus: "disabled",
        agentAccessEnabled: false,
      }),
    ).toBe(false);
  });

  it("keeps Device available when either support is enabled or state is loading", () => {
    expect(isDeviceSupportOffered(true, { hostStatus: "idle", agentAccessEnabled: false })).toBe(
      true,
    );
    expect(isDeviceSupportOffered(true, { hostStatus: "disabled", agentAccessEnabled: true })).toBe(
      true,
    );
    expect(
      isDeviceSupportOffered(false, { hostStatus: "disabled", agentAccessEnabled: false }),
    ).toBe(true);
  });
});
