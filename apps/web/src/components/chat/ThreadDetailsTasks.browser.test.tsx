import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  children: [] as unknown[],
  interruptCalls: [] as Array<{ environmentId: string; input: unknown }>,
  interruptResult: "failure" as "failure" | "pending",
}));

vi.mock(import("../../state/entities"), () => ({
  useThreadProjection: ((ref: unknown) =>
    ref === null ? null : { projection: state.projection }) as never,
}));

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: { children: state.children, nextCursor: null },
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
  })) as never,
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => {
    return (target: { environmentId: string; input: unknown }) => {
      state.interruptCalls.push(target);
      if (state.interruptResult === "pending") {
        return new Promise(() => {});
      }
      return Promise.resolve(AsyncResult.failure(Cause.fail(new Error("这条命令还在写入。"))));
    };
  }) as never,
}));

import { fakeTimers, render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ToastProvider } from "../ui/toast";
import { ThreadDetailsTasks } from "./ThreadDetailsTasks";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const NOW = Date.parse("2026-11-28T08:00:00.000Z");
const MINUTE = 60_000;

function at(ms: number): DateTime.Utc {
  return DateTime.makeUnsafe(ms);
}

function subagent(
  patch: Partial<OrchestrationV2Subagent> & Pick<OrchestrationV2Subagent, "id" | "title">,
): OrchestrationV2Subagent {
  return {
    threadId,
    runId: null,
    parentNodeId: NodeId.make("root"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("provider"),
    providerThreadId: null,
    childThreadId: null,
    prompt: patch.title ?? "",
    model: null,
    result: null,
    status: "running",
    progress: undefined,
    startedAt: at(NOW - 10 * MINUTE),
    completedAt: null,
    updatedAt: at(NOW - MINUTE),
    ...patch,
  } as OrchestrationV2Subagent;
}

function setup(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  extra?: {
    readonly providerThreads?: ReadonlyArray<unknown>;
    readonly turnItems?: ReadonlyArray<unknown>;
    readonly children?: ReadonlyArray<unknown>;
  },
) {
  state.interruptCalls = [];
  state.interruptResult = "failure";
  state.children = [...(extra?.children ?? [])];
  const projection = makeThreadProjectionFixture();
  state.projection = {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    // A completed run: the roster only derives once the turn that spawned it has settled.
    runs: [{ id: "run-1", ordinal: 1, status: "completed" }],
    subagents: [...subagents],
    providerThreads: [...(extra?.providerThreads ?? [])],
    turnItems: [...(extra?.turnItems ?? [])],
  };
}

function Section() {
  return (
    <ToastProvider timeout={0}>
      <ThreadDetailsTasks environmentId={environmentId} threadId={threadId} />
    </ToastProvider>
  );
}

it("keeps a single-line row at 32px and a progress row at 52px with a 14px title", async () => {
  setup([
    subagent({ id: NodeId.make("one"), title: "盘点子会话数据" }),
    subagent({ id: NodeId.make("two"), title: "复审 PR", progress: "在改 login.ts" }),
  ]);
  await using screen = await render(<Section />);

  const rows = screen.container.querySelectorAll("[data-background-task]");
  expect(rows).toHaveLength(2);
  expect(rows[0]!.getBoundingClientRect().height).toBe(32);
  expect(rows[1]!.getBoundingClientRect().height).toBe(52);

  const title = rows[0]!.querySelector(".t .x");
  expect(title).not.toBeNull();
  expect(getComputedStyle(title!).fontSize).toBe("14px");
  expect(getComputedStyle(title!).whiteSpace).toBe("nowrap");
});

it("shows the silence note only for a command quiet longer than five minutes", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  setup([], {
    providerThreads: [
      {
        id: "provider-thread-1",
        providerInstanceId: "codex",
        pendingBackgroundTasks: [
          {
            taskId: "task-1",
            kind: "command",
            description: "pnpm check",
            status: "running",
            itemId: "item-1",
          },
          {
            taskId: "task-2",
            kind: "command",
            description: "vite dev",
            status: "running",
            itemId: "item-2",
          },
        ],
      },
    ],
    turnItems: [
      {
        id: "item-1",
        type: "command_execution",
        updatedAt: at(NOW - 8 * MINUTE - 1),
        completedAt: null,
      },
      {
        id: "item-2",
        type: "command_execution",
        updatedAt: at(NOW - 2 * MINUTE - 1),
        completedAt: null,
      },
    ],
  });
  await using screen = await render(<Section />);

  const rows = screen.container.querySelectorAll("[data-background-task]");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("已 8 分钟无输出");
  const quietRow = [...screen.container.querySelectorAll("[data-background-task]")].find((row) =>
    row.textContent?.includes("vite dev"),
  );
  expect(quietRow?.textContent).not.toContain("无输出");
});

it("dispatches a stop for the row's subagent and rolls back with the reason on failure", async () => {
  setup([subagent({ id: NodeId.make("agent-1"), title: "复审 PR" })]);
  await using screen = await render(<Section />);

  await screen.getByRole("button", { name: "停止 复审 PR" }).click();

  expect(state.interruptCalls).toHaveLength(1);
  expect(state.interruptCalls[0]).toEqual({
    environmentId: "environment",
    input: { threadId: "thread", subagentId: "agent-1" },
  });
  await expect.element(page.getByText("无法停止后台任务")).toBeVisible();
  await expect.element(page.getByText("这条命令还在写入。")).toBeVisible();
  // The failure rolls the row back to its roster status word.
  const row = screen.container.querySelector("[data-background-task]");
  expect(row?.textContent).toContain("运行中");
  expect(row?.textContent).not.toContain("正在停止");
});

it("reads 正在停止 while the stop is in flight", async () => {
  setup([subagent({ id: NodeId.make("agent-1"), title: "复审 PR" })]);
  state.interruptResult = "pending";
  await using screen = await render(<Section />);

  await screen.getByRole("button", { name: "停止 复审 PR" }).click();

  const row = screen.container.querySelector("[data-background-task]");
  expect(row?.textContent).toContain("正在停止");
  expect(
    (screen.getByRole("button", { name: "正在停止" }).element() as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(state.interruptCalls).toHaveLength(1);
});

it("caps the active list's height once more than six rows are running", async () => {
  setup(
    Array.from({ length: 7 }, (_, index) =>
      subagent({ id: NodeId.make(`agent-${index}`), title: `任务 ${index}` }),
    ),
  );
  await using screen = await render(<Section />);

  const list = screen.container.querySelector("[data-background-task-list]");
  expect(list).not.toBeNull();
  expect(list!.classList.contains("is-scrollable")).toBe(true);
  expect(getComputedStyle(list!).maxHeight).toBe("192px");
  expect(screen.container.querySelectorAll("[data-background-task]")).toHaveLength(7);
});

it("fits all rows inside the section when six or fewer are running", async () => {
  setup(
    Array.from({ length: 6 }, (_, index) =>
      subagent({ id: NodeId.make(`agent-${index}`), title: `任务 ${index}` }),
    ),
  );
  await using screen = await render(<Section />);

  const list = screen.container.querySelector("[data-background-task-list]");
  expect(list!.classList.contains("is-scrollable")).toBe(false);
});

it("folds finished work into 已完成 N and expands it on click", async () => {
  setup([
    subagent({ id: NodeId.make("agent-live"), title: "还在跑" }),
    subagent({
      id: NodeId.make("agent-done"),
      title: "修好了登录",
      status: "completed",
      completedAt: at(NOW - 2 * MINUTE),
    }),
    subagent({
      id: NodeId.make("agent-failed"),
      title: "没修好的构建",
      status: "failed",
      result: "找不到模块",
      completedAt: at(NOW - MINUTE),
    }),
  ]);
  await using screen = await render(<Section />);

  const toggle = screen.getByRole("button", { name: /已完成 2/ });
  await expect.element(toggle).toBeVisible();
  expect(screen.container.querySelectorAll("[data-background-task]")).toHaveLength(1);

  await toggle.click();
  expect(screen.container.querySelectorAll("[data-background-task]")).toHaveLength(3);
  // The failed row's reason is the only red-marked text on its second line.
  const failedRow = [...screen.container.querySelectorAll("[data-background-task]")].find((row) =>
    row.textContent?.includes("没修好的构建"),
  );
  expect(failedRow?.textContent).toContain("出错了");
  const badSegment = failedRow?.querySelector(".sub .bad");
  expect(badSegment?.textContent).toBe("找不到模块");
});

it("shows the one-line empty state when nothing runs and nothing finished", async () => {
  setup([]);
  await using screen = await render(<Section />);

  await expect.element(page.getByText("没有后台任务")).toBeVisible();
  expect(screen.container.querySelector("[data-thread-details-tasks]")).not.toBeNull();
});
