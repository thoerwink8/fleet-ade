import {
  EnvironmentId,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  downloaded: [] as Array<{ filename: string; contents: string }>,
  downloadShouldThrowOnce: false,
  toasts: [] as Array<unknown>,
  closedToasts: [] as Array<unknown>,
  fullVisibleTurnItems: [] as ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
}));

vi.mock("../proposedPlan", () => ({
  downloadPlanAsTextFile: (filename: string, contents: string) => {
    if (testState.downloadShouldThrowOnce) {
      testState.downloadShouldThrowOnce = false;
      throw new Error("download blocked");
    }
    testState.downloaded.push({ filename, contents });
  },
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: {
    add: (toast: unknown) => {
      testState.toasts.push(toast);
      return `toast-${testState.toasts.length}`;
    },
    close: (id: unknown) => {
      testState.closedToasts.push(id);
    },
  },
}));

vi.mock("../state/threads", () => {
  const fullThreadAtom = Atom.make(() => ({
    environmentId: EnvironmentId.make("env-1"),
    projection: {
      visibleTurnItems: testState.fullVisibleTurnItems,
    },
  }));
  // Mirrors threadDetail.ts toThreadStructureTurnItem: assistant_message and reasoning lose `text`.
  const quietThreadAtom = Atom.make(() => ({
    environmentId: EnvironmentId.make("env-1"),
    projection: {
      visibleTurnItems: testState.fullVisibleTurnItems.map((row) => {
        if (row.item.type !== "assistant_message" && row.item.type !== "reasoning") return row;
        const { text: _text, updatedAt: _updatedAt, ...rest } = row.item;
        return { ...row, item: rest };
      }),
    },
  }));
  const historyAtom = Atom.make({ loading: false, hasMoreHistory: false });
  const statusAtom = Atom.make("live");
  const errorAtom = Atom.make(null);

  return {
    environmentThreadDetails: {
      threadAtom: () => fullThreadAtom,
      quietThreadAtom: () => quietThreadAtom,
      historyAtom: () => historyAtom,
      statusAtom: () => statusAtom,
      errorAtom: () => errorAtom,
    },
    threadEnvironment: {
      loadEarlierHistory: {
        label: "loadEarlierHistory",
        run: vi.fn(),
      },
    },
  };
});

import {
  exportThreadMarkdown,
  loadAllThreadHistory,
  type ExportThreadSnapshot,
} from "./exportThreadMarkdown";
import { buildThreadExportFilename, buildThreadMarkdown } from "./threadExport";

const THREAD_ID = ThreadId.make("thread-1");
const NOW = DateTime.makeUnsafe("2026-11-21T09:30:00Z");

function makeBaseFields(index: number) {
  return {
    id: TurnItemId.make(`item-${index}`),
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: NonNegativeInt.make(index),
    status: "completed" as const,
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeProjectedRow(
  index: number,
  item: OrchestrationV2TurnItem,
): OrchestrationV2ProjectedTurnItem {
  return {
    position: NonNegativeInt.make(index),
    visibility: "local",
    sourceThreadId: THREAD_ID,
    sourceItemId: item.id,
    item,
  };
}

function makeUserRow(index: number, text: string): OrchestrationV2ProjectedTurnItem {
  return makeProjectedRow(index, {
    ...makeBaseFields(index),
    type: "user_message",
    messageId: MessageId.make(`msg-user-${index}`),
    createdBy: "user",
    creationSource: "web",
    workflowScript: false,
    freshContext: false,
    inputIntent: "turn_start",
    text,
    attachments: [],
  });
}

function makeAssistantRow(index: number, text: string): OrchestrationV2ProjectedTurnItem {
  return makeProjectedRow(index, {
    ...makeBaseFields(index),
    type: "assistant_message",
    messageId: MessageId.make(`msg-assistant-${index}`),
    text,
    streaming: false,
  });
}

function makeReasoningRow(index: number, text: string): OrchestrationV2ProjectedTurnItem {
  return makeProjectedRow(index, {
    ...makeBaseFields(index),
    type: "reasoning",
    text,
    streaming: false,
  });
}

beforeEach(() => {
  testState.downloaded = [];
  testState.downloadShouldThrowOnce = false;
  testState.toasts = [];
  testState.closedToasts = [];
  testState.fullVisibleTurnItems = [];
});

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
        makeUserRow(0, "第一步怎么查？"),
        makeReasoningRow(1, "内部思考不应导出"),
        makeAssistantRow(2, "先看服务端日志。"),
        makeUserRow(3, "日志里没有报错。"),
        makeAssistantRow(4, "那再检查代理配置。"),
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
      items: [makeUserRow(0, "给个示例"), makeAssistantRow(1, `如下：\n\n${codeBlock}`)],
    });

    expect(markdown).toContain(codeBlock);
  });

  it("adds a truncation notice at the top when truncated is true", () => {
    const markdown = buildThreadMarkdown({
      title: "长会话",
      exportedAt: new Date(2026, 10, 21, 10, 0),
      items: [makeUserRow(0, "最近一条")],
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
      { visibleTurnItems: [makeUserRow(1, "latest")], hasMoreHistory: true },
      {
        visibleTurnItems: [makeUserRow(0, "older"), makeUserRow(1, "latest")],
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
      visibleTurnItems: [makeUserRow(0, "recent")],
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

describe("exportThreadMarkdown", () => {
  it("reads full projection with assistant message text instead of quietThreadAtom", async () => {
    const codeSnippet = "```ts\nconst answer = 42;\n```";
    testState.fullVisibleTurnItems = [
      makeUserRow(0, "帮我写个示例"),
      makeReasoningRow(1, "内部推理"),
      makeAssistantRow(2, `这是助手回复：\n\n${codeSnippet}`),
    ];

    const registry = AtomRegistry.make();
    await exportThreadMarkdown({
      threadRef: { environmentId: EnvironmentId.make("env-1"), threadId: THREAD_ID },
      title: "完整导出测试",
      projectName: "fleet-ade",
      registry,
    });

    expect(testState.downloaded).toHaveLength(1);
    const exported = testState.downloaded[0]!.contents;
    expect(exported).toContain("## 你\n\n帮我写个示例");
    expect(exported).toContain(`## 助手\n\n这是助手回复：\n\n${codeSnippet}`);
    expect(exported).not.toContain("内部推理");
  });

  it("releases in-flight guard and closes loading toast if download throws", async () => {
    testState.fullVisibleTurnItems = [makeUserRow(0, "第一条"), makeAssistantRow(1, "第一条回复")];
    testState.downloadShouldThrowOnce = true;

    const registry = AtomRegistry.make();
    const input = {
      threadRef: { environmentId: EnvironmentId.make("env-1"), threadId: THREAD_ID },
      title: "重试导出测试",
      projectName: "fleet-ade",
      registry,
    };

    await expect(exportThreadMarkdown(input)).rejects.toThrow("download blocked");
    expect(testState.closedToasts).toHaveLength(1);

    await exportThreadMarkdown(input);
    expect(testState.downloaded).toHaveLength(1);
    expect(testState.downloaded[0]!.contents).toContain("## 助手\n\n第一条回复");
  });
});
