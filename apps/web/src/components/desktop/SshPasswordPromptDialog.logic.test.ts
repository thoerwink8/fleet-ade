import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { sshPromptErrorMessage } from "./SshPasswordPromptDialog.logic";

describe("sshPromptErrorMessage", () => {
  it("replaces an interrupted prompt response with the shared sentence", () => {
    expect(sshPromptErrorMessage(Cause.interrupt(1))).toBe("连接已断开，内容已保留，恢复后再试。");
  });

  it("keeps the server's own rejection", () => {
    expect(sshPromptErrorMessage(Cause.fail(new Error("密码错误，请重试。")))).toBe(
      "密码错误，请重试。",
    );
  });

  it("still folds an expired prompt into the reconnect hint", () => {
    expect(sshPromptErrorMessage(Cause.fail(new Error("prompt expired")))).toBe(
      "此 SSH 验证提示已过期，请重新连接。",
    );
  });
});
