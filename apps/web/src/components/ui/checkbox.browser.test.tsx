import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { converter } from "culori/fn";

import "~/index.css";
import { render } from "../../../test/render";
import {
  applyThemePalette,
  EMBER_THEME,
  getThemeColorsForMode,
  GROVE_THEME,
} from "../../themePalette";
import { Checkbox, CheckboxMark } from "./checkbox";

const toRgb = converter("rgb");

function expectCloseColor(actualValue: string, expectedValue: string, label: string) {
  const expected = toRgb(expectedValue)!;
  const actual = toRgb(actualValue)!;
  expect(actual.alpha ?? 1, `${label} alpha`).toBeCloseTo(expected.alpha ?? 1, 2);
  [expected.r, expected.g, expected.b].forEach((channel, index) => {
    const actualChannel = [actual.r, actual.g, actual.b][index]!;
    expect(Math.abs(channel * 255 - actualChannel * 255), `${label} ch${index}`).toBeLessThan(1.5);
  });
}

describe("Checkbox", () => {
  it("matches fleet-design box geometry, checked colors, and focus ring in light and dark, and follows --primary in Grove and Ember", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    const root = document.documentElement;
    try {
      applyThemePalette("system", "light");
      await using screen = await render(<Checkbox aria-label="Accept" defaultChecked />);
      const box = screen.getByRole("checkbox", { name: "Accept" }).element();

      await userEvent.keyboard("{Tab}");
      await expect.element(box).toHaveFocus();

      for (const [appearance, expectedBg, expectedFg, expectedRing] of [
        ["light", "rgb(27, 27, 31)", "rgb(255, 255, 255)", "rgb(44, 91, 216)"],
        ["dark", "rgb(236, 236, 238)", "rgb(24, 24, 27)", "rgb(124, 156, 245)"],
      ] as const) {
        root.classList.toggle("dark", appearance === "dark");
        root.dataset.theme = appearance;
        const style = getComputedStyle(box);
        expect(style.width, `${appearance} width`).toBe("16px");
        expect(style.height, `${appearance} height`).toBe("16px");
        expect(style.borderRadius, `${appearance} radius`).toBe("4px");
        expect(style.backgroundColor, `${appearance} checked bg`).toBe(expectedBg);
        expect(style.color, `${appearance} checked mark`).toBe(expectedFg);
        expect(style.outlineStyle, `${appearance} focus ring style`).toBe("solid");
        expect(style.outlineWidth, `${appearance} focus ring width`).toBe("2px");
        expect(style.outlineColor, `${appearance} focus ring color`).toBe(expectedRing);
      }

      for (const theme of [GROVE_THEME, EMBER_THEME]) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(theme.id, appearance);
          const colors = getThemeColorsForMode(theme, appearance)!;
          expectCloseColor(
            getComputedStyle(box).backgroundColor,
            colors.messageAction,
            `${theme.id} ${appearance} checkbox checked bg`,
          );
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });
  it("distinguishes disabled checked checkboxes from enabled checked ones across default, Grove, and Ember in light and dark", async () => {
    const root = document.documentElement;
    try {
      await using screen = await render(
        <div>
          <Checkbox aria-label="Enabled" defaultChecked />
          <Checkbox aria-label="Disabled" defaultChecked disabled />
        </div>,
      );
      const enabled = screen.getByRole("checkbox", { name: "Enabled" }).element();
      const disabled = screen.getByRole("checkbox", { name: "Disabled" }).element();

      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);
          const enabledStyle = getComputedStyle(enabled);
          const disabledStyle = getComputedStyle(disabled);
          expect(
            disabledStyle.backgroundColor !== enabledStyle.backgroundColor ||
              Number(disabledStyle.opacity) < Number(enabledStyle.opacity),
            `${themeId} ${appearance} disabled checked (${disabledStyle.backgroundColor}, opacity ${disabledStyle.opacity}) should differ from enabled (${enabledStyle.backgroundColor}, opacity ${enabledStyle.opacity})`,
          ).toBe(true);
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("uses 18px box below sm (390px) and 16px at sm and above", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(390, 844);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using screen = await render(
      <div>
        <Checkbox aria-label="Mobile" defaultChecked />
        <CheckboxMark checked />
      </div>,
    );
    const box = screen.getByRole("checkbox", { name: "Mobile" }).element();
    const mark = screen.container.querySelector('[aria-hidden][data-slot="checkbox"]')!;
    const narrowStyle = getComputedStyle(box);
    expect(narrowStyle.width, "narrow width").toBe("18px");
    expect(narrowStyle.height, "narrow height").toBe("18px");
    expect(getComputedStyle(mark).width, "narrow mark width").toBe("18px");
    expect(getComputedStyle(mark).height, "narrow mark height").toBe("18px");

    await page.viewport(640, 844);
    const wideStyle = getComputedStyle(box);
    expect(wideStyle.width, "sm+ width").toBe("16px");
    expect(wideStyle.height, "sm+ height").toBe("16px");
    expect(getComputedStyle(mark).width, "sm+ mark width").toBe("16px");
    expect(getComputedStyle(mark).height, "sm+ mark height").toBe("16px");
  });

  it("toggles with Space, blocks disabled interaction, and sets aria-checked including mixed", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    const onDisabledChange = vi.fn();
    await using screen = await render(
      <div>
        <Checkbox aria-label="Active" />
        <Checkbox aria-label="Mixed" indeterminate />
        <Checkbox aria-label="Locked" disabled onCheckedChange={onDisabledChange} />
        <Checkbox aria-label="Invalid" aria-invalid="true" />
        <CheckboxMark checked />
      </div>,
    );

    const active = screen.getByRole("checkbox", { name: "Active" });
    await expect.element(active).toHaveAttribute("aria-checked", "false");
    await userEvent.keyboard("{Tab}");
    await expect.element(active).toHaveFocus();
    await userEvent.keyboard(" ");
    await expect.element(active).toHaveAttribute("aria-checked", "true");

    const mixed = screen.getByRole("checkbox", { name: "Mixed" });
    await expect.element(mixed).toHaveAttribute("aria-checked", "mixed");

    const locked = screen.getByRole("checkbox", { name: "Locked" });
    await expect.element(locked).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(locked, { force: true });
    expect(onDisabledChange).not.toHaveBeenCalled();
    await expect.element(locked).toHaveAttribute("aria-checked", "false");

    const mark = screen.container.querySelector('[aria-hidden][data-slot="checkbox"]');
    const invalid = screen.getByRole("checkbox", { name: "Invalid" }).element();
    expect(getComputedStyle(invalid).borderColor).toBe("rgb(190, 42, 42)");

    expect(getComputedStyle(mark!).width).toBe("16px");
    expect(getComputedStyle(mark!).height).toBe("16px");
    expect(mark?.getAttribute("data-checked")).toBe("");
  });
});
