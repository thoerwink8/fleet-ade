import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import * as shelfHooks from "../state/olderSettledShelf";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig, isMacPlatform } from "@t3tools/shared/keybindings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  readEnvironmentServerConfigLoaded,
  readThreadShell,
  useProjects,
  useServerConfigs,
  useThreadShell,
  useQuietThreadShells,
} from "../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { settleSidebarThread } from "../sidebarSettle";
import type { Project } from "../types";
import { useChatShortcuts } from "./chat/useChatShortcuts";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";
import { ToastProvider } from "./ui/toast";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return { ...actual, useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf) };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: ({ actions }: { actions?: ReactNode }) => <>{actions}</>,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { count: 2, shift: false, picker: true },
    { count: 2, shift: true, picker: false },
    { count: 1, shift: false, picker: false },
  ] as const)("$count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "新建会话", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `会话 ${index}`,
  });
}

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("会话 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});

describe("sidebar thread rename", () => {
  // regression: #35151 an untouched rename wrote back the title it opened with over a newer one
  it.each(["{Enter}", "{Tab}"])(
    "ending an untouched rename with %s keeps a title that arrived while it was open",
    async (finish) => {
      const activeProject = project("active");
      const routeThreadRef: ScopedThreadRef = {
        environmentId: activeProject.environmentId,
        threadId: ThreadId.make("thread-0"),
      };
      const shellTitled = (title: string) => ({ ...threadShell(activeProject.id, 0), title });
      const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success" });
      vi.mocked(useOrchestrationCommand).mockReturnValue(updateMetadata);
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Fix the login redirect")]);
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: {
          environmentId: activeProject.environmentId,
          projectId: activeProject.id,
        },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      const tree = () => (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      );
      await using screen = await render(tree());
      await userEvent.dblClick(screen.getByText("Fix the login redirect").first());
      const input = screen.getByRole("textbox", { name: "会话标题" });
      await expect.element(input).toHaveValue("Fix the login redirect");

      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Generated title")]);
      await screen.rerender(tree());
      await userEvent.keyboard(finish);

      await expect.element(input).not.toBeInTheDocument();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});

describe("sidebar settled pagination", () => {
  it("keeps the viewport in place when showing more settled threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const focusController = createWorkspaceFocusController(document);
    stack.defer(() => focusController.dispose());
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const activeProject = project("active");
    const threads = Array.from({ length: 70 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`settled-${index}`),
        title: `Settled thread ${index}`,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider
        {...workspaceAreaProps("sidebar", 0, "Threads")}
        style={{ height: 400, minHeight: 400 }}
      >
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (shelf.getAttribute("aria-expanded") === "false") await act(() => shelf.click());
    const more = screen.getByRole("button", { name: "再显示 25 个", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    const viewport = moreButton.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    moreButton.scrollIntoView({ block: "nearest" });
    const before = viewport.scrollTop;
    expect(before).toBeGreaterThan(0);
    moreButton.focus({ preventScroll: true });
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "正在加载…", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "正在加载…", exact: true }))
      .toHaveFocus();
    expect(viewport.scrollTop).toBe(before);
    const loadedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(loadedRows);
  });
});

describe("sidebar attention offline rows", () => {
  it("dims and blocks click and Enter on non-blocking failed attention rows when offline", async () => {
    const activeProject = project("active");
    const failedThread = makeThreadFixture({
      environmentId: activeProject.environmentId,
      projectId: activeProject.id,
      id: ThreadId.make("failed-offline"),
      title: "Offline failed thread",
      latestRun: {
        runId: RunId.make("run-failed"),
        status: "failed",
        requestedAt: null,
        startedAt: null,
        completedAt: "2026-03-09T10:00:00.000Z",
        assistantMessageId: null,
      },
    });
    const otherThread = threadShell(activeProject.id, 1);
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([failedThread, otherThread]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: otherThread.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: otherThread.id },
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
      { router: "/local/thread-1" },
    );

    const failedRow = screen.container.querySelector<HTMLElement>(
      `[data-sidebar-row="${activeProject.environmentId}:${failedThread.id}"]`,
    )!;
    expect(failedRow.className).toContain("opacity-60");
    expect(failedRow.className).toContain("cursor-default");
    expect(failedRow.getAttribute("aria-disabled")).toBe("true");
    expect(failedRow.textContent).toContain("环境已断线，连上后处理");
    await userEvent.click(failedRow, { force: true });
    expect(screen.router?.state.location.pathname).toBe("/local/thread-1");
    failedRow.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.router?.state.location.pathname).toBe("/local/thread-1");
  });
});

describe("sidebar card summary preview and counts", () => {
  it("renders summary preview, turn/task counts, and scrolls smoothly with 120 threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const activeProject = project("active");
    const threads = Array.from({ length: 120 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`thread-dense-${index}`),
        title: `会话 ${index + 1}`,
        updatedAt: new Date(Date.UTC(2026, 2, 10, 0, 120 - index, 0)).toISOString(),
        latestMessagePreview:
          index === 1
            ? { role: "user", text: "会话 2" }
            : {
                role: index % 2 === 0 ? "assistant" : "user",
                text: `这是第 ${index + 1} 条会话的最新进展摘要`,
              },
        turnCount: index + 1,
        pendingBackgroundTasks:
          index === 0
            ? [
                {
                  taskId: "task-1",
                  kind: "subagent",
                  description: "子代理任务",
                },
              ]
            : [],
      }),
    );
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    await using screen = await render(
      <SidebarProvider style={{ height: 400, minHeight: 400 }}>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
      { router: "/local/thread-dense-0" },
    );

    const firstRow = screen.container.querySelector<HTMLElement>(
      `[data-sidebar-row="${activeProject.environmentId}:thread-dense-0"]`,
    )!;
    expect(firstRow.querySelector('[data-testid="sidebar-row-preview"]')?.textContent).toBe(
      "这是第 1 条会话的最新进展摘要",
    );
    expect(firstRow.querySelector('[data-testid="sidebar-row-counts"]')?.textContent).toBe(
      "1 轮 · 1 任务",
    );

    // Duplicate title preview is suppressed.
    const secondRow = screen.container.querySelector<HTMLElement>(
      `[data-sidebar-row="${activeProject.environmentId}:thread-dense-1"]`,
    )!;
    expect(secondRow.querySelector('[data-testid="sidebar-row-preview"]')).toBeNull();
    expect(secondRow.querySelector('[data-testid="sidebar-row-counts"]')?.textContent).toBe("2 轮");

    // User-authored preview carries the "你：" prefix.
    const thirdRow = screen.container.querySelector<HTMLElement>(
      `[data-sidebar-row="${activeProject.environmentId}:thread-dense-3"]`,
    )!;
    expect(thirdRow.querySelector('[data-testid="sidebar-row-preview"]')?.textContent).toBe(
      "你：这是第 4 条会话的最新进展摘要",
    );

    expect(screen.container.querySelectorAll('[data-testid="sidebar-row-card"]')).toHaveLength(120);
    const viewport = screen.container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    viewport.scrollTop = 3000;
    expect(viewport.scrollTop).toBeGreaterThan(0);
  });
});

function createThreadListStore(initial: readonly EnvironmentThreadShell[]) {
  let threads = [...initial];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => threads,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    find: (ref: ScopedThreadRef) =>
      threads.find(
        (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
      ) ?? null,
    update: (
      threadId: ThreadId,
      updater: (thread: EnvironmentThreadShell) => EnvironmentThreadShell,
    ) => {
      threads = threads.map((thread) => (thread.id === threadId ? updater(thread) : thread));
      emit();
    },
  };
}

function createSettleRouteApp(initialPath: string, extra?: ReactNode) {
  function Shell() {
    return (
      <ToastProvider>
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
          {extra}
          <Outlet />
        </SidebarProvider>
      </ToastProvider>
    );
  }
  const rootRoute = createRootRoute({ component: Shell });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$environmentId/$threadId",
  });
  return createRouter({
    routeTree: rootRoute.addChildren([threadRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function SettleShortcutHost(props: { readonly threadRef: ScopedThreadRef }) {
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+shift+s", command: "thread.settle" },
  ]);
  useChatShortcuts({
    enabled: true,
    keybindings,
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      rightPanelFocus: false,
      modelPickerOpen: false,
      isWeb: true,
      isDesktop: false,
    }),
    threadFindActive: false,
    composerRef: { current: null },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {
      "thread.settle": () => {
        settleSidebarThread(props.threadRef);
      },
    },
    fallback: () => undefined,
  });
  return null;
}

describe("sidebar thread settle", () => {
  const setupSettleFixture = (stack: DisposableStack) => {
    const activeProject = project("active");
    const threadX = makeThreadFixture({
      environmentId: activeProject.environmentId,
      projectId: activeProject.id,
      id: ThreadId.make("thread-x"),
      title: "会话 X",
    });
    const threadY = makeThreadFixture({
      environmentId: activeProject.environmentId,
      projectId: activeProject.id,
      id: ThreadId.make("thread-y"),
      title: "会话 Y",
    });
    const threadXRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threadX.id,
    };
    const store = createThreadListStore([threadX, threadY]);
    stack.defer(() =>
      ThreadUndo.invalidate("settle", `${activeProject.environmentId}:${threadX.id}`),
    );

    const settleCommand = vi.fn(async (input: { input: { threadId: ThreadId } }) => {
      store.update(input.input.threadId, (thread) => ({
        ...thread,
        settledOverride: "settled",
        settledAt: "2026-03-10T12:00:00.000Z",
      }));
      return AsyncResult.success(undefined);
    });
    const unsettleCommand = vi.fn(async (input: { input: { threadId: ThreadId } }) => {
      store.update(input.input.threadId, (thread) => ({
        ...thread,
        settledOverride: "active",
        settledAt: null,
      }));
      return AsyncResult.success(undefined);
    });

    const useStoreThreads = () =>
      useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const useStoreThread = (ref: ScopedThreadRef | null) => {
      useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      return ref ? store.find(ref) : null;
    };
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockImplementation(useStoreThreads);
    vi.mocked(useThreadShell).mockImplementation(useStoreThread);
    vi.mocked(readThreadShell).mockImplementation((ref) => store.find(ref));
    vi.mocked(readEnvironmentServerConfigLoaded).mockReturnValue(true);
    vi.mocked(readEnvironmentScope).mockReturnValue(true);
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: threadXRef,
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: threadXRef,
    });
    vi.mocked(useOrchestrationCommand).mockImplementation((command: unknown) => {
      if (command === threadEnvironment.settle) return settleCommand as never;
      if (command === threadEnvironment.unsettle) return unsettleCommand as never;
      return vi.fn().mockResolvedValue(AsyncResult.success(undefined)) as never;
    });

    return { activeProject, threadX, threadXRef, store, settleCommand, unsettleCommand };
  };

  it("keeps the active route on settle, moves the row into 最近, and restores it via the undo toast", async () => {
    using stack = new DisposableStack();
    const { activeProject, threadX, settleCommand, unsettleCommand } = setupSettleFixture(stack);
    const rowKey = `${activeProject.environmentId}:${threadX.id}`;
    const router = createSettleRouteApp("/local/thread-x");
    await router.load();

    // Reads thread route params from a real $environmentId/$threadId route, which the default router lacks.
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    const rowBefore = screen.container.querySelector<HTMLElement>(
      `[data-sidebar-row="${rowKey}"]`,
    )!;
    expect(rowBefore.getAttribute("data-sidebar-parent")).toBeNull();

    const settleButton = rowBefore.querySelector<HTMLButtonElement>(
      'button[aria-label="收尾会话"]',
    )!;
    await userEvent.click(settleButton);

    await vi.waitFor(() => {
      expect(settleCommand).toHaveBeenCalledOnce();
    });
    expect(router.state.location.pathname).toBe("/local/thread-x");

    const settledShelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    expect(settledShelf).not.toBeNull();
    if (settledShelf.getAttribute("aria-expanded") === "false") {
      await userEvent.click(settledShelf);
    }

    await vi.waitFor(() => {
      const settledRow = screen.container.querySelector<HTMLElement>(
        `[data-sidebar-row="${rowKey}"]`,
      );
      expect(settledRow?.getAttribute("data-sidebar-parent")).toBe("shelf:settled");
    });
    expect(router.state.location.pathname).toBe("/local/thread-x");

    await expect.element(page.getByText("已收尾")).toBeVisible();
    const undoButton = page.getByRole("button", { name: "撤销" });
    await expect.element(undoButton).toBeVisible();
    await userEvent.click(undoButton);

    await vi.waitFor(() => {
      expect(unsettleCommand).toHaveBeenCalledOnce();
      const restoredRow = screen.container.querySelector<HTMLElement>(
        `[data-sidebar-row="${rowKey}"]`,
      );
      expect(restoredRow?.getAttribute("data-sidebar-parent")).toBeNull();
    });
    expect(router.state.location.pathname).toBe("/local/thread-x");
  });

  it("keeps the active route and moves the row into 最近 when settling via keyboard shortcut", async () => {
    using stack = new DisposableStack();
    const { activeProject, threadX, threadXRef, settleCommand } = setupSettleFixture(stack);
    const rowKey = `${activeProject.environmentId}:${threadX.id}`;
    const router = createSettleRouteApp(
      "/local/thread-x",
      <SettleShortcutHost threadRef={threadXRef} />,
    );
    await router.load();

    // Reads thread route params from a real $environmentId/$threadId route, which the default router lacks.
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}{Shift>}s{/Shift}{/${modifier}}`);

    await vi.waitFor(() => {
      expect(settleCommand).toHaveBeenCalledOnce();
    });
    expect(router.state.location.pathname).toBe("/local/thread-x");

    const settledShelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (settledShelf.getAttribute("aria-expanded") === "false") {
      await userEvent.click(settledShelf);
    }

    await vi.waitFor(() => {
      const settledRow = screen.container.querySelector<HTMLElement>(
        `[data-sidebar-row="${rowKey}"]`,
      );
      expect(settledRow?.getAttribute("data-sidebar-parent")).toBe("shelf:settled");
    });
    expect(router.state.location.pathname).toBe("/local/thread-x");
    await expect.element(page.getByText("已收尾")).toBeVisible();
  });
});
