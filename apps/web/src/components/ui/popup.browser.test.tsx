import { useState } from "react";
import { converter } from "culori/fn";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "./autocomplete";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "./combobox";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

const toRgb = converter("rgb");
const FRUITS = ["Alpha", "Bravo", "Charlie"] as const;

function px(value: string) {
  return Number.parseFloat(value);
}

function luminance(color: string) {
  const { r, g, b } = toRgb(color)!;
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(foreground: string, background: string) {
  const sorted = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (sorted[0]! + 0.05) / (sorted[1]! + 0.05);
}

function surfaceProbe(className: string) {
  const probe = document.createElement("div");
  probe.className = className;
  document.body.append(probe);
  return probe;
}

function expectLibrarySurface(element: HTMLElement, probeClassName: string, paddingPx: number) {
  const probe = surfaceProbe(probeClassName);
  try {
    const style = getComputedStyle(element);
    const library = getComputedStyle(probe);
    const alpha = toRgb(style.backgroundColor)?.alpha ?? 1;
    expect(alpha, "background alpha").toBe(1);
    expect(style.backdropFilter, "backdrop-filter").toBe("none");
    const webkitBackdrop = style.getPropertyValue("-webkit-backdrop-filter");
    expect(webkitBackdrop === "" || webkitBackdrop === "none", "webkit backdrop-filter").toBe(true);
    expect(style.willChange, "will-change").toBe("auto");
    expect(px(style.borderTopLeftRadius), "radius").toBe(12);
    expect(px(library.borderTopLeftRadius), "library radius").toBe(12);
    expect(style.borderTopLeftRadius, "radius matches library").toBe(library.borderTopLeftRadius);
    expect(px(style.borderTopWidth), "border width").toBe(1);
    expect(style.borderTopStyle, "border style").toBe("solid");
    expect(style.borderTopColor, "border color").toBe(library.borderTopColor);
    expect(style.backgroundColor, "background").toBe(library.backgroundColor);
    expect(style.boxShadow, "shadow").toBe(library.boxShadow);
    expect(px(style.paddingTop), "padding").toBe(paddingPx);
    expect(px(style.paddingRight), "padding").toBe(paddingPx);
    expect(px(style.paddingBottom), "padding").toBe(paddingPx);
    expect(px(style.paddingLeft), "padding").toBe(paddingPx);
    return style;
  } finally {
    probe.remove();
  }
}

function expectItemMetrics(item: Element, label: string) {
  const style = getComputedStyle(item);
  expect(item.getBoundingClientRect().height, `${label} visual height`).toBe(32);
  expect(style.fontSize, `${label} font size`).toBe("14px");
  expect(style.fontWeight, `${label} font weight`).toBe("400");
  expect(px(style.borderTopLeftRadius), `${label} radius`).toBe(4);
}

function FilterCombobox(props: { onValueChange?: (value: string | null) => void }) {
  const [query, setQuery] = useState("");
  const filtered = FRUITS.filter((item) => item.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Combobox
      items={[...FRUITS]}
      filteredItems={[...filtered]}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(value) => props.onValueChange?.(value)}
    >
      <ComboboxInput aria-label="Pick" />
      <ComboboxPopup>
        <ComboboxEmpty>None</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} disabled={item === "Charlie"} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

function FilterAutocomplete() {
  const [query, setQuery] = useState("");
  const filtered = FRUITS.filter((item) => item.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Autocomplete
      items={[...FRUITS]}
      filteredItems={[...filtered]}
      openOnInputClick
      value={query}
      onValueChange={setQuery}
    >
      <AutocompleteInput aria-label="Find" />
      <AutocompletePopup>
        <AutocompleteEmpty>None</AutocompleteEmpty>
        <AutocompleteList>
          {(item: string) => (
            <AutocompleteItem key={item} disabled={item === "Charlie"} value={item}>
              {item}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  );
}

async function emulateCoarsePointer(): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  const session = cdp();
  const cleanup = async () => {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await page.viewport(previous.width, previous.height);
  };
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
  return { [Symbol.asyncDispose]: cleanup };
}

describe("popup surfaces", () => {
  it("paints popover, combobox, and autocomplete with the library popup", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(390, 844);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };

    {
      await using popoverScreen = await render(
        <Popover>
          <PopoverTrigger>Open popover</PopoverTrigger>
          <PopoverPopup>Popover body</PopoverPopup>
        </Popover>,
      );
      await userEvent.click(popoverScreen.getByRole("button", { name: "Open popover" }));
      const popover = page
        .getByText("Popover body")
        .element()
        .closest<HTMLElement>("[data-slot=popover-popup]")!;
      await expect.element(page.getByText("Popover body")).toBeVisible();
      expectLibrarySurface(popover, "fa-pop fa-pop--pad", 16);
      await page.viewport(1280, 800);
      expect(px(getComputedStyle(popover).borderTopLeftRadius), "popover radius stays 12").toBe(12);
      expect(px(getComputedStyle(popover).paddingTop), "popover padding stays 16").toBe(16);
      await page.viewport(390, 844);
    }

    {
      await using comboboxScreen = await render(<FilterCombobox />);
      await userEvent.click(comboboxScreen.getByRole("combobox", { name: "Pick" }));
      const comboboxItem = page.getByRole("option", { name: "Alpha" });
      await expect.element(comboboxItem).toBeVisible();
      const combobox = comboboxItem.element().closest<HTMLElement>("[data-slot=combobox-popup]")!;
      expectLibrarySurface(combobox, "fa-pop", 8);
      expectItemMetrics(comboboxItem.element(), "narrow combobox item");
      const input = comboboxScreen.getByRole("combobox", { name: "Pick" }).element();
      const inputProbe = surfaceProbe("fa-input");
      try {
        expect(input.classList.contains("fa-input"), "combobox input keeps fa-input").toBe(true);
        expect(input.getBoundingClientRect().height, "combobox input height").toBe(
          inputProbe.getBoundingClientRect().height,
        );
      } finally {
        inputProbe.remove();
      }
      await page.viewport(1280, 800);
      expectItemMetrics(comboboxItem.element(), "wide combobox item");
      await page.viewport(390, 844);
    }

    {
      await using autocompleteScreen = await render(<FilterAutocomplete />);
      await userEvent.click(autocompleteScreen.getByRole("combobox", { name: "Find" }));
      const autocompleteItem = page.getByRole("option", { name: "Alpha" });
      await expect.element(autocompleteItem).toBeVisible();
      const autocomplete = autocompleteItem
        .element()
        .closest<HTMLElement>("[data-slot=autocomplete-popup]")!;
      expectLibrarySurface(autocomplete, "fa-pop", 8);
      expectItemMetrics(autocompleteItem.element(), "narrow autocomplete item");
      await page.viewport(1280, 800);
      expectItemMetrics(autocompleteItem.element(), "wide autocomplete item");
    }
  });

  it("keeps an edge-to-edge popover flush and a panel out of the popup surface", async () => {
    await using _screen = await render(
      <>
        <Popover>
          <PopoverTrigger>Flush</PopoverTrigger>
          <PopoverPopup padding="none">Flush body</PopoverPopup>
        </Popover>
        <Popover>
          <PopoverTrigger>Panel</PopoverTrigger>
          <PopoverPopup variant="panel" padding="none">
            Panel body
          </PopoverPopup>
        </Popover>
      </>,
    );
    await userEvent.click(page.getByRole("button", { name: "Flush" }));
    const flush = page
      .getByText("Flush body")
      .element()
      .closest<HTMLElement>("[data-slot=popover-popup]")!;
    expectLibrarySurface(flush, "fa-pop ade-pop--flush", 0);

    await userEvent.click(page.getByRole("button", { name: "Panel" }));
    const panel = page
      .getByText("Panel body")
      .element()
      .closest<HTMLElement>("[data-slot=popover-popup]")!;
    const panelStyle = getComputedStyle(panel);
    expect(toRgb(panelStyle.backgroundColor)?.alpha ?? 0, "panel background").toBe(0);
    expect(px(panelStyle.borderTopWidth), "panel border").toBe(0);
  });

  it("highlights with the library wash and keeps keyboard behavior", async () => {
    const onValueChange = vi.fn();
    {
      await using comboboxScreen = await render(<FilterCombobox onValueChange={onValueChange} />);
      const comboboxInput = comboboxScreen.getByRole("combobox", { name: "Pick" });
      await userEvent.click(comboboxInput);
      await expect.element(page.getByRole("listbox")).toBeVisible();

      await userEvent.keyboard("b");
      await vi.waitFor(() => {
        expect(page.getByRole("option", { name: "Bravo" }).query()).not.toBeNull();
        expect(page.getByRole("option", { name: "Alpha" }).query()).toBeNull();
      });
      await userEvent.keyboard("{ArrowDown}");

      const highlighted = page.getByRole("option", { name: "Bravo" }).element();
      const wash = surfaceProbe("fa-item");
      wash.setAttribute("data-highlighted", "");
      try {
        expect(highlighted.hasAttribute("data-highlighted"), "typing highlights a match").toBe(
          true,
        );
        expect(getComputedStyle(highlighted).backgroundImage, "neutral highlight").toBe(
          getComputedStyle(wash).backgroundImage,
        );
      } finally {
        wash.remove();
      }

      await userEvent.keyboard("{Enter}");
      expect(onValueChange).toHaveBeenCalledWith("Bravo");
      await userEvent.keyboard("{Escape}");
      await expect.element(comboboxInput).toHaveFocus();

      await userEvent.click(comboboxInput);
      await userEvent.keyboard("{ArrowDown}");
      const first = page.getByRole("option", { name: "Alpha" });
      const second = page.getByRole("option", { name: "Bravo" });
      await vi.waitFor(() => {
        expect(
          first.element().hasAttribute("data-highlighted") ||
            second.element().hasAttribute("data-highlighted"),
        ).toBe(true);
      });
      const before = [first, second].find((item) =>
        item.element().hasAttribute("data-highlighted"),
      )!;
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const after = [first, second].find((item) =>
          item.element().hasAttribute("data-highlighted"),
        );
        expect(after).not.toBe(before);
      });
      await userEvent.keyboard("{Escape}");
      await expect.element(comboboxInput).toHaveFocus();
    }

    await using autocompleteScreen = await render(<FilterAutocomplete />);
    const autocompleteInput = autocompleteScreen.getByRole("combobox", { name: "Find" });
    await userEvent.click(autocompleteInput);
    await expect.element(page.getByRole("option", { name: "Alpha" })).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("c");
    await vi.waitFor(() => {
      expect(page.getByRole("option", { name: "Charlie" }).query()).not.toBeNull();
      expect(page.getByRole("option", { name: "Alpha" }).query()).toBeNull();
    });
    await userEvent.keyboard("{Escape}");
    await expect.element(autocompleteInput).toHaveFocus();
  });

  it("reads popup background and border in default, Grove, and Ember without flattening disabled rows", async () => {
    const root = document.documentElement;
    const readings: string[] = [];
    try {
      await using screen = await render(<FilterCombobox />);
      await userEvent.click(screen.getByRole("combobox", { name: "Pick" }));
      const popup = page
        .getByRole("option", { name: "Alpha" })
        .element()
        .closest<HTMLElement>("[data-slot=combobox-popup]")!;
      const enabled = page.getByRole("option", { name: "Alpha" }).element();
      const disabled = page.getByRole("option", { name: "Charlie" }).element();
      expect(disabled.hasAttribute("data-disabled")).toBe(true);

      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);
          const style = getComputedStyle(popup);
          readings.push(
            `${themeId} ${appearance} background=${style.backgroundColor} border=${style.borderTopColor} borderWidth=${style.borderTopWidth}`,
          );
          expect(toRgb(style.backgroundColor)?.alpha ?? 1, `${themeId} ${appearance} alpha`).toBe(
            1,
          );
          expect(px(style.borderTopWidth), `${themeId} ${appearance} border`).toBe(1);
          const enabledColor = getComputedStyle(enabled).color;
          const disabledColor = getComputedStyle(disabled).color;
          expect(
            disabledColor,
            `${themeId} ${appearance} disabled (${disabledColor}) differs from enabled (${enabledColor})`,
          ).not.toBe(enabledColor);
        }
      }
      expect(readings.join("\n")).toMatchInlineSnapshot(`
        "system light background=rgb(255, 255, 255) border=rgb(226, 226, 230) borderWidth=1px
        system dark background=rgb(39, 39, 43) border=rgb(48, 48, 54) borderWidth=1px
        grove light background=oklch(0.932695 0.003778 160.944) border=oklch(0.864831 0.01312 167.255) borderWidth=1px
        grove dark background=oklch(0.411828 0.014378 166.627) border=oklch(0.457475 0.044046 160.971) borderWidth=1px
        ember light background=oklch(0.936659 0.002879 29.96) border=oklch(0.870631 0.013204 39.431) borderWidth=1px
        ember dark background=oklch(0.401111 0.014308 34.896) border=oklch(0.44099 0.040202 48.807) borderWidth=1px"
      `);
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("keeps popup and row text at 4.5:1 contrast across default, Grove, and Ember in light and dark", async () => {
    const root = document.documentElement;
    try {
      await using screen = await render(<FilterCombobox />);
      await userEvent.click(screen.getByRole("combobox", { name: "Pick" }));
      const enabled = page.getByRole("option", { name: "Alpha" }).element();
      const popup = enabled.closest<HTMLElement>("[data-slot=combobox-popup]")!;
      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);
          const popupStyle = getComputedStyle(popup);
          const label = `${themeId} ${appearance}`;
          expect(
            contrastRatio(popupStyle.color, popupStyle.backgroundColor),
            `${label} popup text (${popupStyle.color} on ${popupStyle.backgroundColor})`,
          ).toBeGreaterThanOrEqual(4.5);
          const rowColor = getComputedStyle(enabled).color;
          expect(
            contrastRatio(rowColor, popupStyle.backgroundColor),
            `${label} row text (${rowColor} on ${popupStyle.backgroundColor})`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("keeps the 32px row when the touch hit area grows", async () => {
    await using _pointer = await emulateCoarsePointer();
    await using screen = await render(<FilterCombobox />);
    await userEvent.click(screen.getByRole("combobox", { name: "Pick" }));
    const item = page.getByRole("option", { name: "Alpha" }).element();
    await expect.element(page.getByRole("option", { name: "Alpha" })).toBeVisible();
    expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
    expect(item.getBoundingClientRect().height, "visual height").toBe(32);
    const hit = getComputedStyle(item, "::after");
    expect(px(hit.height), "touch hit area").toBeGreaterThanOrEqual(44);
  });
});
