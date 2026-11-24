import { converter } from "culori/fn";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";

const toRgb = converter("rgb");

function BasicSelect({ onSelect }: { onSelect?: (value: string) => void }) {
  return (
    <Select defaultValue="alpha" onValueChange={onSelect}>
      <SelectTrigger aria-label="Letter">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="alpha">Alpha</SelectItem>
        <SelectItem value="bravo">Bravo</SelectItem>
        <SelectItem value="charlie">Charlie</SelectItem>
      </SelectPopup>
    </Select>
  );
}

function resolvedColor(variable: string) {
  const probe = document.createElement("div");
  probe.style.color = `var(${variable})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
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
    const popup = page.getByRole("listbox");
    await expect.element(popup).toBeVisible();
    const popupElement = popup.element();
    const selected = page.getByRole("option", { name: "Alpha" }).element();
    const popupStyle = getComputedStyle(popupElement);
    const itemStyle = getComputedStyle(selected);

    const gap = await vi.waitFor(() => {
      const value =
        popupElement.getBoundingClientRect().top - trigger.element().getBoundingClientRect().bottom;
      expect(value, "settled popup gap").toBeGreaterThanOrEqual(4);
      return value;
    });
    expect(gap, "settled popup gap").toBeGreaterThanOrEqual(4);
    expect(toRgb(popupStyle.backgroundColor)?.alpha ?? 1).toBe(1);
    expect(popupStyle.backdropFilter).toBe("none");
    expect(popupStyle.willChange).toBe("auto");
    expect(popupStyle.borderRadius).toBe("12px");
    expect(popupStyle.padding).toBe("8px");
    expect(popupStyle.borderWidth).toBe("1px");
    expect(selected.getBoundingClientRect().height).toBe(32);
    expect(itemStyle.fontSize).toBe("14px");
    expect(itemStyle.fontWeight).toBe("400");
    expect(itemStyle.borderRadius).toBe("4px");
    expect(itemStyle.backgroundColor).toBe(resolvedColor("--fa-selected"));
    expect(itemStyle.backgroundColor).not.toBe(resolvedColor("--fa-accent"));
    expect(getComputedStyle(selected.querySelector(".tick")!).visibility).toBe("visible");

    await userEvent.keyboard("{ArrowDown}");
    const highlighted = page.getByRole("option", { name: "Bravo" }).element();
    await vi.waitFor(() => expect(highlighted.hasAttribute("data-highlighted")).toBe(true));
    expect(getComputedStyle(highlighted).backgroundImage).not.toBe("none");
  });

  it("keeps disabled triggers opaque and secondary-colored across default, Grove, and Ember", async () => {
    const root = document.documentElement;
    try {
      await using screen = await render(
        <div className="w-64 space-y-2 p-4">
          <Select defaultValue="alpha">
            <SelectTrigger aria-label="enabled">
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
      const enabled = screen.getByRole("combobox", { name: "enabled" }).element();
      const disabled = screen.getByRole("combobox", { name: "disabled" }).element();
      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);
          const disabledStyle = getComputedStyle(disabled);
          expect(disabledStyle.opacity, `${themeId} ${appearance} opacity`).toBe("1");
          expect(disabledStyle.color, `${themeId} ${appearance} color`).toBe(
            resolvedColor("--fa-fg-muted"),
          );
          expect(disabledStyle.color).not.toBe(getComputedStyle(enabled).color);
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
