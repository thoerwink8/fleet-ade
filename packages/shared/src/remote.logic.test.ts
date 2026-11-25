import { describe, expect, it } from "vite-plus/test";

import {
  pairingRecoveryNotice,
  pairingRejectionHint,
  pairingRejectionMessage,
  pairingRequestFailureMessage,
} from "./remote.ts";

describe("pairing rejection copy", () => {
  it("names each failure reason and where to get a new code", () => {
    expect(pairingRejectionMessage("consumed", "this")).toBe(
      "这个配对码已经用过了。在这台电脑的 设置 → 连接 里点「创建链接」，或在这台电脑上运行 t3 pair。",
    );
    expect(pairingRejectionMessage("expired", "this")).toBe(
      "这个配对码已过期。在这台电脑的 设置 → 连接 里点「创建链接」，或在这台电脑上运行 t3 pair。",
    );
    expect(pairingRejectionMessage("invalid", "this")).toBe(
      "配对码无效。在这台电脑的 设置 → 连接 里点「创建链接」，或在这台电脑上运行 t3 pair。",
    );
  });

  it("treats a missing reason field from an older server as invalid", () => {
    expect(pairingRejectionMessage(undefined, "this")).toBe(
      pairingRejectionMessage("invalid", "this"),
    );
    expect(pairingRejectionMessage(undefined, "that")).toContain("在那台电脑");
  });

  it("points request failures at connectivity instead of the code", () => {
    expect(pairingRequestFailureMessage("this")).toBe(
      "连不上这台电脑。检查网络，或确认这台电脑上的服务还在运行，再重试。",
    );
    expect(pairingRequestFailureMessage("that")).toContain("连不上那台电脑");
  });

  it("keeps the recovery notice out of the way", () => {
    expect(pairingRecoveryNotice).toBe("这台浏览器已经连着，配对链接用过了也没关系。");
    expect(pairingRejectionHint("that")).toContain("t3 pair");
  });
});
