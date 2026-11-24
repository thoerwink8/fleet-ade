import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { converter } from "culori/fn";

import "~/index.css";
import { render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";

const toRgb = converter("rgb");

function luminance(color: string) {
  const { r, g, b } = toRgb(color)!;
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(foreground: string, background: string) {
  const sorted = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (sorted[0]! + 0.05) / (sorted[1]! + 0.05);
}

function BasicMenu({ onSelect }: { onSelect?: (item: string) => void }) {
  return (
    <Menu>
      <MenuTrigger>Open</MenuTrigger>
      <MenuPopup>
        <MenuItem onClick={() => onSelect?.("first")}>First item</MenuItem>
        <MenuItem onClick={() => onSelect?.("second")}>Second item</MenuItem>
        <MenuItem disabled>Disabled item</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

describe("Menu", () => {
  it("uses fleet-design item height (32px at sm+, 14px font, taller on narrow viewports) and solid 8px-padded popup", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(390, 844);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using screen = await render(<BasicMenu />);

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const popup = page.getByRole("menu");
    await expect.element(popup).toBeVisible();
    const popupElement = popup.element();
    const item = page.getByRole("menuitem", { name: "First item" }).element();

    expect(item.getBoundingClientRect().height, "narrow item height").toBeGreaterThan(32);
    expect(getComputedStyle(popupElement).padding, "popup padding").toBe("8px");

    await page.viewport(1280, 800);
    const itemStyle = getComputedStyle(item);
    const popupStyle = getComputedStyle(popupElement);
    expect(item.getBoundingClientRect().height, "sm+ item height").toBe(32);
    expect(itemStyle.fontSize, "sm+ item font size").toBe("14px");
    expect(popupStyle.padding, "popup padding at sm+").toBe("8px");
    expect(popupStyle.backdropFilter, "popup backdropFilter").toBe("none");
    expect(popupStyle.willChange, "popup willChange").toBe("auto");
    expect(toRgb(popupStyle.backgroundColor)?.alpha ?? 1, "popup background alpha").toBe(1);
  });

  it("moves the highlight with arrow keys, selects with Enter, and closes on Escape restoring focus", async () => {
    const onSelect = vi.fn();
    await using screen = await render(<BasicMenu onSelect={onSelect} />);
    const trigger = screen.getByRole("button", { name: "Open" });

    await userEvent.click(trigger);
    const menu = page.getByRole("menu");
    await expect.element(menu).toBeVisible();
    const first = page.getByRole("menuitem", { name: "First item" });
    const second = page.getByRole("menuitem", { name: "Second item" });

    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => {
      expect(
        first.element().hasAttribute("data-highlighted") ||
          second.element().hasAttribute("data-highlighted"),
        "an item is highlighted",
      ).toBe(true);
    });
    const highlightedBefore = [first, second].find((item) =>
      item.element().hasAttribute("data-highlighted"),
    )!;

    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => {
      const highlightedAfter = [first, second].find((item) =>
        item.element().hasAttribute("data-highlighted"),
      );
      expect(highlightedAfter, "highlight moved to the next item").not.toBe(highlightedBefore);
      expect(highlightedAfter, "highlight still on an item").toBeTruthy();
    });

    await userEvent.keyboard("{Enter}");
    await expect.element(menu).not.toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledTimes(1);

    await userEvent.click(trigger);
    await expect.element(page.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  });

  it("distinguishes disabled items from enabled ones across default, Grove, and Ember in light and dark", async () => {
    const root = document.documentElement;
    try {
      await using screen = await render(<BasicMenu />);
      await userEvent.click(screen.getByRole("button", { name: "Open" }));
      await expect.element(page.getByRole("menu")).toBeVisible();
      const enabled = page.getByRole("menuitem", { name: "First item" }).element();
      const disabled = page.getByRole("menuitem", { name: "Disabled item" }).element();
      expect(disabled.hasAttribute("data-disabled")).toBe(true);

      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);
          const enabledColor = getComputedStyle(enabled).color;
          const disabledColor = getComputedStyle(disabled).color;
          expect(
            disabledColor,
            `${themeId} ${appearance} disabled (${disabledColor}) should differ from enabled (${enabledColor})`,
          ).not.toBe(enabledColor);
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("keeps popup text at 4.5:1 contrast across default, Grove, and Ember in light and dark", async () => {
    const root = document.documentElement;
    try {
      await using screen = await render(<BasicMenu />);
      await userEvent.click(screen.getByRole("button", { name: "Open" }));
      const popup = page.getByRole("menu");
      await expect.element(popup).toBeVisible();
      const popupElement = popup.element();

      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);
          const style = getComputedStyle(popupElement);
          const ratio = contrastRatio(style.color, style.backgroundColor);
          expect(
            ratio,
            `${themeId} ${appearance} popup text (${style.color} on ${style.backgroundColor})`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });
});
