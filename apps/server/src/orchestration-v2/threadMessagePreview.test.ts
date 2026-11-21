import { describe, expect, it } from "vite-plus/test";
import {
  MAX_SHELL_MESSAGE_PREVIEW_CHARS,
  stripMarkdownForPreview,
  summarizeThreadMessagePreview,
} from "./threadMessagePreview.ts";

describe("stripMarkdownForPreview", () => {
  it("strips bold, italic, inline code, headings, links, quotes, lists, and code fences", () => {
    const raw = [
      "### 修复结论",
      "",
      "> 引用说明：已移除 **多余校验** 与 *旧逻辑*，并保留 `undici`。",
      "- [x] 更新 [接口文档](https://example.com/docs_(v2))",
      "1. 查看 ![截图](https://example.com/shot.png) 和 ~~废弃方案~~",
      "```ts",
      "const retryCount = 3;",
      "```",
    ].join("\n");

    expect(stripMarkdownForPreview(raw)).toBe(
      "修复结论 引用说明：已移除 多余校验 与 旧逻辑，并保留 undici。 更新 接口文档 查看 截图 和 废弃方案 const retryCount = 3;",
    );
  });

  it("preserves underscores inside snake_case identifiers while stripping standalone emphasis", () => {
    expect(stripMarkdownForPreview("更新 `latest_message_preview` 与 _重点_ __字段__")).toBe(
      "更新 latest_message_preview 与 重点 字段",
    );
  });

  it("unescapes Markdown backslash escapes", () => {
    expect(stripMarkdownForPreview(String.raw`保留 \*星号\* 与 \[方括号\]`)).toBe(
      "保留 *星号* 与 [方括号]",
    );
  });
});

describe("summarizeThreadMessagePreview", () => {
  it("returns null when only Markdown punctuation or whitespace remains", () => {
    expect(
      summarizeThreadMessagePreview("assistant", "   \n---\n***\n![](https://x.test/a.png)"),
    ).toBeNull();
  });

  it("truncates to 120 chars without splitting surrogate pairs", () => {
    const prefix = "a".repeat(MAX_SHELL_MESSAGE_PREVIEW_CHARS - 1);
    const result = summarizeThreadMessagePreview("user", `**${prefix}😀tail**`);
    expect(result).toEqual({
      role: "user",
      text: `${prefix}…`,
    });
  });
});
