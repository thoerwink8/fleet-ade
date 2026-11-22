import { describe, expect, it } from "vite-plus/test";
import {
  formatSidebarRowCounts,
  formatSidebarRowDisplayTitle,
  isEmptySidebarThread,
  resolveDuplicateEmptyThreadTitleSuffixes,
  resolveSidebarRowPreviewText,
} from "./SidebarThreadRow.logic";

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

describe("duplicate empty sidebar thread titles", () => {
  const emptyThread = (
    overrides: Partial<{
      key: string;
      title: string;
      createdAt: string;
      latestRun: { runId: string } | null;
      runtime: { status: string } | null;
      latestUserMessageAt: string | null;
      visibleItemCount: number;
      turnCount: number | undefined;
      latestMessagePreview: { role: "user" | "assistant"; text: string } | null | undefined;
    }> = {},
  ) => ({
    key: overrides.key ?? "local:t1",
    title: overrides.title ?? "新建会话",
    createdAt: overrides.createdAt ?? "2026-11-23T06:32:00.000Z",
    latestRun: overrides.latestRun ?? null,
    runtime: overrides.runtime ?? null,
    latestUserMessageAt: overrides.latestUserMessageAt ?? null,
    visibleItemCount: overrides.visibleItemCount ?? 0,
    turnCount: overrides.turnCount,
    latestMessagePreview: overrides.latestMessagePreview,
  });

  const nowMs = Date.parse("2026-11-23T08:00:00.000Z");

  it("identifies empty threads that have never sent a message", () => {
    expect(isEmptySidebarThread(emptyThread())).toBe(true);
    expect(isEmptySidebarThread(emptyThread({ latestRun: { runId: "r1" } }))).toBe(false);
    expect(isEmptySidebarThread(emptyThread({ runtime: { status: "running" } }))).toBe(false);
    expect(
      isEmptySidebarThread(emptyThread({ latestUserMessageAt: "2026-11-23T06:33:00.000Z" })),
    ).toBe(false);
    expect(isEmptySidebarThread(emptyThread({ visibleItemCount: 1 }))).toBe(false);
    expect(isEmptySidebarThread(emptyThread({ turnCount: 1 }))).toBe(false);
    expect(
      isEmptySidebarThread(emptyThread({ latestMessagePreview: { role: "user", text: "hi" } })),
    ).toBe(false);
  });

  it("leaves unique empty threads without a suffix and appends day-aware creation time for duplicates", () => {
    const suffixes = resolveDuplicateEmptyThreadTitleSuffixes({
      threads: [
        emptyThread({
          key: "local:unique",
          title: "唯一空会话",
          createdAt: "2026-11-23T06:00:00.000Z",
        }),
        emptyThread({
          key: "local:dup-1",
          title: "新建会话",
          createdAt: "2026-11-23T06:32:00.000Z",
        }),
        emptyThread({
          key: "local:dup-2",
          title: " 新建会话 ",
          createdAt: "2026-11-22T06:32:00.000Z",
        }),
      ],
      timestampFormat: "24-hour",
      nowMs,
      timeZone: "Asia/Shanghai",
    });

    expect(suffixes.get("local:unique")).toBeUndefined();
    expect(suffixes.get("local:dup-1")).toBe("14:32");
    expect(suffixes.get("local:dup-2")).toBe("昨天 14:32");
    expect(formatSidebarRowDisplayTitle("新建会话", suffixes.get("local:dup-1") ?? null)).toBe(
      "新建会话 · 14:32",
    );
    expect(formatSidebarRowDisplayTitle("唯一空会话", suffixes.get("local:unique") ?? null)).toBe(
      "唯一空会话",
    );
  });

  it("falls back to seconds when duplicate empty threads were created in the same minute", () => {
    const suffixes = resolveDuplicateEmptyThreadTitleSuffixes({
      threads: [
        emptyThread({ key: "local:a", title: "新建会话", createdAt: "2026-11-23T06:32:05.000Z" }),
        emptyThread({ key: "local:b", title: "新建会话", createdAt: "2026-11-23T06:32:42.000Z" }),
      ],
      timestampFormat: "24-hour",
      nowMs,
      timeZone: "Asia/Shanghai",
    });

    expect(suffixes.get("local:a")).toBe("14:32:05");
    expect(suffixes.get("local:b")).toBe("14:32:42");
  });

  it("keeps non-empty duplicate titles clean while disambiguating an empty sibling with the same title", () => {
    const suffixes = resolveDuplicateEmptyThreadTitleSuffixes({
      threads: [
        emptyThread({
          key: "local:active-1",
          title: "重构侧栏",
          turnCount: 2,
          createdAt: "2026-11-23T05:00:00.000Z",
        }),
        emptyThread({
          key: "local:active-2",
          title: "重构侧栏",
          turnCount: 1,
          createdAt: "2026-11-23T05:10:00.000Z",
        }),
        emptyThread({
          key: "local:mixed-nonempty",
          title: "新建会话",
          turnCount: 1,
          createdAt: "2026-11-23T06:00:00.000Z",
        }),
        emptyThread({
          key: "local:mixed-empty",
          title: "新建会话",
          createdAt: "2026-11-23T06:32:00.000Z",
        }),
      ],
      timestampFormat: "24-hour",
      nowMs,
      timeZone: "Asia/Shanghai",
    });

    expect(suffixes.get("local:active-1")).toBeUndefined();
    expect(suffixes.get("local:active-2")).toBeUndefined();
    expect(suffixes.get("local:mixed-nonempty")).toBeUndefined();
    expect(suffixes.get("local:mixed-empty")).toBe("14:32");
  });

  it("ignores invalid createdAt timestamps", () => {
    const suffixes = resolveDuplicateEmptyThreadTitleSuffixes({
      threads: [
        emptyThread({ key: "local:bad", title: "新建会话", createdAt: "not-a-date" }),
        emptyThread({
          key: "local:good",
          title: "新建会话",
          createdAt: "2026-11-23T06:32:00.000Z",
        }),
      ],
      timestampFormat: "24-hour",
      nowMs,
      timeZone: "Asia/Shanghai",
    });

    expect(suffixes.get("local:bad")).toBeUndefined();
    expect(suffixes.get("local:good")).toBe("14:32");
  });
});
