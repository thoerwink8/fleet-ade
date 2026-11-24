import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { converter, wcagContrast } from "culori/fn";

import "~/index.css";
import { render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { ToggleGroup, Toggle } from "./toggle-group";
import { RadioGroup, Radio } from "./radio-group";

const toRgb = converter("rgb");

function contrastBetween(fg: string, bg: string): number {
  return wcagContrast(toRgb(fg)!, toRgb(bg)!);
}

const OPTIONS = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
] as const;

describe("ToggleGroup (segmented)", () => {
  it("uses fleet-design 32px group / 24px item geometry and arrow-key navigation", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    const onValueChange = vi.fn();
    await using screen = await render(
      <ToggleGroup
        aria-label="Range"
        variant="segmented"
        value={["day"]}
        onValueChange={onValueChange}
      >
        {OPTIONS.map(([value, label]) => (
          <Toggle key={value} value={value}>
            {label}
          </Toggle>
        ))}
      </ToggleGroup>,
    );
    const group = screen.getByRole("group", { name: "Range" }).element();
    expect(getComputedStyle(group).height).toBe("32px");

    const day = screen.getByRole("button", { name: "Day" }).element();
    const week = screen.getByRole("button", { name: "Week" });
    expect(getComputedStyle(day).height).toBe("24px");
    expect(day.getAttribute("aria-pressed")).toBe("true");

    // Roving tabindex: Tab enters the group, arrows move focus between items.
    await userEvent.keyboard("{Tab}");
    await expect.element(day).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(week).toHaveFocus();
    await userEvent.keyboard("{End}");
    await expect.element(screen.getByRole("button", { name: "Month" })).toHaveFocus();
    // Space/Enter toggles the focused item and fires the group callback.
    onValueChange.mockClear();
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.keyboard(" ");
    expect(onValueChange).toHaveBeenCalled();
  });

  it("renders unselected-vs-selected and disabled-vs-enabled distinguishably in light and dark across default, Grove, and Ember", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    const root = document.documentElement;
    try {
      await using screen = await render(
        <ToggleGroup aria-label="Range" variant="segmented" value={["week"]}>
          <Toggle value="day">Day</Toggle>
          <Toggle value="week">Week</Toggle>
          <Toggle value="month" disabled>
            Month
          </Toggle>
        </ToggleGroup>,
      );

      const selected = screen.getByRole("button", { name: "Week" }).element();
      const unselected = screen.getByRole("button", { name: "Day" }).element();
      const disabled = screen.getByRole("button", { name: "Month" }).element();

      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);
          const selectedStyle = getComputedStyle(selected);
          const unselectedStyle = getComputedStyle(unselected);
          const disabledStyle = getComputedStyle(disabled);

          // Selected vs unselected must be visually distinguishable.
          expect(
            selectedStyle.backgroundColor !== unselectedStyle.backgroundColor ||
              selectedStyle.color !== unselectedStyle.color ||
              selectedStyle.boxShadow !== unselectedStyle.boxShadow,
            `${themeId} ${appearance}: selected and unselected items must differ`,
          ).toBe(true);

          // Disabled item must differ from enabled unselected.
          expect(
            disabledStyle.color !== unselectedStyle.color ||
              disabledStyle.textDecorationLine.includes("line-through") ||
              disabledStyle.cursor === "not-allowed",
            `${themeId} ${appearance}: disabled item must be distinguishable`,
          ).toBe(true);

          // AA text contrast: unselected muted-fg on its own background ≥ 4.5.
          const unselectedContrast = contrastBetween(
            unselectedStyle.color,
            unselectedStyle.backgroundColor === "rgba(0, 0, 0, 0)"
              ? getComputedStyle(unselected.parentElement!).backgroundColor
              : unselectedStyle.backgroundColor,
          );
          expect(
            unselectedContrast,
            `${themeId} ${appearance} unselected contrast`,
          ).toBeGreaterThanOrEqual(4.5);

          // Selected: fg on selected bg ≥ 4.5.
          const selectedContrast = contrastBetween(
            selectedStyle.color,
            selectedStyle.backgroundColor,
          );
          expect(
            selectedContrast,
            `${themeId} ${appearance} selected contrast`,
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

describe("RadioGroup", () => {
  it("renders a semantic radiogroup with radio items and selects on arrow key", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    const onValueChange = vi.fn();
    await using screen = await render(
      <RadioGroup aria-label="Size" value="m" onValueChange={onValueChange}>
        <Radio value="s" aria-label="Small" />
        <Radio value="m" aria-label="Medium" />
        <Radio value="l" aria-label="Large" />
      </RadioGroup>,
    );

    const group = screen.getByRole("radiogroup", { name: "Size" }).element();
    expect(group).toBeTruthy();

    const medium = screen.getByRole("radio", { name: "Medium" }).element();
    const large = screen.getByRole("radio", { name: "Large" });
    expect(medium.getAttribute("aria-checked")).toBe("true");

    await userEvent.keyboard("{Tab}");
    await expect.element(medium).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(large).toHaveFocus();
    expect(onValueChange).toHaveBeenCalledWith("l", expect.anything());
  });
});

describe("ToggleGroup (outline, non-segmented)", () => {
  it("keeps the taller touch height on narrow viewports and the compact height from sm up", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using screen = await render(
      <ToggleGroup aria-label="Status" variant="outline" size="xs" value={["a"]}>
        <Toggle value="a">A</Toggle>
        <Toggle value="b">B</Toggle>
      </ToggleGroup>,
    );
    const item = screen.getByRole("button", { name: "A" }).element();
    const ctrlXs = parseFloat(getComputedStyle(item).getPropertyValue("--fa-ctrl-xs"));
    const ctrlSm = parseFloat(getComputedStyle(item).getPropertyValue("--fa-ctrl-sm"));

    await page.viewport(1280, 800);
    expect(parseFloat(getComputedStyle(item).height)).toBe(ctrlXs);
    await page.viewport(375, 800);
    expect(parseFloat(getComputedStyle(item).height)).toBe(ctrlSm);
  });
});
