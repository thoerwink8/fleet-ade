import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  resolveWorkEntryToolPresentation,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
} from "./presentation.js";

function commandItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    type: "command_execution",
    input: 'rg "command not found"',
    ...fields,
  };
}

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "读取",
  };

  it.each([
    [{ exitCode: 2 }, true],
    [{ output: "sh: missing-command: command not found" }, true],
    [{ output: `${"x".repeat(32_768)} command not found` }, false],
  ] as const)(
    "preserves command failure state after removing displayed output: %j",
    (fields, failed) => {
      const structuredPayload = commandItem(fields);
      const entry: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        structuredPayload,
      };
      expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(failed);
      expect(JSON.stringify(toolItemForDisplay(structuredPayload))).not.toContain('"output":');
    },
  );

  it.each([
    "logs/app.log:12: Error: ENOENT: no such file or directory",
    "fixtures/ci.txt:3: Process exited with exit code 2",
  ])("trusts a zero exit code over failure text in the output and command: %s", (output) => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      tone: "tool",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      command: 'rg -n "ENOENT|exit code" logs fixtures',
      structuredPayload: commandItem({ output, exitCode: 0, outputIndicatesFailure: true }),
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("ignores failure phrases in reasoning text", () => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      toolLifecycleStatus: "completed",
      detail: "That exit code 2 is just from listing the deleted directory, which is expected.",
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      ...base,
      label: "已运行命令",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);

    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it("shows returned MCP errors as failures even in the live activity row", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "T3-code.t3_project_clone",
      toolLifecycleStatus: "inProgress",
      itemType: "dynamic_tool",
      toolData: { output: { isError: true } },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe("未能克隆仓库");
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(true);
    const childFailure = {
      ...entry,
      label: "T3-code.task_status",
      toolLifecycleStatus: "completed" as const,
      toolData: { output: { taskId: "child", status: "failed", summary: "command not found" } },
    };
    expect(workEntryDisplayIndicatesToolFailure(childFailure)).toBe(false);
  });
  it.each([
    "mcp__t3-code__html_preview",
    "mcp__t3_code__html_preview",
    "mcp__t3code__html_preview",
    "T3-code.html_preview",
    "t3-code · html_preview completed",
    "t3_code/html_preview",
    "html_preview",
  ])("recognizes HTML preview tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "正在预览 HTML 页面",
      icon: "t3-code",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "t3-code", tool: "html_render", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "正在渲染 HTML 页面", icon: "t3-code" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "T3-code.html_preview" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe(
      "正在预览 HTML 页面",
    );
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe(
      "已预览 HTML 页面",
    );
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("已预览 HTML 页面");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("未能预览 HTML 页面");
  });

  it.each([
    ["https://github.com/acme/web/pull/7", "已关联 PR #7"],
    ["https://gitlab.com/acme/web/-/merge_requests/7", "已关联 change request #7"],
  ])("names a linked change request with its host's term (%s)", (url, displayName) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "T3-code.link_pull_request",
        toolLifecycleStatus: "completed",
        toolData: { arguments: { url } },
      })?.displayName,
    ).toBe(displayName);
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__html_preview",
      "t3-code.unknown_tool",
      "t3-code.toString",
      "搜索文件",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "html_preview",
        toolData: { server: "another-server", tool: "html_preview" },
      }),
    ).toBeNull();
  });
});
