import { describe, expect, it } from "vite-plus/test";

import { getComposerPlaceholder } from "./composerPlaceholder";

describe("getComposerPlaceholder", () => {
  it("keeps the idle placeholder when the agent is not running", () => {
    for (const followUpBehavior of ["queue", "steer"] as const) {
      expect(
        getComposerPlaceholder({
          isRunning: false,
          followUpBehavior,
          platform: "Win32",
        }),
      ).toBe("想问什么都可以。@ 引用文件，$ 使用技能，/ 输入命令");
      expect(
        getComposerPlaceholder({
          isRunning: false,
          followUpBehavior,
          platform: "MacIntel",
        }),
      ).toBe("想问什么都可以。@ 引用文件，$ 使用技能，/ 输入命令");
    }
  });

  it("shows queue first and Ctrl+Enter steer second on Windows/Linux when default is queue", () => {
    expect(
      getComposerPlaceholder({
        isRunning: true,
        followUpBehavior: "queue",
        sendShortcut: "enter",
        platform: "Win32",
      }),
    ).toBe("回车排队，等这一轮做完再发；Ctrl+Enter 立即发送（会打断当前这一轮）");
  });

  it("swaps the two clauses when the user switches default follow-up behavior to steer", () => {
    expect(
      getComposerPlaceholder({
        isRunning: true,
        followUpBehavior: "steer",
        sendShortcut: "enter",
        platform: "Win32",
      }),
    ).toBe("回车立即发送（会打断当前这一轮）；Ctrl+Enter 排队，等这一轮做完再发");
  });

  it("shows ⌘ on Mac for both queue and steer defaults", () => {
    expect(
      getComposerPlaceholder({
        isRunning: true,
        followUpBehavior: "queue",
        sendShortcut: "enter",
        platform: "MacIntel",
      }),
    ).toBe("回车排队，等这一轮做完再发；⌘Enter 立即发送（会打断当前这一轮）");
    expect(
      getComposerPlaceholder({
        isRunning: true,
        followUpBehavior: "steer",
        sendShortcut: "enter",
        platform: "MacIntel",
      }),
    ).toBe("回车立即发送（会打断当前这一轮）；⌘Enter 排队，等这一轮做完再发");
  });

  it("adapts to mod-enter sendShortcut, canSteer=false, and custom/unbound alternate shortcuts", () => {
    expect(
      getComposerPlaceholder({
        isRunning: true,
        followUpBehavior: "queue",
        sendShortcut: "mod-enter",
        platform: "Win32",
      }),
    ).toBe("Ctrl+Enter 排队，等这一轮做完再发；Ctrl+Shift+Enter 立即发送（会打断当前这一轮）");
    expect(
      getComposerPlaceholder({
        isRunning: true,
        followUpBehavior: "steer",
        sendShortcut: "mod-enter",
        platform: "MacIntel",
      }),
    ).toBe("⌘Enter 立即发送（会打断当前这一轮）；⇧⌘Enter 排队，等这一轮做完再发");
    expect(
      getComposerPlaceholder({
        isRunning: true,
        followUpBehavior: "steer",
        canSteer: false,
        platform: "Win32",
      }),
    ).toBe("回车排队，等这一轮做完再发");
    expect(
      getComposerPlaceholder({
        isRunning: true,
        followUpBehavior: "queue",
        alternateShortcutLabel: "Alt+Enter",
        platform: "Win32",
      }),
    ).toBe("回车排队，等这一轮做完再发；Alt+Enter 立即发送（会打断当前这一轮）");
    expect(
      getComposerPlaceholder({
        isRunning: true,
        followUpBehavior: "queue",
        alternateShortcutLabel: null,
        platform: "Win32",
      }),
    ).toBe("回车排队，等这一轮做完再发");
  });

  it("names no keys on a device without a keyboard", () => {
    const base = {
      isRunning: true,
      sendShortcut: "enter",
      platform: "Win32",
      hasKeyboard: false,
    } as const;
    expect(getComposerPlaceholder({ ...base, followUpBehavior: "queue" })).toBe(
      "发送后排队，等这一轮做完再发",
    );
    expect(getComposerPlaceholder({ ...base, followUpBehavior: "steer" })).toBe(
      "发送后立即发送（会打断当前这一轮）",
    );
    expect(getComposerPlaceholder({ ...base, followUpBehavior: "steer", canSteer: false })).toBe(
      "发送后排队，等这一轮做完再发",
    );
    for (const text of [
      getComposerPlaceholder({ ...base, followUpBehavior: "queue" }),
      getComposerPlaceholder({ ...base, followUpBehavior: "steer" }),
    ]) {
      expect(text).not.toMatch(/Ctrl|⌘|Enter|回车/);
    }
  });
});
