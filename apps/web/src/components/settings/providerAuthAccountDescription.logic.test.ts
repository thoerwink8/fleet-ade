import { describe, expect, it } from "vite-plus/test";
import { providerAuthAccountDescription } from "./providerAuthAccountDescription.logic";

const idle = {
  phase: "idle",
  message: null,
  interactionType: undefined,
  signedIn: false,
  isDiscovering: false,
  guidanceMessage: null,
  needsExternalSetup: false,
  usesCredentials: false,
  environmentLabel: "办公室电脑",
} as const;

describe("providerAuthAccountDescription", () => {
  it("says the login was cancelled instead of silently returning to the idle text", () => {
    expect(providerAuthAccountDescription({ ...idle, phase: "cancelled" })).toBe(
      "登录已取消。需要时可以重新登录。",
    );
  });

  it("keeps the signed-in text after a cancelled re-login", () => {
    expect(providerAuthAccountDescription({ ...idle, phase: "cancelled", signedIn: true })).toBe(
      "已登录",
    );
  });

  it("describes the running and idle states", () => {
    expect(
      providerAuthAccountDescription({ ...idle, phase: "waiting", interactionType: "terminal" }),
    ).toBe("在下方终端中完成登录。");
    expect(providerAuthAccountDescription({ ...idle, phase: "verifying" })).toBe(
      "正在检查你的账户…",
    );
    expect(providerAuthAccountDescription(idle)).toBe("在 办公室电脑 上登录。");
    expect(
      providerAuthAccountDescription({ ...idle, guidanceMessage: "在 X 上登录 Claude。" }),
    ).toBe("在 X 上登录 Claude。");
  });
});
