import { describe, expect, it, vi } from "vite-plus/test";

import { buildThreadExportFilename, buildThreadMarkdown } from "./threadExport";
import { loadAllThreadHistory, type ExportThreadSnapshot } from "./exportThreadMarkdown";

describe("buildThreadExportFilename", () => {
  it("keeps Chinese characters and replaces invalid filename and control characters", () => {
    const date = new Date(2026, 10, 21, 10, 5);
    expect(buildThreadExportFilename('修复：A/B\\C:D*E?F"G<H>I|J\u0000\nK', date)).toBe(
      "修复：A-B-C-D-E-F-G-H-I-J-K-20261121.md",
    );
    expect(buildThreadExportFilename("会话导出为 Markdown", date)).toBe(
      "会话导出为 Markdown-20261121.md",
    );
  });

  it("falls back to 会话 when title is empty or only invalid characters", () => {
    const date = new Date(2026, 0, 5, 8, 0);
    expect(buildThreadExportFilename("", date)).toBe("会话-20260105.md");
    expect(buildThreadExportFilename('   /\\:*?"<>|\u0007  ', date)).toBe("会话-20260105.md");
  });
});

describe("buildThreadMarkdown", () => {
  it("preserves message order, role headings, and skips non-message items", () => {
    const exportedAt = new Date(2026, 10, 21, 9, 30);
    const markdown = buildThreadMarkdown({
      title: "排查登录问题",
      projectName: "fleet-ade",
      exportedAt,
      items: [
        { item: { type: "user_message", text: "第一步怎么查？" } },
        { item: { type: "reasoning" } },
        { item: { type: "command_execution" } },
        { item: { type: "assistant_message", text: "先看服务端日志。" } },
        { item: { type: "user_message", text: "日志里没有报错。" } },
        { item: { type: "assistant_message", text: "那再检查代理配置。" } },
      ],
      truncated: false,
    });

    expect(markdown).toBe(
      [
        "# 排查登录问题",
        "项目：fleet-ade · 导出时间：2026-11-21 09:30",
        "## 你\n\n第一步怎么查？",
        "## 助手\n\n先看服务端日志。",
        "## 你\n\n日志里没有报错。",
        "## 助手\n\n那再检查代理配置。",
        "> 工具调用和文件改动没有导出。",
      ].join("\n\n") + "\n",
    );
  });

  it("keeps fenced code blocks verbatim", () => {
    const codeBlock = [
      "```ts",
      "export function greet(name: string) {",
      "  return `hello, ${name}`;",
      "}",
      "```",
    ].join("\n");
    const markdown = buildThreadMarkdown({
      title: "代码片段",
      exportedAt: new Date(2026, 10, 21, 10, 0),
      items: [
        { item: { type: "user_message", text: "给个示例" } },
        { item: { type: "assistant_message", text: `如下：\n\n${codeBlock}` } },
      ],
    });

    expect(markdown).toContain(codeBlock);
  });

  it("adds a truncation notice at the top when truncated is true", () => {
    const markdown = buildThreadMarkdown({
      title: "长会话",
      exportedAt: new Date(2026, 10, 21, 10, 0),
      items: [{ item: { type: "user_message", text: "最近一条" } }],
      truncated: true,
    });

    expect(markdown).toContain("> 只导出了最近的部分，更早的轮次没有包含。");
    expect(markdown.indexOf("> 只导出了最近的部分，更早的轮次没有包含。")).toBeLessThan(
      markdown.indexOf("## 你"),
    );
  });
});

describe("loadAllThreadHistory", () => {
  it("pages until hasMoreHistory becomes false", async () => {
    const snapshots: ExportThreadSnapshot[] = [
      {
        visibleTurnItems: [{ item: { type: "user_message", text: "latest" } }],
        hasMoreHistory: true,
      },
      {
        visibleTurnItems: [
          { item: { type: "user_message", text: "older" } },
          { item: { type: "user_message", text: "latest" } },
        ],
        hasMoreHistory: false,
      },
    ];
    let index = 0;
    const loadEarlier = vi.fn(async () => ({ _tag: "loaded" as const }));

    const outcome = await loadAllThreadHistory({
      readThread: async () => snapshots[index++]!,
      loadEarlier,
    });

    expect(loadEarlier).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      _tag: "ready",
      items: snapshots[1]!.visibleTurnItems,
      truncated: false,
    });
  });

  it("returns truncated when paging hits the max page limit", async () => {
    const snapshot: ExportThreadSnapshot = {
      visibleTurnItems: [{ item: { type: "user_message", text: "recent" } }],
      hasMoreHistory: true,
    };
    const loadEarlier = vi.fn(async () => ({ _tag: "loaded" as const }));

    const outcome = await loadAllThreadHistory({
      readThread: async () => snapshot,
      loadEarlier,
      maxPages: 2,
    });

    expect(loadEarlier).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      _tag: "ready",
      items: snapshot.visibleTurnItems,
      truncated: true,
    });
  });

  it("returns failed when loadEarlier returns error", async () => {
    const outcome = await loadAllThreadHistory({
      readThread: async () => ({ visibleTurnItems: [], hasMoreHistory: true }),
      loadEarlier: async () => ({ _tag: "error", message: "boom" }),
    });

    expect(outcome).toEqual({ _tag: "failed" });
  });
});
