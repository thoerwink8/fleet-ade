import { converter } from "culori/fn";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { Input } from "./input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./input-group";
import { Textarea } from "./textarea";

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

describe("Input, Textarea, and InputGroup", () => {
  it("renders 32px height at sm and above, 34px on narrow viewports, error border with --fa-danger, and fleet focus ring", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    const root = document.documentElement;
    try {
      applyThemePalette("system", "light");
      await using screen = await render(
        <div className="space-y-3 p-4">
          <Input aria-label="Default input" />
          <Input aria-label="Small input" size="sm" />
          <Input aria-label="Invalid input" aria-invalid="true" />
          <Textarea aria-label="Multiline notes" />
          <InputGroup>
            <InputGroupAddon align="inline-start">https://</InputGroupAddon>
            <InputGroupInput aria-label="Grouped input" />
            <InputGroupAddon align="inline-end">.com</InputGroupAddon>
          </InputGroup>
          <InputGroup>
            <InputGroupInput aria-label="Invalid grouped input" aria-invalid="true" />
          </InputGroup>
        </div>,
      );

      const defaultInput = screen.getByRole("textbox", { name: "Default input" }).element();
      const smallInput = screen.getByRole("textbox", { name: "Small input" }).element();
      const invalidInput = screen.getByRole("textbox", { name: "Invalid input" }).element();
      const textarea = screen.getByRole("textbox", { name: "Multiline notes" }).element();
      const groupedInput = screen.getByRole("textbox", { name: "Grouped input" }).element();
      const groupFrame = groupedInput.closest('[data-slot="input-group"]')!;
      const invalidGroupedInput = screen
        .getByRole("textbox", { name: "Invalid grouped input" })
        .element();
      const invalidGroupFrame = invalidGroupedInput.closest('[data-slot="input-group"]')!;

      await userEvent.keyboard("{Tab}");
      await expect.element(defaultInput).toHaveFocus();

      root.classList.add("no-transitions");
      for (const [appearance, expectedBg, expectedDanger, expectedRing] of [
        ["light", "rgb(255, 255, 255)", "rgb(190, 42, 42)", "rgb(44, 91, 216)"],
        ["dark", "rgb(24, 24, 27)", "rgb(243, 143, 138)", "rgb(124, 156, 245)"],
      ] as const) {
        root.classList.toggle("dark", appearance === "dark");
        root.dataset.theme = appearance;
        const style = getComputedStyle(defaultInput);
        expect(style.height, `${appearance} sm+ height`).toBe("32px");
        expect(style.borderRadius, `${appearance} radius`).toBe("8px");
        expect(style.backgroundColor, `${appearance} bg`).toBe(expectedBg);
        expect(style.outlineStyle, `${appearance} focus ring style`).toBe("solid");
        expect(style.outlineWidth, `${appearance} focus ring width`).toBe("2px");
        expect(style.outlineColor, `${appearance} focus ring color`).toBe(expectedRing);

        expect(getComputedStyle(smallInput).height, `${appearance} sm size height`).toBe("28px");
        expect(getComputedStyle(groupFrame).height, `${appearance} group height`).toBe("32px");
        expect(getComputedStyle(invalidInput).borderColor, `${appearance} invalid border`).toBe(
          expectedDanger,
        );
        expect(
          getComputedStyle(invalidGroupFrame).borderColor,
          `${appearance} invalid group border`,
        ).toBe(expectedDanger);
        expect(getComputedStyle(textarea).borderRadius, `${appearance} textarea radius`).toBe(
          "8px",
        );
      }

      // Focusing the grouped input via keyboard activates the group frame focus ring.
      await userEvent.keyboard("{Tab}");
      await userEvent.keyboard("{Tab}");
      await userEvent.keyboard("{Tab}");
      await userEvent.keyboard("{Tab}");
      await expect.element(groupedInput).toHaveFocus();
      expect(getComputedStyle(groupFrame).outlineStyle).toBe("solid");
      expect(getComputedStyle(groupFrame).outlineWidth).toBe("2px");

      // Narrow viewport (<640px) keeps taller touch-friendly heights without shrinking mobile inputs.
      await page.viewport(390, 844);
      expect(getComputedStyle(defaultInput).height, "narrow default height").toBe("34px");
      expect(getComputedStyle(smallInput).height, "narrow sm height").toBe("30px");
      expect(getComputedStyle(groupFrame).height, "narrow group height").toBe("34px");
    } finally {
      root.classList.remove("no-transitions");
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("distinguishes disabled inputs, textareas, and input groups from enabled ones across default, Grove, and Ember in light and dark", async () => {
    const root = document.documentElement;
    try {
      await using screen = await render(
        <div className="space-y-3 p-4">
          <Input aria-label="Enabled input" defaultValue="abc" />
          <Input aria-label="Disabled input" defaultValue="abc" disabled />
          <Textarea aria-label="Enabled textarea" defaultValue="abc" />
          <Textarea aria-label="Disabled textarea" defaultValue="abc" disabled />
          <InputGroup>
            <InputGroupInput aria-label="Enabled grouped" defaultValue="abc" />
          </InputGroup>
          <InputGroup>
            <InputGroupInput aria-label="Disabled grouped" defaultValue="abc" disabled />
          </InputGroup>
        </div>,
      );

      const enabledInput = screen.getByRole("textbox", { name: "Enabled input" }).element();
      const disabledInput = screen.getByRole("textbox", { name: "Disabled input" }).element();
      const enabledTextarea = screen.getByRole("textbox", { name: "Enabled textarea" }).element();
      const disabledTextarea = screen.getByRole("textbox", { name: "Disabled textarea" }).element();
      const enabledGroup = screen
        .getByRole("textbox", { name: "Enabled grouped" })
        .element()
        .closest('[data-slot="input-group"]')!;
      const disabledGroup = screen
        .getByRole("textbox", { name: "Disabled grouped" })
        .element()
        .closest('[data-slot="input-group"]')!;

      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);

          for (const [label, enabledEl, disabledEl] of [
            ["input", enabledInput, disabledInput],
            ["textarea", enabledTextarea, disabledTextarea],
            ["input-group", enabledGroup, disabledGroup],
          ] as const) {
            const enabledStyle = getComputedStyle(enabledEl);
            const disabledStyle = getComputedStyle(disabledEl);
            expect(
              disabledStyle.backgroundColor !== enabledStyle.backgroundColor ||
                disabledStyle.color !== enabledStyle.color ||
                Number(disabledStyle.opacity) < Number(enabledStyle.opacity),
              `${themeId} ${appearance} disabled ${label} (${disabledStyle.backgroundColor}, ${disabledStyle.color}) should differ from enabled (${enabledStyle.backgroundColor}, ${enabledStyle.color})`,
            ).toBe(true);
          }

          const invalidDanger = getComputedStyle(document.documentElement).getPropertyValue(
            "--fa-danger",
          );
          expect(invalidDanger.trim().length).toBeGreaterThan(0);
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("preserves readOnly, addon focus forwarding, textarea rows/autogrow, and Grove/Ember error borders", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const root = document.documentElement;
    try {
      await using screen = await render(
        <div className="space-y-3 p-4">
          <Input aria-label="Readonly input" defaultValue="fixed" readOnly />
          <Textarea aria-label="Rows textarea" rows={4} />
          <InputGroup>
            <InputGroupAddon data-testid="prefix-addon">Prefix</InputGroupAddon>
            <InputGroupInput aria-label="Addon target" />
          </InputGroup>
          <Input aria-label="Grove invalid" aria-invalid="true" />
          <InputGroup className="**:[input]:h-9 sm:**:[input]:h-8">
            <InputGroupInput aria-label="Forced height" size="sm" />
          </InputGroup>
        </div>,
      );

      // Callers force inner input heights; the group frame must grow around them (input + 1px border each side), never clip them.
      const forcedInput = screen.getByRole("textbox", { name: "Forced height" }).element();
      const forcedFrame = forcedInput.closest('[data-slot="input-group"]')!;
      for (const [width, expectedInput] of [
        [1280, "32px"],
        [390, "36px"],
      ] as const) {
        await page.viewport(width, 800);
        expect(getComputedStyle(forcedInput).height, `${width} forced input height`).toBe(
          expectedInput,
        );
        expect(forcedFrame.getBoundingClientRect().height, `${width} frame wraps input`).toBe(
          forcedInput.getBoundingClientRect().height + 2,
        );
      }
      await page.viewport(1280, 800);

      const readonlyInput = screen.getByRole("textbox", { name: "Readonly input" }).element();
      expect(readonlyInput).toHaveAttribute("readonly");

      const rowsTextarea = screen.getByRole("textbox", { name: "Rows textarea" }).element();
      expect((rowsTextarea as HTMLTextAreaElement).rows).toBe(4);
      expect(getComputedStyle(rowsTextarea).fieldSizing).toBe("content");

      const addon = screen.getByTestId("prefix-addon").element();
      const addonTarget = screen.getByRole("textbox", { name: "Addon target" }).element();
      await userEvent.click(addon);
      await expect.element(addonTarget).toHaveFocus();
      const invalidEl = screen.getByRole("textbox", { name: "Grove invalid" }).element();
      root.classList.add("no-transitions");
      for (const theme of [GROVE_THEME, EMBER_THEME]) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(theme.id, appearance);
          const dangerValue = getComputedStyle(root).getPropertyValue("--fa-danger").trim();
          expectCloseColor(
            getComputedStyle(invalidEl).borderColor,
            dangerValue,
            `${theme.id} ${appearance} invalid border`,
          );
        }
      }
    } finally {
      await page.viewport(viewport.width, viewport.height);
      root.classList.remove("no-transitions");
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });
});
