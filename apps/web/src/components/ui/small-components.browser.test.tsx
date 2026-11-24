import { CircleAlertIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./empty";
import { Input } from "./input";
import { Label } from "./label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "./number-field";

function setAppearance(appearance: "light" | "dark") {
  const root = document.documentElement;
  root.classList.toggle("dark", appearance === "dark");
  root.dataset.theme = appearance;
}

describe("Empty, Label, and NumberField", () => {
  it("uses fleet-design type, muted states, flat surfaces, and input heights", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    const root = document.documentElement;
    try {
      await using screen = await render(
        <div className="grid gap-8 p-4">
          <Empty aria-label="Empty fixture" className="min-h-80">
            <EmptyMedia variant="icon">
              <CircleAlertIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Nothing yet</EmptyTitle>
              <EmptyDescription>Add an item to continue.</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <EmptyMedia variant="warning" data-testid="warning-media">
            <CircleAlertIcon />
          </EmptyMedia>
          <div className="grid gap-2">
            <Label>Normal label</Label>
            <Label aria-disabled="true">Disabled label</Label>
            <fieldset disabled className="group/field">
              <Label>Fieldset disabled label</Label>
            </fieldset>
            <div className="group/field" data-disabled="">
              <Label>Group disabled label</Label>
            </div>
          </div>
          <div className="grid gap-3">
            <NumberField aria-label="Default number" defaultValue={2}>
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease default" />
                <NumberFieldInput aria-label="Default number value" />
                <NumberFieldIncrement aria-label="Increase default" />
              </NumberFieldGroup>
            </NumberField>
            <NumberField aria-label="Small number" defaultValue={3} size="sm">
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease small" />
                <NumberFieldInput aria-label="Small number value" />
                <NumberFieldIncrement aria-label="Increase small" />
              </NumberFieldGroup>
            </NumberField>
            <NumberField aria-label="Invalid number" defaultValue={4}>
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease invalid" />
                <NumberFieldInput aria-label="Invalid number value" aria-invalid="true" />
                <NumberFieldIncrement aria-label="Increase invalid" />
              </NumberFieldGroup>
            </NumberField>
            <NumberField aria-label="Disabled number" defaultValue={5} disabled>
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease disabled" />
                <NumberFieldInput aria-label="Disabled number value" />
                <NumberFieldIncrement aria-label="Increase disabled" />
              </NumberFieldGroup>
            </NumberField>
            <Input aria-label="Reference input" />
            <Input aria-label="Reference invalid" aria-invalid="true" />
          </div>
        </div>,
      );

      const empty = screen.getByLabelText("Empty fixture").element();
      const title = screen.container.querySelector('[data-slot="empty-title"]')!;
      const description = screen.container.querySelector('[data-slot="empty-description"]')!;
      const media = screen.container.querySelector('[data-slot="empty-media"]')!;
      const normalLabel = screen.getByText("Normal label").element();
      const disabledLabel = screen.getByText("Disabled label").element();
      const fieldsetLabel = screen.getByText("Fieldset disabled label").element();
      const groupLabel = screen.getByText("Group disabled label").element();
      const defaultGroup = screen.container.querySelector('[data-slot="number-field-group"]')!;
      const defaultInput = screen.getByRole("textbox", { name: "Default number value" }).element();
      const decrement = screen.getByRole("button", { name: "Decrease default" }).element();
      const smallGroup = screen
        .getByRole("textbox", { name: "Small number value" })
        .element()
        .closest('[data-slot="number-field-group"]')!;
      const invalidInput = screen.getByRole("textbox", { name: "Invalid number value" }).element();
      const invalidGroup = invalidInput.closest('[data-slot="number-field-group"]')!;
      const referenceInput = screen.getByRole("textbox", { name: "Reference input" }).element();
      const referenceInvalid = screen.getByRole("textbox", { name: "Reference invalid" }).element();

      root.classList.add("no-transitions");
      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          setAppearance(appearance);
          applyThemePalette(themeId, appearance);
          const colorProbe = document.createElement("div");
          screen.container.append(colorProbe);
          const resolvedColor = (name: string, property: "color" | "borderColor" = "color") => {
            colorProbe.style.color = "";
            colorProbe.style.borderColor = "";
            colorProbe.style[property] = `var(${name})`;
            return getComputedStyle(colorProbe)[property];
          };
          const fg = resolvedColor("--fa-fg");
          const muted = resolvedColor("--fa-fg-muted");

          const titleStyle = getComputedStyle(title);
          expect(titleStyle.fontSize, `${themeId} ${appearance} title size`).toBe("18px");
          expect(Number(titleStyle.fontWeight), `${themeId} title weight`).toBeLessThanOrEqual(500);
          expect(titleStyle.color, `${themeId} title color`).toBe(fg);
          const descriptionStyle = getComputedStyle(description);
          expect(descriptionStyle.fontSize, `${themeId} description size`).toBe("14px");
          expect(
            Number(descriptionStyle.fontWeight),
            `${themeId} description weight`,
          ).toBeLessThanOrEqual(500);
          expect(descriptionStyle.color, `${themeId} description color`).toBe(muted);
          expect(getComputedStyle(media).color, `${themeId} media color`).toBe(muted);
          const warningMedia = screen.container.querySelector('[data-testid="warning-media"]')!;
          expect(getComputedStyle(warningMedia).color, `${themeId} warning media color`).toBe(
            resolvedColor("--warning"),
          );
          expect(getComputedStyle(warningMedia).color).not.toBe(muted);
          expect(getComputedStyle(normalLabel).color, `${themeId} label color`).toBe(fg);
          expect(getComputedStyle(disabledLabel).color, `${themeId} disabled label color`).toBe(
            muted,
          );
          expect(getComputedStyle(disabledLabel).opacity, `${themeId} disabled opacity`).toBe("1");
          expect(getComputedStyle(fieldsetLabel).color, `${themeId} fieldset label`).toBe(muted);
          expect(getComputedStyle(fieldsetLabel).opacity, `${themeId} fieldset opacity`).toBe("1");
          expect(getComputedStyle(groupLabel).color, `${themeId} group label`).toBe(muted);
          expect(getComputedStyle(groupLabel).opacity, `${themeId} group opacity`).toBe("1");
          expect(getComputedStyle(defaultGroup).borderColor, `${themeId} field border`).toBe(
            getComputedStyle(referenceInput).borderColor,
          );
          expect(getComputedStyle(invalidGroup).borderColor, `${themeId} invalid border`).toBe(
            getComputedStyle(referenceInvalid).borderColor,
          );
        }
      }

      setAppearance("light");
      applyThemePalette("system", "light");
      const emptyStyle = getComputedStyle(empty);
      expect(emptyStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(emptyStyle.backdropFilter).toBe("none");
      expect(emptyStyle.boxShadow).toBe("none");
      expect(emptyStyle.filter).toBe("none");
      expect(emptyStyle.willChange).toBe("auto");
      expect(emptyStyle.gap).toBe("8px");
      expect(emptyStyle.paddingBlock).toBe("32px");
      expect(emptyStyle.paddingInline).toBe("16px");
      expect(getComputedStyle(normalLabel).fontSize).toBe("14px");
      expect(Number(getComputedStyle(normalLabel).fontWeight)).toBeLessThanOrEqual(500);

      expect(defaultGroup.getBoundingClientRect().height, "default group height").toBe(32);
      expect(smallGroup.getBoundingClientRect().height, "small group height").toBe(28);
      expect(
        decrement.getBoundingClientRect().height,
        "step does not grow group",
      ).toBeLessThanOrEqual(30);
      expect(getComputedStyle(defaultInput).fontSize).toBe("14px");

      await page.viewport(390, 844);
      const session = cdp();
      await session.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 5,
      });
      await session.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "pointer", value: "coarse" },
          { name: "hover", value: "none" },
        ],
      });
      expect(defaultGroup.getBoundingClientRect().height, "narrow default group height").toBe(36);
      expect(smallGroup.getBoundingClientRect().height, "narrow small group height").toBe(32);
      expect(
        getComputedStyle(defaultInput).fontSize,
        "narrow type is 16px so iOS does not zoom",
      ).toBe("16px");
      const after = getComputedStyle(decrement, "::after");
      expect(Number.parseFloat(after.width), "coarse hit width").toBeGreaterThanOrEqual(44);
      expect(Number.parseFloat(after.height), "coarse hit height").toBeGreaterThanOrEqual(44);
      const disabledField = screen
        .getByRole("textbox", { name: "Disabled number value" })
        .element()
        .closest('[data-slot="number-field"]')!;
      expect(getComputedStyle(disabledField).opacity).toBe("1");
      await session.send("Emulation.setEmulatedMedia", { features: [] });
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    } finally {
      await page.viewport(viewport.width, viewport.height);
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });
});
