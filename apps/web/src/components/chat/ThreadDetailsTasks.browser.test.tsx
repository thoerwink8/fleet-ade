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
import { useSyncExternalStore, type CSSProperties } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  version: 0,
  listeners: new Set<() => void>(),
  children: [] as unknown[],
  providers: [] as unknown[],
  canOperateWorkflow: true,
  commandCalls: [] as Array<{ command: unknown; environmentId: string; input: unknown }>,
  commandResult: "failure" as "failure" | "success" | "pending",
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.canOperateWorkflow) as never,
}));

vi.mock(import("../../state/entities"), () => ({
  useThreadProjection: ((ref: unknown) => {
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.version,
    );
    return ref === null ? null : { projection: state.projection };
  }) as never,
}));

vi.mock(import("../../state/environments"), () => ({
  useEnvironmentProviders: (() => new Map([["environment", state.providers]])) as never,
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
  useAtomCommand: ((command: unknown) => {
    return (target: { environmentId: string; input: unknown }) => {
      state.commandCalls.push({ command, ...target });
      if (state.commandResult === "pending") {
        return new Promise(() => {});
      }
      if (state.commandResult === "success") {
        return Promise.resolve(AsyncResult.success(undefined));
      }
      return Promise.resolve(AsyncResult.failure(Cause.fail(new Error("这条命令还在写入。"))));
    };
  }) as never,
}));

import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { render } from "../../../test/render";
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
    runId: "run-1",
    parentNodeId: NodeId.make("root"),
    origin: "provider_native",
    createdBy: "agent",
    nativeTaskRef: { strength: "strong", nativeId: `native-${patch.id}` },
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
  } as unknown as OrchestrationV2Subagent;
}

function setup(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  extra?: {
    readonly providerThreads?: ReadonlyArray<unknown>;
    readonly turnItems?: ReadonlyArray<unknown>;
    readonly children?: ReadonlyArray<unknown>;
    readonly providers?: ReadonlyArray<unknown>;
    readonly providerInstanceId?: string;
    readonly canOperateWorkflow?: boolean;
  },
) {
  state.commandCalls = [];
  state.commandResult = "failure";
  state.canOperateWorkflow = extra?.canOperateWorkflow ?? true;
  state.children = [...(extra?.children ?? [])];
  state.providers = [...(extra?.providers ?? [])];
  const projection = makeThreadProjectionFixture();
  state.projection = {
    ...projection,
    thread: {
      ...projection.thread,
      id: threadId,
      ...(extra?.providerInstanceId !== undefined
        ? { providerInstanceId: extra.providerInstanceId }
        : {}),
    },
    // A completed run: the roster only derives once the turn that spawned it has settled.
    runs: [{ id: "run-1", ordinal: 1, status: "completed" }],
    subagents: [...subagents],
    providerThreads: [...(extra?.providerThreads ?? [])],
    turnItems: [...(extra?.turnItems ?? [])],
  };
  state.version += 1;
  for (const listener of state.listeners) listener();
}

function Section(props?: { readonly anchorWidth?: number }) {
  return (
    <ToastProvider timeout={0}>
      <div
        data-background-task-card
        style={
          props?.anchorWidth === undefined
            ? undefined
            : ({
                "--anchor-width": `${props.anchorWidth}px`,
                width:
                  "min(calc(var(--thread-details-panel-width) + 16px), calc(var(--anchor-width) - 8px))",
              } as CSSProperties)
        }
      >
        <ThreadDetailsTasks environmentId={environmentId} threadId={threadId} />
      </div>
    </ToastProvider>
  );
}

it("keeps a single-line row at 32px and a progress row at 52px with 14px title and notes", async () => {
  setup([
    subagent({ id: NodeId.make("one"), title: "盘点子会话数据" }),
    subagent({ id: NodeId.make("two"), title: "复审 PR", progress: "在改 login.ts" }),
    subagent({
      id: NodeId.make("done"),
      title: "修好了登录",
      status: "completed",
      completedAt: at(NOW - MINUTE),
    }),
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

  // Running rows hide the redundant 运行中 status text; the static green dot stays.
  expect(rows[0]!.textContent).not.toContain("运行中");
  expect(rows[0]!.querySelector(".fa-dot--running")).not.toBeNull();

  const completedToggle = screen.getByRole("button", { name: /已完成 1/ }).element();
  expect(getComputedStyle(completedToggle).fontSize).toBe("14px");
});

it("shows no stop button on commands or Codex native subagents and uses session avatar for commands", async () => {
  setup(
    [
      subagent({
        id: NodeId.make("codex-native"),
        title: "Codex 子代理",
        driver: "codex" as never,
      }),
    ],
    {
      providerThreads: [
        {
          id: "provider-thread-1",
          driver: "claudeAgent",
          providerInstanceId: "claude",
          pendingBackgroundTasks: [
            {
              taskId: "task-1",
              kind: "command",
              description: "sleep 300",
              status: "running",
              startedAt: at(NOW - 8 * MINUTE),
              itemId: "item-1",
            },
          ],
        },
      ],
      providers: [
        {
          instanceId: "devReplay",
          driver: "acpRegistry",
          displayName: "Replay (dev)",
        },
      ],
      providerInstanceId: "devReplay",
    },
  );
  await using screen = await render(<Section />);

  const rows = [...screen.container.querySelectorAll("[data-background-task]")];
  expect(rows).toHaveLength(2);
  expect(screen.container.querySelectorAll(".fa-icon-btn")).toHaveLength(0);

  const commandRow = rows.find((entry) => entry.textContent?.includes("sleep 300"));
  expect(commandRow).toBeDefined();
  // The session agent's own initial, the same letter the sidebar draws for "Replay (dev)";
  // never the command title's initial ("S") or the driver's.
  expect(commandRow!.querySelector(".fa-agent")?.textContent).toBe("R");
});

it("falls back to the driver display name when the session instance is not listed", async () => {
  setup([], {
    providerThreads: [
      {
        id: "provider-thread-1",
        driver: "claudeAgent",
        providerInstanceId: "claude",
        pendingBackgroundTasks: [
          {
            taskId: "task-1",
            kind: "command",
            description: "sleep 300",
            status: "running",
            startedAt: at(NOW - 8 * MINUTE),
            itemId: "item-1",
          },
        ],
      },
    ],
  });
  await using screen = await render(<Section />);

  const commandRow = screen.container.querySelector("[data-background-task]");
  expect(commandRow?.querySelector(".fa-agent")?.textContent).toBe("C");
});

it("dispatches a stop for the row's subagent and rolls back with the reason on failure", async () => {
  setup([subagent({ id: NodeId.make("agent-1"), title: "复审 PR" })]);
  await using screen = await render(<Section />);

  await screen.getByRole("button", { name: "停止 复审 PR" }).click();

  expect(state.commandCalls).toHaveLength(1);
  expect(state.commandCalls[0]).toEqual({
    command: threadEnvironment.interruptTurn,
    environmentId: "environment",
    input: { threadId: "thread", subagentId: "agent-1" },
  });
  await expect.element(page.getByText("无法停止后台任务")).toBeVisible();
  await expect.element(page.getByText("这条命令还在写入。")).toBeVisible();
  const row = screen.container.querySelector("[data-background-task]");
  expect(row?.textContent).not.toContain("正在停止");
});

it("dispatches stopWorkflow for workflow subagents", async () => {
  setup([
    subagent({
      id: NodeId.make("wf-1"),
      title: "并行核验流",
      workflow: { name: "并行核验流", phases: [], agents: [] } as never,
    }),
  ]);
  await using screen = await render(<Section />);

  await screen.getByRole("button", { name: "停止 并行核验流" }).click();
  expect(state.commandCalls).toEqual([
    {
      command: orchestrationEnvironment.stopWorkflow,
      environmentId: "environment",
      input: { threadId: "thread", subagentId: "wf-1" },
    },
  ]);
});

it("keeps 正在停止 across multiple rows until each row leaves active status", async () => {
  setup([
    subagent({ id: NodeId.make("agent-1"), title: "复审 PR" }),
    subagent({ id: NodeId.make("agent-2"), title: "跑集成测试" }),
  ]);
  state.commandResult = "success";
  await using screen = await render(<Section />);

  await screen.getByRole("button", { name: "停止 复审 PR" }).click();
  await screen.getByRole("button", { name: "停止 跑集成测试" }).click();

  const rows = screen.container.querySelectorAll("[data-background-task]");
  expect(rows[0]?.textContent).toContain("正在停止");
  expect(rows[1]?.textContent).toContain("正在停止");
  expect(screen.container.querySelectorAll("button[aria-label='正在停止']")).toHaveLength(2);

  // Once the projection moves agent-1 out of active status, it leaves the active list cleanly.
  setup([
    subagent({
      id: NodeId.make("agent-1"),
      title: "复审 PR",
      status: "cancelled",
      completedAt: at(NOW),
    }),
    subagent({ id: NodeId.make("agent-2"), title: "跑集成测试" }),
  ]);

  await vi.waitFor(() => {
    const activeRows = screen.container.querySelectorAll("[data-background-task]");
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.textContent).toContain("跑集成测试");
    expect(activeRows[0]?.textContent).toContain("正在停止");
  });
});

it("clears 正在停止 once the row leaves active status so a reused id starts clean", async () => {
  setup([subagent({ id: NodeId.make("agent-1"), title: "复审 PR" })]);
  state.commandResult = "success";
  await using screen = await render(<Section />);

  await screen.getByRole("button", { name: "停止 复审 PR" }).click();
  expect(screen.container.querySelector("[data-background-task]")?.textContent).toContain(
    "正在停止",
  );

  // The stop lands: the row folds into 已完成 and its stop marker is dropped.
  setup([
    subagent({
      id: NodeId.make("agent-1"),
      title: "复审 PR",
      status: "cancelled",
      completedAt: at(NOW),
    }),
  ]);
  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll("[data-background-task]")).toHaveLength(0);
  });

  // The same id becomes active again: no inherited 正在停止, and its stop button works.
  setup([subagent({ id: NodeId.make("agent-1"), title: "复审 PR" })]);
  await vi.waitFor(() => {
    expect(screen.container.querySelector("[data-background-task]")?.textContent).not.toContain(
      "正在停止",
    );
  });
  const stop = screen.getByRole("button", { name: "停止 复审 PR" }).element();
  expect(stop).not.toBeDisabled();
});

it("keeps six Chinese characters plus the ellipsis of title at real widths", async () => {
  setup([
    subagent({
      id: NodeId.make("long-1"),
      title: "长标题至少要露六个汉字才行",
    }),
    subagent({
      id: NodeId.make("long-2"),
      title: "正在等待批准的长标题也不能被挤没",
      status: "waiting",
    }),
  ]);

  const assertRowsFit = (container: HTMLElement) => {
    const card = container.querySelector("[data-background-task-card]")!;
    const cardBounds = card.getBoundingClientRect();
    // Same formula as the panel Popover positioner: min(280 + 16, anchor width - 8).
    expect(cardBounds.width).toBe(208);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    const rows = [...container.querySelectorAll("[data-background-task]")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Six 14px Chinese characters (84px) plus the ellipsis.
      expect(getComputedStyle(row.querySelector(".t")!).minWidth).toBe("98px");
      const titleEl = row.querySelector(".t .x")!;
      expect(titleEl.getBoundingClientRect().width).toBeGreaterThanOrEqual(98);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      const elapsed = row.querySelector(".tm")!;
      const elapsedBounds = elapsed.getBoundingClientRect();
      expect(elapsedBounds.left).toBeGreaterThanOrEqual(cardBounds.left);
      expect(elapsedBounds.right).toBeLessThanOrEqual(cardBounds.right);
    }
  };

  try {
    for (const [width, height] of [
      [1024, 768],
      [390, 844],
    ] as const) {
      await page.viewport(width, height);
      // The real overview trigger is 216px wide, producing a 208px popup card.
      await using screen = await render(<Section anchorWidth={216} />);
      assertRowsFit(screen.container as HTMLElement);
      const rows = [...screen.container.querySelectorAll("[data-background-task]")];
      const heading = screen.container.querySelector("#thread-details-tasks-heading")!;
      expect(heading.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
      expect(rows[1]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    }
  } finally {
    await page.viewport(1440, 900);
  }
});

it("caps the active list height past six rows while keeping heading and first three rows in the fold", async () => {
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
  const rows = [...screen.container.querySelectorAll("[data-background-task]")];
  expect(rows).toHaveLength(7);

  const heading = screen.container.querySelector("#thread-details-tasks-heading")!;
  const listRect = list!.getBoundingClientRect();
  expect(heading.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  for (const row of rows.slice(0, 3)) {
    expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(listRect.bottom);
  }
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

it("keeps failed rows visible, matches 已完成 N to expanded rows, and marks only error words red", async () => {
  setup([
    subagent({ id: NodeId.make("agent-live"), title: "还在跑" }),
    ...Array.from({ length: 22 }, (_, index) =>
      subagent({
        id: NodeId.make(`agent-done-${index}`),
        title: `完成任务 ${index}`,
        status: "completed",
        completedAt: at(NOW - (index + 2) * MINUTE),
      }),
    ),
    subagent({
      id: NodeId.make("agent-failed"),
      title: "没修好的构建",
      status: "failed",
      result: "找不到模块",
      completedAt: at(NOW - MINUTE),
    }),
  ]);
  await using screen = await render(<Section />);

  // Active + failed are both visible before expanding completed work.
  const initialRows = [...screen.container.querySelectorAll("[data-background-task]")];
  expect(initialRows).toHaveLength(2);
  const failedRow = initialRows.find((row) => row.textContent?.includes("没修好的构建"));
  expect(failedRow?.textContent).toContain("出错了");
  expect(failedRow?.querySelector(".sub .bad")?.textContent).toBe("找不到模块");

  // Completed count matches the capped 20 expanded rows (not 22).
  const toggle = screen.getByRole("button", { name: "已完成 20" });
  await expect.element(toggle).toBeVisible();
  await toggle.click();
  expect(screen.container.querySelectorAll("[data-background-task]")).toHaveLength(22);
});

it("shows the 14/20 empty state when nothing runs and nothing finished", async () => {
  setup([]);
  await using screen = await render(<Section />);

  const empty = page.getByText("没有后台任务");
  await expect.element(empty).toBeVisible();
  const style = getComputedStyle(empty.element());
  expect(style.fontSize).toBe("14px");
  expect(style.lineHeight).toBe("20px");
  expect(screen.container.querySelector("[data-thread-details-tasks]")).not.toBeNull();
});
