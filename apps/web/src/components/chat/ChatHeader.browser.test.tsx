import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const persisted = vi.hoisted(() => ({ title: "" }));
const openMenu = vi.hoisted(() => vi.fn());
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu, closeMenu: () => {} }),
}));

import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { render, stubGlobal } from "../../../test/render";
import { PopoverCreateHandle } from "../ui/popover";
import { SidebarProvider, SidebarTrigger } from "../ui/sidebar";
import { ChatHeader } from "./ChatHeader";
import { ThreadHeaderContext } from "./ThreadHeaderMeta";

function header(title: string) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "新建会话";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "新建会话 的会话操作" }).dblClick();
    const input = screen.getByRole("textbox", { name: "会话标题" });
    await expect.element(input).toHaveValue("新建会话");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Fix login redirect 的会话操作" }).dblClick();
    await screen.getByRole("textbox", { name: "会话标题" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("textbox", { name: "会话标题" })).not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("opens the thread menu on a desktop title click without waiting", async () => {
  openMenu.mockClear();
  using _bridge = stubGlobal("desktopBridge", {});
  await using screen = await render(header("新建会话"));
  await screen.getByRole("button", { name: "新建会话 的会话操作" }).click();
  expect(openMenu).toHaveBeenCalledOnce();
});

it("shows percent and cost on desktop, omits cost when absent, and hides cost suffix on narrow viewports", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };

  const contextButton = (cost: string | null) => (
    <ThreadHeaderContext
      percent="19.3%"
      cost={cost}
      open={false}
      presentation="inline"
      popoverHandle={PopoverCreateHandle()}
      shortcutLabel={null}
      onToggle={() => {}}
    />
  );

  await using screen = await render(contextButton("$0.38"));
  const button = screen.getByRole("button", {
    name: "上下文已用 19.3%，本会话花费 $0.38，打开会话详情",
  });
  await expect.element(button).toBeVisible();
  await expect.element(screen.getByText("19.3%")).toBeVisible();
  await expect.element(screen.getByText("· $0.38")).toBeVisible();

  await page.viewport(390, 844);
  await expect.element(screen.getByText("19.3%")).toBeVisible();
  await expect.element(screen.getByText("· $0.38")).not.toBeVisible();

  await page.viewport(1280, 800);
  await screen.rerender(contextButton(null));
  await expect
    .element(screen.getByRole("button", { name: "上下文已用 19.3%，打开会话详情" }))
    .toBeVisible();
  expect(document.querySelector("[data-thread-header-cost]")).toBeNull();
});

async function emulatePointer(options: {
  width: number;
  height: number;
  pointer: "coarse" | "fine";
}): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  const session = cdp();
  const isTouch = options.pointer === "coarse";
  const cleanup = async () => {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await session.send("Emulation.clearDeviceMetricsOverride");
    await page.viewport(previous.width, previous.height);
  };
  try {
    await page.viewport(options.width, options.height);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: isTouch ? 2 : 1,
      mobile: isTouch,
    });
    await session.send("Emulation.setTouchEmulationEnabled", {
      enabled: isTouch,
      ...(isTouch ? { maxTouchPoints: 5 } : {}),
    });
    await session.send("Emulation.setEmulatedMedia", {
      features: isTouch
        ? [
            { name: "pointer", value: "coarse" },
            { name: "hover", value: "none" },
          ]
        : [
            { name: "pointer", value: "fine" },
            { name: "hover", value: "hover" },
          ],
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { [Symbol.asyncDispose]: cleanup };
}

function headerWithSidebarTrigger() {
  const environmentId = EnvironmentId.make("environment");
  return (
    <SidebarProvider defaultOpen={false}>
      <div className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center">
        <SidebarTrigger
          touchTarget="compact"
          className="pointer-events-auto"
          aria-label="切换主侧边栏"
        />
      </div>
      <header
        data-chat-header
        className={cn(
          "relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] w-full shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <ChatHeader
          activeThreadEnvironmentId={environmentId}
          activeThreadId={ThreadId.make("thread")}
          activeThreadTitle="会话标题"
          isServerThread
          activeProject={{
            id: ProjectId.make("project-1"),
            environmentId,
            title: "fleet-ade",
            workspaceRoot: "/work/fleet-ade",
            repositoryIdentity: null,
            defaultModelSelection: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            scripts: [],
          }}
          parentThreadLink={{ threadId: ThreadId.make("parent"), title: "父会话" }}
          onOpenThread={() => {}}
          rightPanelOpen={false}
          onNewThreadInProject={() => {}}
        />
      </header>
    </SidebarProvider>
  );
}

it("expands breadcrumb touch hit areas vertically to 44px without overlapping the sidebar trigger", async () => {
  {
    await using _pointer = await emulatePointer({ width: 390, height: 844, pointer: "coarse" });
    await using screen = await render(headerWithSidebarTrigger());
    await vi.waitFor(() => expect(window.matchMedia("(pointer: coarse)").matches).toBe(true));

    const trigger = screen.getByRole("button", { name: "切换主侧边栏" }).element();
    const projectBtn = screen.getByRole("button", { name: "在 fleet-ade 中新建会话" }).element();
    const parentBtn = screen.getByRole("button", { name: "打开父会话：父会话" }).element();
    const titleBtn = screen.getByRole("button", { name: "会话标题 的会话操作" }).element();

    for (const button of [projectBtn, parentBtn, titleBtn]) {
      const rect = button.getBoundingClientRect();
      const afterStyle = getComputedStyle(button, "::after");
      const cx = rect.left + rect.width / 2;
      expect(rect.height).toBeLessThanOrEqual(28);
      expect(Number.parseFloat(afterStyle.minHeight)).toBeGreaterThanOrEqual(44);
      expect(document.elementFromPoint(cx, rect.top - 8)).toBe(button);
      expect(document.elementFromPoint(cx, rect.bottom + 8)).toBe(button);
    }

    const triggerRect = trigger.getBoundingClientRect();
    const triggerAfterWidth = Number.parseFloat(getComputedStyle(trigger, "::after").minWidth);
    const triggerHitRight = triggerRect.left + triggerRect.width / 2 + triggerAfterWidth / 2;
    const projectRect = projectBtn.getBoundingClientRect();
    const projectCy = projectRect.top + projectRect.height / 2;
    const triggerCy = triggerRect.top + triggerRect.height / 2;

    expect(projectRect.left).toBeGreaterThanOrEqual(triggerHitRight);
    expect(document.elementFromPoint(projectRect.left + 1, projectCy)).toBe(projectBtn);
    expect(document.elementFromPoint(projectRect.left + 1, projectRect.top - 8)).toBe(projectBtn);
    expect(document.elementFromPoint(triggerRect.right + 4, triggerCy)).toBe(trigger);
  }

  {
    await using _pointer = await emulatePointer({ width: 1280, height: 800, pointer: "fine" });
    await using screen = await render(headerWithSidebarTrigger());
    await vi.waitFor(() => expect(window.matchMedia("(pointer: fine)").matches).toBe(true));

    for (const name of ["在 fleet-ade 中新建会话", "打开父会话：父会话", "会话标题 的会话操作"]) {
      const button = screen.getByRole("button", { name }).element();
      expect(getComputedStyle(button, "::after").content).toBe("none");
    }
  }
});
