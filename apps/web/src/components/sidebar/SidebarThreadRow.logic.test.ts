import { describe, expect, it } from "vite-plus/test";
import { formatSidebarRowCounts, resolveSidebarRowPreviewText } from "./SidebarThreadRow.logic";

describe("resolveSidebarRowPreviewText", () => {
  it("returns null when preview is absent or whitespace-only", () => {
    expect(resolveSidebarRowPreviewText({ title: "会话", latestMessagePreview: null })).toBeNull();
    expect(
      resolveSidebarRowPreviewText({ title: "会话", latestMessagePreview: undefined }),
    ).toBeNull();
    expect(
      resolveSidebarRowPreviewText({
        title: "会话",
        latestMessagePreview: { role: "assistant", text: "  \n\t  " },
      }),
    ).toBeNull();
  });

  it("omits preview when it duplicates the thread title", () => {
    expect(
      resolveSidebarRowPreviewText({
        title: "修复侧栏高度",
        latestMessagePreview: { role: "user", text: "  修复侧栏高度 \n" },
      }),
    ).toBeNull();
  });

  it("prefixes user messages and keeps assistant messages plain", () => {
    expect(
      resolveSidebarRowPreviewText({
        title: "侧栏优化",
        latestMessagePreview: { role: "user", text: "把轮次计数加到卡片上" },
      }),
    ).toBe("你：把轮次计数加到卡片上");
    expect(
      resolveSidebarRowPreviewText({
        title: "侧栏优化",
        latestMessagePreview: { role: "assistant", text: "已加上摘要预览\n和轮次计数" },
      }),
    ).toBe("已加上摘要预览 和轮次计数");
  });
});

describe("formatSidebarRowCounts", () => {
  it("omits zero counts and formats non-zero turn and task counts", () => {
    expect(formatSidebarRowCounts({ turnCount: 0, pendingTaskCount: 0 })).toBeNull();
    expect(formatSidebarRowCounts({ turnCount: undefined, pendingTaskCount: 0 })).toBeNull();
    expect(formatSidebarRowCounts({ turnCount: 4, pendingTaskCount: 0 })).toBe("4 轮");
    expect(formatSidebarRowCounts({ turnCount: 0, pendingTaskCount: 2 })).toBe("2 任务");
    expect(formatSidebarRowCounts({ turnCount: 7, pendingTaskCount: 1 })).toBe("7 轮 · 1 任务");
  });
});
