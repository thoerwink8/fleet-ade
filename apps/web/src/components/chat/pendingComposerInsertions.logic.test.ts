import { describe, expect, it } from "vite-plus/test";

import {
  classifyComposerInsertionBlock,
  PendingComposerInsertionQueue,
} from "./pendingComposerInsertions.logic";

describe("classifyComposerInsertionBlock", () => {
  const ready = {
    projectSelectionRequired: false,
    activePendingIsResponding: false,
    pendingUserInputCount: 0,
    hasActiveQuestion: false,
    choiceOnlyQuestion: false,
    canOperateThread: true,
    requireOperate: false,
  };

  it("returns null when the composer accepts insertions", () => {
    expect(classifyComposerInsertionBlock(ready)).toBeNull();
    expect(
      classifyComposerInsertionBlock({
        ...ready,
        pendingUserInputCount: 1,
        hasActiveQuestion: true,
      }),
    ).toBeNull();
  });

  it("classifies responding/settling question transitions as transient", () => {
    expect(classifyComposerInsertionBlock({ ...ready, activePendingIsResponding: true })).toEqual({
      kind: "transient",
    });
    expect(
      classifyComposerInsertionBlock({
        ...ready,
        pendingUserInputCount: 1,
        hasActiveQuestion: false,
      }),
    ).toEqual({ kind: "transient" });
  });

  it("classifies missing project, read-only connection, and choice-only questions as hard blocks", () => {
    expect(classifyComposerInsertionBlock({ ...ready, projectSelectionRequired: true })).toEqual({
      kind: "hard",
      reason: "请先在上方选择项目，再添加到输入框。",
    });

    expect(classifyComposerInsertionBlock({ ...ready, choiceOnlyQuestion: true })).toEqual({
      kind: "hard",
      reason: "当前问题只能选择选项，先回答或关闭问题后再添加。",
    });

    expect(
      classifyComposerInsertionBlock({ ...ready, canOperateThread: false, requireOperate: true }),
    ).toEqual({ kind: "hard", reason: "此连接无法修改会话。" });

    expect(
      classifyComposerInsertionBlock({ ...ready, canOperateThread: false, requireOperate: false }),
    ).toBeNull();
  });
});

describe("PendingComposerInsertionQueue", () => {
  it("drains queued items in FIFO order for the matching target once ready", () => {
    const queue = new PendingComposerInsertionQueue<string>();
    queue.enqueue("thread-a", "first");
    queue.enqueue("thread-a", "second");
    queue.enqueue("thread-b", "other-thread");

    expect(queue.hasForTarget("thread-a")).toBe(true);
    expect(queue.takeForTarget("thread-a")).toEqual(["first", "second"]);
    expect(queue.hasForTarget("thread-a")).toBe(false);
    expect(queue.takeForTarget("thread-a")).toEqual([]);
    expect(queue.hasForTarget("thread-b")).toBe(true);
  });

  it("drops stale insertions for other targets when switching threads", () => {
    const queue = new PendingComposerInsertionQueue<string>();
    queue.enqueue("thread-a", "stale");
    queue.enqueue("thread-b", "current");

    queue.clearExcept("thread-b");
    expect(queue.hasForTarget("thread-a")).toBe(false);
    expect(queue.takeForTarget("thread-b")).toEqual(["current"]);
  });
});
