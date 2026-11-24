import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { converter, modeOklch, modeRgb, useMode } from "culori/fn";
import { useState } from "react";

import "~/index.css";
import { render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { Button } from "./button";
import { Input } from "./input";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./collapsible";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "./sheet";

useMode(modeRgb);
useMode(modeOklch);
const toRgb = converter("rgb");

function resolved(variable: string): string {
  const probe = document.createElement("div");
  probe.style.color = `var(${variable})`;
  document.body.append(probe);
  try {
    return getComputedStyle(probe).color;
  } finally {
    probe.remove();
  }
}

function contrastRatio(first: string, second: string): number {
  const luminance = (value: string) => {
    const rgb = toRgb(value)!;
    return [rgb.r, rgb.g, rgb.b]
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  };
  const firstL = luminance(first);
  const secondL = luminance(second);
  return (Math.max(firstL, secondL) + 0.05) / (Math.min(firstL, secondL) + 0.05);
}

const popupEl = () => document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
const backdropEl = () => document.querySelector<HTMLElement>('[data-slot="sheet-backdrop"]');

function SheetDemo(props: { keepMounted?: boolean; side?: "left" | "right" | "top" | "bottom" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>打开面板</Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup side={props.side ?? "right"} keepMounted={props.keepMounted ?? false}>
          <SheetHeader>
            <SheetTitle>工作区面板</SheetTitle>
            <SheetDescription>展示工作区详情。</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 p-4">
            <Input placeholder="第一项" />
            <Input placeholder="第二项" />
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
}

function CollapsibleDemo() {
  return (
    <Collapsible>
      <CollapsibleTrigger>高级设置</CollapsibleTrigger>
      <CollapsiblePanel>
        <div>高级内容</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

describe("Sheet", () => {
  it("removes popup and backdrop and leaves no residual box-shadow after closing", async () => {
    await using _screen = await render(<SheetDemo />);
    await userEvent.click(page.getByRole("button", { name: "打开面板" }));

    await vi.waitFor(() => {
      expect(getComputedStyle(popupEl()!).boxShadow).not.toBe("none");
      expect(backdropEl()).not.toBeNull();
    });

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(popupEl(), "popup should unmount after the closing animation").toBeNull();
      expect(backdropEl(), "backdrop should unmount after the closing animation").toBeNull();
    });
    expect(document.querySelectorAll("[data-slot^='sheet-']")).toHaveLength(0);
  });

  it("keeps a mounted keepMounted popup hidden and shadowless once closed", async () => {
    await using _screen = await render(<SheetDemo keepMounted />);
    await userEvent.click(page.getByRole("button", { name: "打开面板" }));
    await vi.waitFor(() => expect(popupEl()).not.toBeNull());

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      const popup = popupEl()!;
      expect(popup.hasAttribute("hidden"), "closed keepMounted popup gets hidden").toBe(true);
      expect(getComputedStyle(popup).display).toBe("none");
      expect(getComputedStyle(popup).boxShadow).toBe("none");
      const backdrop = backdropEl()!;
      expect(getComputedStyle(backdrop).display).toBe("none");
    });
  });

  it("returns focus to the invoking element on Escape", async () => {
    await using screen = await render(<SheetDemo />);
    const trigger = screen.getByRole("button", { name: "打开面板" });
    await userEvent.click(trigger);
    await vi.waitFor(() => expect(popupEl()).not.toBeNull());

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger.element()));
  });

  it("keeps Tab focus inside the open popup", async () => {
    await using _screen = await render(<SheetDemo />);
    await userEvent.click(page.getByRole("button", { name: "打开面板" }));
    await vi.waitFor(() => expect(popupEl()?.contains(document.activeElement)).toBe(true));

    for (let i = 0; i < 6; i++) {
      await userEvent.keyboard("{Tab}");
      expect(popupEl()!.contains(document.activeElement), `Tab ${i + 1} escaped`).toBe(true);
    }
    for (let i = 0; i < 3; i++) {
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      expect(popupEl()!.contains(document.activeElement), `Shift+Tab ${i + 1} escaped`).toBe(true);
    }
  });

  it("paints solid overlay surface without backdrop-filter or will-change and >= 4.5 text contrast", async () => {
    const root = document.documentElement;
    const restore = {
      datasetTheme: root.dataset.theme,
      datasetThemeId: root.dataset.themeId,
      dark: root.classList.contains("dark"),
      style: root.style.cssText,
    };
    await using _screen = await render(<SheetDemo />);
    await userEvent.click(page.getByRole("button", { name: "打开面板" }));
    await vi.waitFor(() => expect(popupEl()).not.toBeNull());
    const popup = popupEl()!;
    const backdrop = backdropEl()!;
    const title = document.querySelector<HTMLElement>('[data-slot="sheet-title"]')!;
    const description = document.querySelector<HTMLElement>('[data-slot="sheet-description"]')!;

    try {
      for (const [theme, appearance] of [
        ["system", "light"],
        ["system", "dark"],
        [GROVE_THEME.id, "light"],
        [GROVE_THEME.id, "dark"],
        [EMBER_THEME.id, "light"],
        [EMBER_THEME.id, "dark"],
      ] as const) {
        applyThemePalette(theme, appearance);
        root.classList.toggle("dark", appearance === "dark");
        root.dataset.theme = appearance;
        await vi.waitFor(() => {
          const popupStyle = getComputedStyle(popup);
          const backdropStyle = getComputedStyle(backdrop);
          const popupBg = popupStyle.backgroundColor;
          expect(popupBg, `${theme}/${appearance} popup`).toBe(resolved("--fa-overlay"));
          expect(toRgb(popupBg)?.alpha ?? 1, `${theme}/${appearance} solid popup`).toBe(1);
          expect(popupStyle.backdropFilter, `${theme}/${appearance} popup blur`).toBe("none");
          expect(popupStyle.willChange, `${theme}/${appearance} popup willChange`).toBe("auto");
          expect(backdropStyle.backgroundColor, `${theme}/${appearance} backdrop`).toBe(
            resolved("--fa-scrim"),
          );
          expect(backdropStyle.backdropFilter, `${theme}/${appearance} backdrop blur`).toBe("none");
          expect(
            contrastRatio(getComputedStyle(title).color, popupBg),
            `${theme}/${appearance} title contrast`,
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            contrastRatio(getComputedStyle(description).color, popupBg),
            `${theme}/${appearance} description contrast`,
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
    } finally {
      root.style.cssText = restore.style;
      root.classList.toggle("dark", restore.dark);
      if (restore.datasetTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = restore.datasetTheme;
      if (restore.datasetThemeId === undefined) delete root.dataset.themeId;
      else root.dataset.themeId = restore.datasetThemeId;
    }
  });

  it("does not overflow a phone-width viewport", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(390, 844);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using _screen = await render(<SheetDemo />);
    await userEvent.click(page.getByRole("button", { name: "打开面板" }));
    await vi.waitFor(() => {
      const rect = popupEl()!.getBoundingClientRect();
      expect(rect.left, "left edge").toBeGreaterThanOrEqual(-0.5);
      expect(rect.right, "right edge").toBeLessThanOrEqual(window.innerWidth + 0.5);
      expect(rect.top, "top edge").toBeGreaterThanOrEqual(-0.5);
      expect(rect.bottom, "bottom edge").toBeLessThanOrEqual(window.innerHeight + 0.5);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    });
  });
});

describe("Collapsible", () => {
  it("toggles aria-expanded and unmounts collapsed content", async () => {
    await using screen = await render(<CollapsibleDemo />);
    const trigger = screen.getByRole("button", { name: "高级设置" });
    expect(trigger.element().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-slot="collapsible-panel"]')).toBeNull();

    await userEvent.click(trigger);
    await vi.waitFor(() => {
      expect(trigger.element().getAttribute("aria-expanded")).toBe("true");
      const panel = document.querySelector<HTMLElement>('[data-slot="collapsible-panel"]');
      expect(panel).not.toBeNull();
      expect(panel!.getBoundingClientRect().height).toBeGreaterThan(0);
    });

    await userEvent.click(trigger);
    await vi.waitFor(() => {
      expect(trigger.element().getAttribute("aria-expanded")).toBe("false");
      expect(
        document.querySelector('[data-slot="collapsible-panel"]'),
        "collapsed panel unmounts",
      ).toBeNull();
    });
  });
});
