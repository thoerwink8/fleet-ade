import { converter } from "culori/fn";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";

const toRgb = converter("rgb");

function BasicSelect({ onSelect }: { onSelect?: (value: string | null) => void }) {
  return (
    <Select defaultValue="alpha" onValueChange={onSelect}>
      <SelectTrigger aria-label="Letter">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {/* Many call sites pass hideIndicator; the selected row must still show its check. */}
        <SelectItem hideIndicator value="alpha">
          Alpha
        </SelectItem>
        <SelectItem value="bravo">Bravo</SelectItem>
        <SelectItem value="charlie">Charlie</SelectItem>
      </SelectPopup>
    </Select>
  );
}

function resolvedColor(variable: string) {
  return resolvedStyle("color", variable);
}

function resolvedBackground(variable: string) {
  return resolvedStyle("backgroundColor", variable);
}

function resolvedStyle(property: "color" | "backgroundColor" | "borderTopColor", variable: string) {
  const probe = document.createElement("div");
  probe.style[property] = `var(${variable})`;
  document.body.append(probe);
  const value = getComputedStyle(probe)[property];
  probe.remove();
  return value;
}

function neutralHighlightImage() {
  const probe = document.createElement("div");
  probe.className = "fa-item";
  probe.style.setProperty("--fa-hover", "color-mix(in srgb, var(--fa-fg) 5%, transparent)");
  probe.style.backgroundImage = "var(--fa-hv)";
  document.body.append(probe);
  const image = getComputedStyle(probe).backgroundImage;
  probe.remove();
  return image;
}

function accentHighlightImage() {
  const probe = document.createElement("div");
  probe.style.backgroundImage = "linear-gradient(var(--accent), var(--accent))";
  document.body.append(probe);
  const image = getComputedStyle(probe).backgroundImage;
  probe.remove();
  return image;
}

async function emulateCoarsePointer(): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  const session = cdp();
  await page.viewport(390, 844);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
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
  return {
    async [Symbol.asyncDispose]() {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await session.send("Emulation.clearDeviceMetricsOverride");
      await page.viewport(previous.width, previous.height);
    },
  };
}

describe("Select", () => {
  it("uses 32px form triggers and 28px ghost triggers at wide and narrow viewports", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using screen = await render(
      <div className="w-64 space-y-2 p-4">
        {(["default", "sm", "compact", "xs"] as const).map((size) => (
          <Select key={size} defaultValue="alpha">
            <SelectTrigger aria-label={size} size={size}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="alpha">Alpha</SelectItem>
            </SelectPopup>
          </Select>
        ))}
        <Select defaultValue="alpha">
          <SelectTrigger aria-label="ghost" size="xs" variant="ghost">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="alpha">Alpha</SelectItem>
          </SelectPopup>
        </Select>
      </div>,
    );

    for (const width of [1280, 390]) {
      await page.viewport(width, 844);
      for (const size of ["default", "sm", "compact", "xs"] as const) {
        const trigger = screen.getByRole("combobox", { name: size }).element();
        const style = getComputedStyle(trigger);
        expect(trigger.getBoundingClientRect().height, `${size} height at ${width}`).toBe(32);
        expect(style.fontSize, `${size} font at ${width}`).toBe("14px");
        expect(style.borderRadius, `${size} radius at ${width}`).toBe("8px");
        expect(style.paddingInline, `${size} padding at ${width}`).toBe("12px");
      }
      const ghost = screen.getByRole("combobox", { name: "ghost" }).element();
      const ghostStyle = getComputedStyle(ghost);
      expect(ghost.getBoundingClientRect().height, `ghost height at ${width}`).toBe(28);
      expect(ghostStyle.fontSize, `ghost font at ${width}`).toBe("14px");
      expect(ghostStyle.paddingInline, `ghost padding at ${width}`).toBe("8px");
      expect(ghostStyle.color, `ghost secondary text at ${width}`).toBe(
        resolvedColor("--fa-fg-muted"),
      );
    }
  });

  it("expands coarse-pointer hit areas to 44px without changing trigger heights", async () => {
    await using _pointer = await emulateCoarsePointer();
    await using screen = await render(
      <div className="w-64 space-y-2 p-4">
        <Select defaultValue="alpha">
          <SelectTrigger aria-label="form">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="alpha">Alpha</SelectItem>
          </SelectPopup>
        </Select>
        <Select defaultValue="alpha">
          <SelectTrigger aria-label="ghost" variant="ghost">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="alpha">Alpha</SelectItem>
          </SelectPopup>
        </Select>
      </div>,
    );

    for (const [name, visibleHeight] of [
      ["form", 32],
      ["ghost", 28],
    ] as const) {
      const trigger = screen.getByRole("combobox", { name }).element();
      const after = getComputedStyle(trigger, "::after");
      expect(trigger.getBoundingClientRect().height, `${name} visible height`).toBe(visibleHeight);
      expect(Number.parseFloat(after.height), `${name} hit area`).toBeGreaterThanOrEqual(44);
    }
  });

  it("opens 4px below the trigger with a solid 12px popup and 32px neutral selected items", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(<BasicSelect />);
    const trigger = screen.getByRole("combobox", { name: "Letter" });
    await userEvent.click(trigger);
    const listbox = page.getByRole("listbox");
    await expect.element(listbox).toBeVisible();
    const popupElement = document.querySelector<HTMLElement>('[data-slot="select-popup"]')!;
    const selected = page.getByRole("option", { name: "Alpha" }).element();
    const popupStyle = getComputedStyle(popupElement);
    const itemStyle = getComputedStyle(selected);

    const gap = await vi.waitFor(() => {
      const value =
        popupElement.getBoundingClientRect().top - trigger.element().getBoundingClientRect().bottom;
      expect(value, "popup top is not above the trigger").toBeGreaterThanOrEqual(0);
      expect(Math.abs(value - 4), "settled popup gap").toBeLessThan(1);
      return value;
    });
    expect(gap, "settled popup gap").toBeGreaterThanOrEqual(0);
    expect(toRgb(popupStyle.backgroundColor)?.alpha ?? 1).toBe(1);
    expect(popupStyle.backdropFilter).toBe("none");
    expect(popupStyle.willChange).toBe("auto");
    expect(popupStyle.borderRadius).toBe("12px");
    expect(popupStyle.padding).toBe("8px");
    expect(popupStyle.borderTopWidth).toBe("1px");
    expect(popupStyle.borderRightWidth).toBe("1px");
    expect(popupStyle.borderBottomWidth).toBe("1px");
    expect(popupStyle.borderLeftWidth).toBe("1px");
    expect(selected.getBoundingClientRect().height).toBe(32);
    expect(itemStyle.fontSize).toBe("14px");
    expect(itemStyle.fontWeight).toBe("400");
    expect(itemStyle.borderRadius).toBe("4px");
    expect(itemStyle.backgroundColor).toBe(resolvedBackground("--fa-selected"));
    expect(itemStyle.backgroundColor).not.toBe(resolvedBackground("--fa-accent"));
    expect(itemStyle.backgroundColor).not.toBe(resolvedBackground("--accent"));
    expect(getComputedStyle(selected.querySelector(".tick")!).visibility).toBe("visible");

    await userEvent.keyboard("{ArrowDown}");
    const highlighted = page.getByRole("option", { name: "Bravo" }).element();
    await vi.waitFor(() => expect(highlighted.hasAttribute("data-highlighted")).toBe(true));
    const highlightImage = getComputedStyle(highlighted).backgroundImage;
    expect(highlightImage).toBe(neutralHighlightImage());
    expect(highlightImage).not.toBe(accentHighlightImage());
    expect(highlightImage).not.toBe("none");
  });

  it("reads form, popup, and item colors for default, Grove, and Ember without restyling disabled", async () => {
    const root = document.documentElement;
    try {
      await using screen = await render(
        <div className="w-64 space-y-2 p-4">
          <Select defaultValue="alpha">
            <SelectTrigger aria-label="resting">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="alpha">Alpha</SelectItem>
            </SelectPopup>
          </Select>
          <Select defaultValue="alpha">
            <SelectTrigger aria-label="enabled">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="alpha">Alpha</SelectItem>
              <SelectItem value="bravo">Bravo</SelectItem>
            </SelectPopup>
          </Select>
          <Select defaultValue="alpha">
            <SelectTrigger aria-label="ghost" variant="ghost">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="alpha">Alpha</SelectItem>
            </SelectPopup>
          </Select>
          <Select defaultValue="alpha" disabled>
            <SelectTrigger aria-label="disabled">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="alpha">Alpha</SelectItem>
            </SelectPopup>
          </Select>
        </div>,
      );
      const resting = screen.getByRole("combobox", { name: "resting" }).element();
      const ghost = screen.getByRole("combobox", { name: "ghost" }).element();
      const disabled = screen.getByRole("combobox", { name: "disabled" }).element();
      await userEvent.click(screen.getByRole("combobox", { name: "enabled" }));
      await expect.element(page.getByRole("listbox")).toBeVisible();
      await userEvent.keyboard("{ArrowDown}");
      const selected = page.getByRole("option", { name: "Alpha" }).element();
      const highlighted = page.getByRole("option", { name: "Bravo" }).element();
      await vi.waitFor(() => expect(highlighted.hasAttribute("data-highlighted")).toBe(true));
      const popup = document.querySelector<HTMLElement>('[data-slot="select-popup"]')!;

      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          const label = `${themeId} ${appearance}`;
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);

          const restingStyle = getComputedStyle(resting);
          expect(restingStyle.color, `${label} trigger text`).toBe(resolvedColor("--fa-fg"));
          expect(restingStyle.backgroundColor, `${label} trigger fill`).toBe(
            resolvedBackground("--fa-bg"),
          );
          expect(restingStyle.borderTopColor, `${label} trigger border`).toBe(
            resolvedStyle("borderTopColor", "--fa-border"),
          );

          expect(getComputedStyle(ghost).color, `${label} ghost text`).toBe(
            resolvedColor("--fa-fg-muted"),
          );

          const popupStyle = getComputedStyle(popup);
          expect(popupStyle.backgroundColor, `${label} popup fill`).toBe(
            resolvedBackground("--fa-overlay"),
          );
          expect(toRgb(popupStyle.backgroundColor)?.alpha ?? 1, `${label} popup alpha`).toBe(1);
          expect(popupStyle.borderTopColor, `${label} popup border`).toBe(
            resolvedStyle("borderTopColor", "--fa-border"),
          );

          const selectedStyle = getComputedStyle(selected);
          expect(selectedStyle.backgroundColor, `${label} selected fill`).toBe(
            resolvedBackground("--fa-selected"),
          );
          expect(selectedStyle.backgroundColor, `${label} selected is not accent`).not.toBe(
            resolvedBackground("--fa-accent"),
          );
          expect(selectedStyle.backgroundColor, `${label} selected is not accent surface`).not.toBe(
            resolvedBackground("--accent"),
          );
          const highlightImage = getComputedStyle(highlighted).backgroundImage;
          expect(highlightImage, `${label} highlight`).toBe(neutralHighlightImage());
          expect(highlightImage, `${label} highlight is not accent`).not.toBe(
            accentHighlightImage(),
          );

          const disabledStyle = getComputedStyle(disabled);
          expect(disabledStyle.opacity, `${label} disabled opacity`).toBe("1");
          expect(disabledStyle.color, `${label} disabled text`).toBe(
            resolvedColor("--fa-fg-muted"),
          );
          expect(disabledStyle.color, `${label} disabled is not primary text`).not.toBe(
            restingStyle.color,
          );
          expect(disabledStyle.backgroundColor, `${label} disabled fill`).toBe(
            resolvedBackground("--fa-bg"),
          );
          expect(disabledStyle.backgroundColor, `${label} disabled fill is not accent`).not.toBe(
            resolvedBackground("--fa-accent"),
          );
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("moves with arrows, selects with Enter, restores focus on Escape, and jumps by first letter", async () => {
    const onSelect = vi.fn();
    await using screen = await render(<BasicSelect onSelect={onSelect} />);
    const trigger = screen.getByRole("combobox", { name: "Letter" });
    await userEvent.click(trigger);
    await expect.element(page.getByRole("listbox")).toBeVisible();
    // The highlighted option is focused a frame after the list is shown. ArrowDown
    // before that is taken as "jump to the first item", which is already selected.
    await expect.element(page.getByRole("option", { name: "Alpha" })).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() =>
      expect(
        page.getByRole("option", { name: "Bravo" }).element().hasAttribute("data-highlighted"),
      ).toBe(true),
    );
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith("bravo", expect.anything());

    await userEvent.click(trigger);
    await expect.element(page.getByRole("listbox")).toBeVisible();
    await userEvent.keyboard("c");
    await vi.waitFor(() =>
      expect(
        page.getByRole("option", { name: "Charlie" }).element().hasAttribute("data-highlighted"),
      ).toBe(true),
    );
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  });

  it("does not paint gradients over scroll arrows", async () => {
    await using screen = await render(
      <Select defaultValue="item-0">
        <SelectTrigger aria-label="Many items">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup className="max-h-40">
          {Array.from({ length: 20 }, (_, index) => (
            <SelectItem key={index} value={`item-${index}`}>
              Item {index}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Many items" }));
    await expect.element(page.getByRole("listbox")).toBeVisible();
    const downArrow = document.querySelector('[data-slot="select-scroll-down-arrow"]')!;
    expect(getComputedStyle(downArrow, "::before").backgroundImage).toBe("none");
  });
});
