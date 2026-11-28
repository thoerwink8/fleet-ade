import { NodeId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  BACKGROUND_WORK_COMPLETED_CAP,
  BACKGROUND_WORK_SCROLL_AFTER,
  BACKGROUND_WORK_SILENCE_AFTER_MS,
  backgroundWorkRowsFromChildren,
  backgroundWorkRowsFromCommands,
  backgroundWorkRowsFromSubagents,
  backgroundWorkSecondLine,
  backgroundWorkSilenceMinutes,
  backgroundWorkStatusWord,
  presentBackgroundWorkSection,
  type BackgroundWorkRowInput,
} from "./threadDetailsTasks.logic";

const NOW = Date.parse("2026-11-28T08:00:00.000Z");
const MINUTE = 60_000;

function at(ms: number): DateTime.Utc {
  return DateTime.makeUnsafe(ms);
}

function row(
  patch: Partial<BackgroundWorkRowInput> & Pick<BackgroundWorkRowInput, "id">,
): BackgroundWorkRowInput {
  return {
    source: "subagent",
    title: patch.id,
    driver: null,
    status: "running",
    startedAt: null,
    completedAt: null,
    progress: null,
    lastOutputAtMs: null,
    errorReason: null,
    subagentId: null,
    stopThreadId: null,
    childThreadId: null,
    ...patch,
  };
}

describe("background work silence", () => {
  it("says nothing at and below five minutes, then counts whole minutes", () => {
    expect(backgroundWorkSilenceMinutes(null, NOW)).toBeNull();
    expect(backgroundWorkSilenceMinutes(NOW - BACKGROUND_WORK_SILENCE_AFTER_MS, NOW)).toBeNull();
    expect(backgroundWorkSilenceMinutes(NOW - BACKGROUND_WORK_SILENCE_AFTER_MS - 1, NOW)).toBe(5);
    expect(backgroundWorkSilenceMinutes(NOW - 12 * MINUTE - 30_000, NOW)).toBe(12);
  });

  it("adds the silence note only when a last-output time exists", () => {
    const base = row({ id: "a", progress: "在改 login.ts" });
    expect(backgroundWorkSecondLine(base, NOW)).toEqual([{ text: "在改 login.ts", bad: false }]);
    expect(backgroundWorkSecondLine({ ...base, lastOutputAtMs: NOW - 8 * MINUTE }, NOW)).toEqual([
      { text: "在改 login.ts", bad: false },
      { text: " · ", bad: false },
      { text: "已 8 分钟无输出", bad: false },
    ]);
    expect(
      backgroundWorkSecondLine({ ...base, progress: null, lastOutputAtMs: NOW - MINUTE }, NOW),
    ).toBeNull();
  });
});

describe("background work error words", () => {
  it("marks only the error reason inside the progress sentence", () => {
    expect(
      backgroundWorkSecondLine(
        row({ id: "a", progress: "构建失败：找不到模块", errorReason: "找不到模块" }),
        NOW,
      ),
    ).toEqual([
      { text: "构建失败：", bad: false },
      { text: "找不到模块", bad: true },
    ]);
  });

  it("leaves the line unmarked when the reason is absent or not in the sentence", () => {
    expect(
      backgroundWorkSecondLine(row({ id: "a", progress: "在跑测试", errorReason: null }), NOW),
    ).toEqual([{ text: "在跑测试", bad: false }]);
    expect(
      backgroundWorkSecondLine(
        row({ id: "a", progress: "在跑测试", errorReason: "别的原因" }),
        NOW,
      ),
    ).toEqual([{ text: "在跑测试", bad: false }]);
  });
});

describe("background work status words", () => {
  it.each([
    ["running", "运行中", false],
    ["pending", "运行中", false],
    ["waiting", "等待中", false],
    ["completed", "已完成", false],
    ["failed", "出错了", true],
    ["cancelled", "已停止", false],
    ["interrupted", "已停止", false],
    ["mystery", "未知", false],
  ] as const)("reads %s as %s", (status, label, failed) => {
    expect(backgroundWorkStatusWord(status)).toEqual({ label, failed });
  });
});

describe("background work rows", () => {
  const subagent = {
    id: NodeId.make("node-1"),
    threadId: ThreadId.make("parent"),
    title: "Subagent: 修登录",
    prompt: "修登录跳转",
    status: "running",
    progress: "在改 login.ts",
    result: null,
    startedAt: at(NOW - 10 * MINUTE),
    completedAt: null,
    updatedAt: at(NOW - MINUTE),
    childThreadId: ThreadId.make("child-1"),
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("provider"),
  } as OrchestrationV2Subagent;

  it("builds a subagent row without inventing a last-output time", () => {
    const [built] = backgroundWorkRowsFromSubagents([subagent]);
    expect(built).toMatchObject({
      id: "subagent:node-1",
      title: "修登录",
      driver: "claudeAgent",
      status: "running",
      progress: "在改 login.ts",
      lastOutputAtMs: null,
      errorReason: null,
      subagentId: "node-1",
      childThreadId: "child-1",
    });
  });

  it("keeps a failed subagent's result as the marked reason", () => {
    const [built] = backgroundWorkRowsFromSubagents([
      { ...subagent, status: "failed", result: "  找不到模块  " },
    ]);
    expect(built?.errorReason).toBe("找不到模块");
    expect(built?.status).toBe("failed");
  });

  it("reads a command's last output from its turn item", () => {
    const task = {
      taskId: "task-1",
      kind: "command",
      description: "pnpm check",
      status: "running",
      itemId: "item-1",
    } as OrchestrationV2PendingBackgroundTask;
    const turnItem = {
      id: "item-1",
      type: "command_execution",
      updatedAt: at(NOW - 9 * MINUTE),
      completedAt: null,
    } as OrchestrationV2TurnItem;
    const [built] = backgroundWorkRowsFromCommands([task], [turnItem], ThreadId.make("parent"));
    expect(built).toMatchObject({
      id: "command:task-1",
      source: "command",
      title: "pnpm check",
      driver: null,
      lastOutputAtMs: NOW - 9 * MINUTE,
      stopThreadId: "parent",
      subagentId: null,
    });
    expect(backgroundWorkSilenceMinutes(built?.lastOutputAtMs ?? null, NOW)).toBe(9);
  });

  it("skips a child session that already has a subagent row", () => {
    const child = {
      threadId: ThreadId.make("child-1"),
      title: "修登录",
      phase: "在做",
      activity: "在改 login.ts",
    };
    const other = { ...child, threadId: ThreadId.make("child-2"), title: "写测试" };
    const rows = backgroundWorkRowsFromChildren([child, other], new Set(["child-1"]));
    expect(rows.map((entry) => entry.id)).toEqual(["child:child-2"]);
    expect(rows[0]).toMatchObject({ status: "running", lastOutputAtMs: null });
  });

  it("does not relabel a child phase it does not know", () => {
    const [built] = backgroundWorkRowsFromChildren(
      [
        {
          threadId: ThreadId.make("child-3"),
          title: null,
          phase: "别的",
          activity: "",
        },
      ],
      new Set(),
    );
    expect(built).toMatchObject({ title: "后台任务", status: "unknown", progress: null });
  });
});

describe("background work section", () => {
  it("scrolls past six active rows and caps finished rows at the newest twenty", () => {
    expect(BACKGROUND_WORK_SCROLL_AFTER).toBe(6);
    const active = Array.from({ length: 7 }, (_, index) => row({ id: `a${index}` }));
    const finished = Array.from({ length: BACKGROUND_WORK_COMPLETED_CAP + 3 }, (_, index) =>
      row({
        id: `f${index}`,
        status: "completed",
        completedAt: new Date(NOW - index * MINUTE).toISOString(),
      }),
    );
    const section = presentBackgroundWorkSection([...finished].reverse().concat(active));
    expect(section.active).toHaveLength(7);
    expect(section.completed).toHaveLength(BACKGROUND_WORK_COMPLETED_CAP);
    expect(section.completed[0]?.id).toBe("f0");
    expect(section.completed.at(-1)?.id).toBe(`f${BACKGROUND_WORK_COMPLETED_CAP - 1}`);
    expect(section.droppedCompleted).toBe(3);
  });

  it("treats a failed row as finished, not active", () => {
    const section = presentBackgroundWorkSection([
      row({ id: "ok" }),
      row({ id: "bad", status: "failed" }),
    ]);
    expect(section.active.map((entry) => entry.id)).toEqual(["ok"]);
    expect(section.completed.map((entry) => entry.id)).toEqual(["bad"]);
  });
});
