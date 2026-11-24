import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "./sidebar";

function CollapseFromInside() {
  const { setOpen } = useSidebar();
  return (
    <button type="button" onClick={() => setOpen(false)}>
      Collapse
    </button>
  );
}

function Harness(props: { readonly onResize?: (width: number) => void }) {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        collapsible="offcanvas"
        resizable={{
          minWidth: 200,
          maxWidth: 600,
          ...(props.onResize ? { onResize: props.onResize } : {}),
        }}
      >
        <CollapseFromInside />
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
      </SidebarInset>
    </SidebarProvider>
  );
}

describe("Sidebar", () => {
  it("hands focus to the outside trigger when it collapses around the focused control", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(<Harness />, { router: false /* no routes involved */ });

    const sidebarContainer = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-container"]',
    )!;
    const sidebarInset = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-inset"]',
    )!;
    expect(getComputedStyle(sidebarContainer).position).toBe("fixed");
    const expandedMainWidth = sidebarInset.getBoundingClientRect().width;
    await userEvent.click(screen.getByRole("button", { name: "Collapse" }));

    const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
    await vi.waitFor(() => expect(sidebar.inert).toBe(true));
    const trigger = screen.container.querySelector('[data-slot="sidebar-trigger"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    await vi.waitFor(() =>
      expect(sidebarContainer.getBoundingClientRect().right).toBeLessThanOrEqual(0),
    );
    await vi.waitFor(() =>
      expect(sidebarInset.getBoundingClientRect().width).toBeGreaterThan(expandedMainWidth),
    );
  });

  it("abandons a rail drag when the sidebar collapses mid-drag", async () => {
    await page.viewport(1280, 800);
    const onResize = vi.fn();
    await using screen = await render(<Harness onResize={onResize} />, {
      router: false /* no routes involved */,
    });
    const rail = screen.container.querySelector<HTMLElement>('[data-sidebar="rail"]')!;
    const { left, top } = rail.getBoundingClientRect();
    const pointer = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientY: top + 10 };
    const dragTo = (clientX: number) => {
      rail.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: left }));
      rail.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX }));
    };
    // A completed drag commits, so the abandoned one below is a real drag too.
    dragTo(left + 40);
    rail.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: left + 40 }));
    expect(onResize).toHaveBeenCalledTimes(1);

    dragTo(left + 80);
    await userEvent.click(
      screen.container.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')!,
    );
    rail.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: left + 80 }));

    expect(onResize).toHaveBeenCalledTimes(1);
  });
});

it("restores collapsed and expanded desktop state after remounting", async () => {
  await page.viewport(1280, 800);
  const storageKey = "sidebar_persistence_test";
  localStorage.removeItem(storageKey);
  const layout = () => (
    <SidebarProvider storageKey={storageKey}>
      <SidebarTrigger />
    </SidebarProvider>
  );
  {
    await using screen = await render(layout(), { router: false /* no routes involved */ });
    const trigger = screen.getByRole("button", { name: "切换侧边栏" });
    await expect.element(trigger).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(trigger);
    await expect.element(trigger).toHaveAttribute("aria-pressed", "false");
  }
  {
    await using screen = await render(layout(), { router: false /* no routes involved */ });
    const trigger = screen.getByRole("button", { name: "切换侧边栏" });
    await expect.element(trigger).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(trigger);
  }
  await using screen = await render(layout(), { router: false /* no routes involved */ });
  await expect
    .element(screen.getByRole("button", { name: "切换侧边栏" }))
    .toHaveAttribute("aria-pressed", "true");
  localStorage.removeItem(storageKey);
});

it("keeps the mobile sheet closed and leaves the saved desktop state alone", async () => {
  await page.viewport(390, 844);
  const storageKey = "sidebar_mobile_persistence_test";
  localStorage.setItem(storageKey, "false");
  {
    await using screen = await render(
      <SidebarProvider storageKey={storageKey}>
        <SidebarTrigger />
      </SidebarProvider>,
      { router: false /* no routes involved */ },
    );
    const trigger = screen.getByRole("button", { name: "切换侧边栏" });
    await expect.element(trigger).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(trigger);
    await expect.element(trigger).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(storageKey)).toBe("false");
  }
  await using screen = await render(
    <SidebarProvider storageKey={storageKey}>
      <SidebarTrigger />
    </SidebarProvider>,
    { router: false /* no routes involved */ },
  );
  await expect
    .element(screen.getByRole("button", { name: "切换侧边栏" }))
    .toHaveAttribute("aria-pressed", "false");
  localStorage.removeItem(storageKey);
});

function MobileSheetMountedProbe() {
  const { mobileSheetMounted } = useSidebar();
  return <output aria-label="Sheet mounted">{String(mobileSheetMounted)}</output>;
}

it("keeps closed mobile sheet contents mounted and reports the sheet only while it shows", async () => {
  await page.viewport(390, 844);
  await using screen = await render(
    <SidebarProvider>
      <Sidebar>
        <span>Sheet contents</span>
      </Sidebar>
      <SidebarTrigger />
      <MobileSheetMountedProbe />
    </SidebarProvider>,
    { router: false /* no routes involved */ },
  );
  const sheetMounted = screen.getByLabelText("Sheet mounted");
  // Window shortcuts registered by sidebar children only work while they stay mounted.
  expect(document.querySelector('[data-mobile="true"]')?.textContent).toContain("Sheet contents");
  await expect.element(sheetMounted).toHaveTextContent("false");

  await userEvent.click(screen.getByRole("button", { name: "切换侧边栏" }));
  await expect.element(sheetMounted).toHaveTextContent("true");

  await userEvent.keyboard("{Escape}");
  await expect.element(sheetMounted).toHaveTextContent("false");
  expect(document.querySelector('[data-mobile="true"]')?.textContent).toContain("Sheet contents");
});

function MobileLayoutTrigger() {
  const { isMobile, openMobile } = useSidebar();
  return (
    <div className={isMobile && openMobile ? "hidden" : undefined}>
      <SidebarTrigger />
    </div>
  );
}

it("caps mobile drawer width to leave a scrim strip that closes the drawer, blocks click-through, and restores opener focus", async () => {
  const prev = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(390, 844);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(prev.width, prev.height),
  };
  const onBackgroundClick = vi.fn();

  await using screen = await render(
    <SidebarProvider>
      <Sidebar>
        <span>Drawer contents</span>
        <button type="button">Drawer action</button>
      </Sidebar>
      <SidebarInset>
        <MobileLayoutTrigger />
        <MobileSheetMountedProbe />
        <div style={{ height: "2000px" }}>
          <button
            type="button"
            onClick={onBackgroundClick}
            style={{ position: "fixed", right: 4, top: 300, width: 40, height: 80 }}
          >
            Behind scrim
          </button>
        </div>
      </SidebarInset>
    </SidebarProvider>,
    { router: false /* no routes involved */ },
  );

  const trigger = screen.container.querySelector<HTMLButtonElement>(
    '[data-slot="sidebar-trigger"]',
  )!;
  const sheetMounted = screen.getByLabelText("Sheet mounted");

  await userEvent.click(trigger);
  await expect.element(sheetMounted).toHaveTextContent("true");

  const popup = document.querySelector<HTMLElement>(
    '[data-mobile="true"][data-sidebar="sidebar"]',
  )!;
  const backdrop = document.querySelector<HTMLElement>('[data-slot="sheet-backdrop"]')!;
  expect(popup).not.toBeNull();
  expect(backdrop).not.toBeNull();

  const popupRect = popup.getBoundingClientRect();
  expect(Math.round(popupRect.width)).toBeLessThanOrEqual(window.innerWidth - 48);
  expect(getComputedStyle(backdrop).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

  const stripX = window.innerWidth - 16;
  expect(document.elementFromPoint(stripX, 340)).toBe(backdrop);

  const overflowLocked =
    getComputedStyle(document.documentElement).overflowY === "hidden" ||
    getComputedStyle(document.body).overflowY === "hidden";
  expect(overflowLocked).toBe(true);

  await userEvent.click(backdrop, { position: { x: stripX, y: 340 } });
  await expect.element(sheetMounted).toHaveTextContent("false");
  expect(onBackgroundClick).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));

  await userEvent.click(trigger);
  await expect.element(sheetMounted).toHaveTextContent("true");
  await userEvent.keyboard("{Escape}");
  await expect.element(sheetMounted).toHaveTextContent("false");
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("opens the mobile sheet without a transition while panel animations are off", async () => {
  await page.viewport(390, 844);
  await using screen = await render(
    <SidebarProvider>
      <Sidebar>
        <span>Sheet contents</span>
      </Sidebar>
      <SidebarTrigger />
    </SidebarProvider>,
    { router: false /* no routes involved */ },
  );
  await userEvent.click(screen.getByRole("button", { name: "切换侧边栏" }));
  const popup = document.querySelector<HTMLElement>('[data-mobile="true"][data-sidebar="sidebar"]');
  expect(popup).not.toBeNull();
  expect(getComputedStyle(popup!).transitionDuration).toBe("0s");
});
