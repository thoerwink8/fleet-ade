import { describe, expect, it } from "vite-plus/test";

import {
  batchArchiveConfirmCopy,
  batchDeleteConfirmCopy,
  batchWorktreeDeleteConfirmCopy,
  sideChatDeleteConfirmCopy,
  threadArchiveConfirmCopy,
  threadDeleteConfirmCopy,
  threadUnpinConfirmCopy,
} from "./threadConfirmCopy";

describe("thread confirmation copy", () => {
  it.each([
    {
      name: "archive one",
      copy: threadArchiveConfirmCopy("修复登录"),
      title: "归档这个会话？",
      confirmLabel: "归档",
      destructive: false,
    },
    {
      name: "archive many",
      copy: batchArchiveConfirmCopy(3),
      title: "归档 3 个会话？",
      confirmLabel: "归档",
      destructive: false,
    },
    {
      name: "unpin",
      copy: threadUnpinConfirmCopy("修复登录"),
      title: "取消置顶这个会话？",
      confirmLabel: "取消置顶",
      destructive: false,
    },
    {
      name: "delete one",
      copy: threadDeleteConfirmCopy("修复登录", null),
      title: "删除这个会话？",
      confirmLabel: "删除",
      destructive: true,
    },
    {
      name: "delete one that owns a worktree",
      copy: threadDeleteConfirmCopy("修复登录", { displayPath: "~/work/login" }),
      title: "删除这个会话？",
      confirmLabel: "删除",
      destructive: true,
    },
    {
      name: "delete a side chat",
      copy: sideChatDeleteConfirmCopy("试一试"),
      title: "删除这个侧聊？",
      confirmLabel: "删除",
      destructive: true,
    },
    {
      name: "delete many",
      copy: batchDeleteConfirmCopy(2),
      title: "删除 2 个会话？",
      confirmLabel: "删除",
      destructive: true,
    },
    {
      name: "delete worktrees after a batch",
      copy: batchWorktreeDeleteConfirmCopy(["~/a", "~/b"]),
      title: "同时删除这 2 个工作树？",
      confirmLabel: "删除工作树",
      destructive: true,
    },
  ])("asks one concrete question with an action button for $name", (row) => {
    expect(row.copy.options.title).toBe(row.title);
    expect(row.copy.options.confirmLabel).toBe(row.confirmLabel);
    expect(row.copy.options.variant === "destructive").toBe(row.destructive);
    expect(row.copy.message.length).toBeGreaterThan(0);
  });

  it("adds the worktree checkbox only when the thread owns one, and names the path", () => {
    expect(threadDeleteConfirmCopy("修复登录", null).checkbox).toBeNull();
    const withWorktree = threadDeleteConfirmCopy("修复登录", { displayPath: "~/work/login" });
    expect(withWorktree.checkbox).toEqual({ label: "同时删除它的工作树" });
    expect(withWorktree.message).toContain("~/work/login");
  });

  it("names the alternative to deleting worktrees instead of a bare cancel", () => {
    expect(batchWorktreeDeleteConfirmCopy(["~/a"]).options.cancelLabel).toBe("保留工作树");
  });
});
