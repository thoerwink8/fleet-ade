import { PlusIcon } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Button } from "./button";
import { PanelTabCloseButton } from "./panel-tab-close-button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider } from "./sidebar";
import { Toggle } from "./toggle";

async function emulateCoarsePointer() {
  const prev = { width: window.innerWidth, height: window.innerHeight };
  const session = cdp();
  await page.viewport(390, 844);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await session.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "pointer", value: "coarse" },
      { name: "hover", value: "none" },
    ],
  });
  return {
    async [Symbol.asyncDispose]() {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await session.send("Emulation.clearDeviceMetricsOverride");
      await page.viewport(prev.width, prev.height);
    },
  };
}

describe("Touch hit-area expansion and overlap splitting", () => {
  it("expands coarse touch hit areas to >= 44px without changing painted icon dimensions", async () => {
    await using _pointer = await emulateCoarsePointer();
    await using screen = await render(
      <SidebarProvider>
        <div className="flex flex-col items-start gap-12 p-12">
          <Button size="icon-xs" aria-label="Icon XS">
            <PlusIcon className="size-3.5" />
          </Button>
          <Toggle size="xs" aria-label="Toggle XS">
            <PlusIcon className="size-3.5" />
          </Toggle>
          <PanelTabCloseButton label="Close Tab" onClick={() => {}}>
            <PlusIcon className="size-3" />
          </PanelTabCloseButton>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="icon-sm" aria-label="Sidebar Icon">
                <PlusIcon className="size-4" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <button
            type="button"
            className="ade-touch-target flex size-6 items-center justify-center"
            aria-label="Raw Icon"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>
      </SidebarProvider>,
      { router: false /* no routes involved */ },
    );

    await vi.waitFor(() => expect(window.matchMedia("(pointer: coarse)").matches).toBe(true));

    const checks = [
      { name: "Icon XS", maxVisualPx: 24 },
      { name: "Toggle XS", maxVisualPx: 28 },
      { name: "Close Tab", maxVisualPx: 16 },
      { name: "Sidebar Icon", maxVisualPx: 32 },
      { name: "Raw Icon", maxVisualPx: 24 },
    ] as const;

    for (const { name, maxVisualPx } of checks) {
      const button = screen.getByRole("button", { name }).element();
      const rect = button.getBoundingClientRect();
      const afterStyle = getComputedStyle(button, "::after");
      const cx = rect.left + rect.width / 2;

      expect(Math.round(rect.width)).toBeLessThanOrEqual(maxVisualPx);
      expect(Math.round(rect.height)).toBeLessThanOrEqual(maxVisualPx);
      expect(Number.parseFloat(afterStyle.minWidth)).toBeGreaterThanOrEqual(44);
      expect(Number.parseFloat(afterStyle.minHeight)).toBeGreaterThanOrEqual(44);
      expect(document.elementFromPoint(cx, rect.top - 5)).toBe(button);
      expect(document.elementFromPoint(cx, rect.bottom + 5)).toBe(button);
    }
  });

  it("splits overlapping hit areas halfway between adjacent icon buttons in ade-touch-row", async () => {
    await using _pointer = await emulateCoarsePointer();
    await using screen = await render(
      <div className="flex flex-col items-start gap-12 p-12">
        <div className="ade-touch-row ade-touch-row--gap-1 flex items-center gap-1">
          <Button size="icon-xs" aria-label="Tight Left">
            <PlusIcon className="size-3.5" />
          </Button>
          <Button size="icon-xs" aria-label="Tight Right">
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
        <div className="ade-touch-row ade-touch-row--gap-5 flex items-center gap-1 pointer-coarse:gap-5">
          <Button size="icon-xs" aria-label="Wide First">
            <PlusIcon className="size-3.5" />
          </Button>
          <Button size="icon-xs" aria-label="Wide Middle">
            <PlusIcon className="size-3.5" />
          </Button>
          <Button size="icon-xs" aria-label="Wide Last">
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
      </div>,
      { router: false /* no routes involved */ },
    );

    await vi.waitFor(() => expect(window.matchMedia("(pointer: coarse)").matches).toBe(true));

    const tightLeft = screen.getByRole("button", { name: "Tight Left" }).element();
    const tightRight = screen.getByRole("button", { name: "Tight Right" }).element();
    const tightLeftRect = tightLeft.getBoundingClientRect();
    const tightRightRect = tightRight.getBoundingClientRect();
    const tightMidX = (tightLeftRect.right + tightRightRect.left) / 2;
    const tightCy = tightLeftRect.top + tightLeftRect.height / 2;

    expect(document.elementFromPoint(tightMidX - 1, tightCy)).toBe(tightLeft);
    expect(document.elementFromPoint(tightMidX + 1, tightCy)).toBe(tightRight);
    expect(document.elementFromPoint(tightLeftRect.left - 8, tightCy)).toBe(tightLeft);
    expect(document.elementFromPoint(tightRightRect.right + 8, tightCy)).toBe(tightRight);

    const wideFirst = screen.getByRole("button", { name: "Wide First" }).element();
    const wideMiddle = screen.getByRole("button", { name: "Wide Middle" }).element();
    const wideLast = screen.getByRole("button", { name: "Wide Last" }).element();
    const wideFirstRect = wideFirst.getBoundingClientRect();
    const wideMiddleRect = wideMiddle.getBoundingClientRect();
    const wideLastRect = wideLast.getBoundingClientRect();
    const wideCy = wideMiddleRect.top + wideMiddleRect.height / 2;
    const mid1 = (wideFirstRect.right + wideMiddleRect.left) / 2;
    const mid2 = (wideMiddleRect.right + wideLastRect.left) / 2;

    expect(document.elementFromPoint(mid1 - 1, wideCy)).toBe(wideFirst);
    expect(document.elementFromPoint(mid1 + 1, wideCy)).toBe(wideMiddle);
    expect(document.elementFromPoint(mid2 - 1, wideCy)).toBe(wideMiddle);
    expect(document.elementFromPoint(mid2 + 1, wideCy)).toBe(wideLast);
    expect(Math.round(Number.parseFloat(getComputedStyle(wideMiddle, "::after").width))).toBe(44);
    expect(Math.round(Number.parseFloat(getComputedStyle(wideMiddle, "::after").height))).toBe(44);
  });

  it("keeps ::after touch expansion inactive on desktop fine pointer", async () => {
    const prev = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(prev.width, prev.height),
    };
    await using screen = await render(
      <div className="p-12">
        <button
          type="button"
          className="ade-touch-target flex size-6 items-center justify-center"
          aria-label="Desktop Raw Icon"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>,
      { router: false /* no routes involved */ },
    );

    const button = screen.getByRole("button", { name: "Desktop Raw Icon" }).element();
    const rect = button.getBoundingClientRect();
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(false);
    expect(getComputedStyle(button, "::after").content).toBe("none");
    expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top - 6)).not.toBe(button);
  });
});
