import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { LegendListRef } from "@legendapp/list/react";
import { converter } from "culori/fn";
import { useState, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../themePalette";
import {
  buildCommandPaletteRows,
  commandPaletteItemLineCount,
  commandPaletteRowMetric,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  CommandPaletteResults,
  CommandPaletteVirtualizedResults,
  commandPaletteFixedRowSize,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { CommandDialog, CommandDialogPopup, CommandItem, CommandList } from "./ui/command";

const toRgb = converter("rgb");

function luminance(color: string) {
  const rgb = toRgb(color);
  if (!rgb) throw new Error(color);
  const linear = (channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

function contrastRatio(foreground: string, background: string) {
  const sorted = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (sorted[0]! + 0.05) / (sorted[1]! + 0.05);
}

function flatten(color: string, over: string) {
  const fg = toRgb(color);
  const bg = toRgb(over);
  if (!fg || !bg) throw new Error(`${color} over ${over}`);
  const alpha = fg.alpha ?? 1;
  const mix = (channel: number, base: number) =>
    Math.round((channel * alpha + base * (1 - alpha)) * 255);
  return `rgb(${mix(fg.r, bg.r)} ${mix(fg.g, bg.g)} ${mix(fg.b, bg.b)})`;
}

function opaqueBackground(start: HTMLElement | null) {
  let node = start;
  while (node) {
    const color = getComputedStyle(node).backgroundColor;
    const rgb = toRgb(color);
    if (rgb && (rgb.alpha ?? 1) > 0.99) return color;
    node = node.parentElement;
  }
  return "rgb(255 255 255)";
}

function paintedBackground(element: Element) {
  const style = getComputedStyle(element);
  const own = toRgb(style.backgroundColor);
  let color = opaqueBackground(element.parentElement);
  if (own && (own.alpha ?? 0) > 0) color = flatten(style.backgroundColor, color);
  if (style.backgroundImage !== "none") {
    const hover = style.getPropertyValue("--fa-hover").trim();
    if (hover) color = flatten(hover, color);
  }
  return color;
}

function pxVar(name: string) {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
  if (!Number.isFinite(value)) throw new Error(name);
  return value;
}

function weightAtMost500(element: Element) {
  const weight = getComputedStyle(element).fontWeight;
  const numeric = weight === "normal" ? 400 : Number.parseInt(weight, 10);
  expect(numeric).toBeLessThanOrEqual(500);
}

function action(
  value: string,
  title: string,
  extra: Partial<CommandPaletteActionItem> = {},
): CommandPaletteActionItem {
  return {
    kind: "action",
    value,
    title,
    searchTerms: [title],
    icon: <span className="size-4" />,
    run: async () => {},
    ...extra,
  };
}

function Groups(props: {
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlighted: string | null;
  onHighlighted?: (value: string | null) => void;
  onExecute?: (value: string) => void;
}) {
  const values = props.groups.flatMap((group) =>
    group.items.filter((item) => !item.disabled).map((item) => item.value),
  );
  return (
    <CommandDialog open onOpenChange={() => {}}>
      <CommandDialogPopup aria-label="命令面板">
        <CommandPaletteContent
          aria-label="命令面板"
          autoHighlight={props.highlighted ? "always" : false}
          items={values}
          inputProps={{ placeholder: "搜索" }}
          mode="none"
          onItemHighlighted={(value) => {
            props.onHighlighted?.(typeof value === "string" ? value : null);
          }}
          value=""
        >
          <CommandPaletteResults
            groups={props.groups}
            highlightedItemValue={props.highlighted}
            isActionsOnly={false}
            keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
            onExecuteItem={(item) => {
              props.onExecute?.(item.value);
            }}
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

const stateGroups: ReadonlyArray<CommandPaletteGroup> = [
  {
    value: "commands",
    label: "命令",
    items: [
      action("one", "One line command", {
        shortcutCommand: "commandPalette.toggle",
      }),
      action("checked", "Checked command", { checked: true, description: "已打开" }),
      action("two", "Two line command", { description: "第二行说明" }),
      action("long", "X".repeat(180)),
      action("disabled", "Disabled command", {
        disabled: true,
        disabledReason: "还不能用",
        description: "不可用原因",
      }),
    ],
  },
];

describe("command palette rows", () => {
  it("uses the library row height, 14/12 type, and truncates a long title at both widths", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using _screen = await render(<Groups groups={stateGroups} highlighted="one" />);

    const one = () => page.getByRole("option", { name: /One line command/ }).element();
    const two = () => page.getByRole("option", { name: /Two line command/ }).element();
    const long = () => page.getByRole("option", { name: /X{20}/ }).element();
    const heading = () => page.getByText("命令", { exact: true }).element();

    for (const [width, height] of [
      [1280, 800],
      [390, 844],
    ] as const) {
      await page.viewport(width, height);
      const row1 = pxVar("--fa-row-1");
      const row2 = pxVar("--fa-row-2");
      expect(row2, "library two-line row").toBe(52);
      expect(one().getBoundingClientRect().height, `${width} one-line`).toBe(row1);
      expect(two().getBoundingClientRect().height, `${width} two-line`).toBe(row2);
      expect(long().getBoundingClientRect().height, `${width} truncated title stays one line`).toBe(
        row1,
      );

      const title = one().querySelector(".l1")!;
      const second = two().querySelector(".l2")!;
      expect(getComputedStyle(title).fontSize).toBe("14px");
      expect(getComputedStyle(second).fontSize).toBe("12px");
      weightAtMost500(title);
      weightAtMost500(second);
      if (width >= 640) {
        const shortcut = one().querySelector("[data-slot=command-shortcut]");
        expect(shortcut, "desktop shortcut hint").not.toBeNull();
        expect(getComputedStyle(shortcut!).fontSize).toBe("12px");
        weightAtMost500(shortcut!);
      } else {
        await vi.waitFor(() => {
          expect(
            one().querySelector("[data-slot=command-shortcut]"),
            "narrow viewports hide keyboard hints",
          ).toBeNull();
        });
      }
      expect(getComputedStyle(heading()).fontSize).toBe("12px");
      weightAtMost500(heading());

      const titleText = long().querySelector(".x")!;
      const titleStyle = getComputedStyle(titleText);
      expect(titleStyle.whiteSpace).toBe("nowrap");
      expect(titleStyle.textOverflow).toBe("ellipsis");
      expect(titleText.scrollWidth).toBeGreaterThan(titleText.clientWidth);
    }
  });

  it("paints highlight, checked, and disabled as three different states and skips disabled keys", async () => {
    const ran: string[] = [];
    function Harness() {
      const [highlighted, setHighlighted] = useState<string | null>("one");
      return (
        <Groups
          groups={stateGroups}
          highlighted={highlighted}
          onHighlighted={setHighlighted}
          onExecute={(value) => {
            ran.push(value);
          }}
        />
      );
    }
    await using _screen = await render(<Harness />);

    const one = page.getByRole("option", { name: /One line command/ }).element();
    const checked = page.getByRole("option", { name: /Checked command/ }).element();
    const plain = page.getByRole("option", { name: /Two line command/ }).element();
    const disabled = page.getByRole("button", { name: /Disabled command/ }).element();

    expect(one.hasAttribute("data-highlighted") || one.hasAttribute("data-palette-active")).toBe(
      true,
    );
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(getComputedStyle(disabled).opacity).toBe("1");

    const highlightImage = getComputedStyle(one).backgroundImage;
    await userEvent.hover(plain);
    expect(getComputedStyle(plain).backgroundImage).toBe(highlightImage);
    expect(getComputedStyle(checked).backgroundColor).not.toBe(
      getComputedStyle(one).backgroundColor,
    );
    expect(getComputedStyle(disabled).backgroundImage).toBe("none");
    expect(getComputedStyle(disabled).color).not.toBe(getComputedStyle(one).color);

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(disabled.hasAttribute("data-highlighted")).toBe(false);
    expect(ran).not.toContain("disabled");
    expect(ran).toHaveLength(1);
  });

  it("keeps the title on its line when a caller adds a control taller than the line", async () => {
    const groups: ReadonlyArray<CommandPaletteGroup> = [
      {
        value: "tall",
        label: "命令",
        items: [
          action("tall", "Tall trailing control", {
            description: "第二行说明",
            titleTrailingContent: <span data-testid="tall-control" style={{ height: 32 }} />,
          }),
        ],
      },
    ];
    await using _screen = await render(<Groups groups={groups} highlighted={null} />);
    const row = page.getByRole("option", { name: /Tall trailing control/ }).element();
    const line = row.querySelector<HTMLElement>(".l1")!;
    const title = line.querySelector<HTMLElement>(".x")!;
    const second = row.querySelector<HTMLElement>(".l2")!;
    expect(title.getBoundingClientRect().top).toBeCloseTo(line.getBoundingClientRect().top, 1);
    expect(second.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      line.getBoundingClientRect().bottom - 0.5,
    );
  });

  it("tints one row when the pointer rests on a row the keyboard has left", async () => {
    function Harness() {
      const [highlighted, setHighlighted] = useState<string | null>("one");
      return (
        <Groups groups={stateGroups} highlighted={highlighted} onHighlighted={setHighlighted} />
      );
    }
    await using _screen = await render(<Harness />);
    const plain = page.getByRole("option", { name: /Two line command/ }).element();
    await userEvent.hover(plain);
    await userEvent.keyboard("{ArrowUp}");
    expect(plain.matches(":hover")).toBe(true);
    expect(getComputedStyle(plain).backgroundImage, "resting pointer").toBe("none");
    const tinted = [...document.querySelectorAll<HTMLElement>(".fa-cmd__row")].filter(
      (row) => getComputedStyle(row).backgroundImage !== "none",
    );
    expect(tinted).toHaveLength(1);
  });

  it("keeps highlighted text at 4.5:1 and does not restyle disabled rows across themes", async () => {
    const root = document.documentElement;
    try {
      await using _screen = await render(<Groups groups={stateGroups} highlighted="one" />);
      const one = page.getByRole("option", { name: /One line command/ }).element();
      const disabled = page.getByRole("button", { name: /Disabled command/ }).element();
      const readings: string[] = [];
      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);
          const title = one.querySelector(".l1")!;
          const background = paintedBackground(one);
          const ratio = contrastRatio(getComputedStyle(title).color, background);
          readings.push(
            `${themeId} ${appearance} ${getComputedStyle(title).color} on ${background} ${ratio.toFixed(2)}`,
          );
          expect(ratio, readings.at(-1)).toBeGreaterThanOrEqual(4.5);
          expect(getComputedStyle(disabled).opacity, `${themeId} ${appearance} opacity`).toBe("1");
          expect(getComputedStyle(disabled).backgroundImage, `${themeId} ${appearance} fill`).toBe(
            "none",
          );
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("stretches the coarse hit area to 44px without changing the visible height", async () => {
    await using _pointer = await emulateCoarsePointer();
    await using _screen = await render(<Groups groups={stateGroups} highlighted="one" />);
    const one = page.getByRole("option", { name: /One line command/ }).element();
    const two = page.getByRole("option", { name: /Two line command/ }).element();
    expect(one.getBoundingClientRect().height).toBe(pxVar("--fa-row-1"));
    expect(two.getBoundingClientRect().height).toBe(pxVar("--fa-row-2"));
    expect(Number.parseFloat(getComputedStyle(one, "::after").height)).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(getComputedStyle(two, "::after").height)).toBeGreaterThanOrEqual(44);
  });

  it("locks virtual row heights to the rendered height and keeps a far highlight in view", async () => {
    const count = 500;
    const items = Array.from({ length: count }, (_, index) =>
      action(
        `row-${index}`,
        index % 2 === 1 ? `Two ${index}` : `One ${index}`,
        index % 2 === 1 ? { description: "second line" } : {},
      ),
    );
    const groups: ReadonlyArray<CommandPaletteGroup> = [{ value: "rows", label: "", items }];
    const built = buildCommandPaletteRows(groups);
    const listRef = { current: null } as RefObject<LegendListRef | null>;

    function Harness() {
      const [highlighted, setHighlighted] = useState<string | null>("row-0");
      return (
        <CommandDialog open onOpenChange={() => {}}>
          <CommandDialogPopup aria-label="命令面板">
            <CommandPaletteContent
              aria-label="命令面板"
              autoHighlight="always"
              items={built.itemValues}
              inputProps={{ placeholder: "搜索" }}
              mode="none"
              onItemHighlighted={(value, details) => {
                const next = typeof value === "string" ? value : null;
                setHighlighted(next);
                const rowIndex = built.rowIndexByItemIndex[details.index];
                if (details.reason === "keyboard" && rowIndex !== undefined) {
                  scrollCommandPaletteRowIntoView(listRef.current, rowIndex, details.index === 0);
                }
              }}
              value=""
              virtualized
            >
              <CommandPaletteVirtualizedResults
                rows={built.rows}
                listRef={listRef}
                highlightedItemValue={highlighted}
                isActionsOnly={false}
                keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
                onExecuteItem={() => {}}
              />
            </CommandPaletteContent>
          </CommandDialogPopup>
        </CommandDialog>
      );
    }

    await using _screen = await render(<Harness />);
    await expect.element(page.getByRole("option", { name: "One 0" })).toBeVisible();
    const first = page.getByRole("option", { name: "One 0" }).element();
    const second = page.getByRole("option", { name: "Two 1 second line", exact: true }).element();
    expect(first.getBoundingClientRect().height).toBe(
      commandPaletteFixedRowSize(commandPaletteRowMetric(built.rows[0]!)),
    );
    expect(second.getBoundingClientRect().height).toBe(commandPaletteFixedRowSize("item-2"));
    expect(commandPaletteItemLineCount(items[0]!)).toBe(1);
    expect(commandPaletteItemLineCount(items[1]!)).toBe(2);

    await vi.waitFor(() => expect(listRef.current).toBeTruthy());
    const target = 420;
    scrollCommandPaletteRowIntoView(listRef.current, built.rowIndexByItemIndex[target]!, false);
    const far = page.getByRole("option", { name: `One ${target}`, exact: true });
    await expect.element(far).toBeVisible();
    const scrollElement = findScroller(far.element());
    const rowRect = far.element().getBoundingClientRect();
    const scrollRect = scrollElement.getBoundingClientRect();
    expect(rowRect.top).toBeGreaterThanOrEqual(scrollRect.top - 1);
    expect(rowRect.bottom).toBeLessThanOrEqual(scrollRect.bottom + 1);

    const sizes = items.map((item) =>
      commandPaletteFixedRowSize(commandPaletteItemLineCount(item) === 2 ? "item-2" : "item-1")!,
    );
    const expected = 8 + sizes.slice(0, target).reduce((sum, size) => sum + size, 0);
    const actual = rowRect.top - scrollRect.top + scrollElement.scrollTop;
    expect(Math.abs(actual - expected), `row offset ${actual} vs ${expected}`).toBeLessThan(1.5);
  });

  it("leaves composer menu rows on the previous metrics", async () => {
    await using _screen = await render(
      <CommandDialog open onOpenChange={() => {}}>
        <CommandDialogPopup aria-label="命令面板">
          <CommandPaletteContent
            items={["palette", "slash"]}
            inputProps={{ placeholder: "搜索" }}
            mode="none"
            value=""
          >
            <CommandList>
              <CommandItem value="palette">Palette row</CommandItem>
              <CommandItem data-composer-item-id="slash" value="slash">
                Slash row
              </CommandItem>
            </CommandList>
          </CommandPaletteContent>
        </CommandDialogPopup>
      </CommandDialog>,
    );
    const palette = page.getByRole("option", { name: "Palette row" }).element();
    const slash = page.getByRole("option", { name: "Slash row" }).element();
    expect(palette.className).toContain("fa-cmd__row");
    expect(slash.className).not.toContain("fa-cmd__row");
    expect(slash.className).toContain("min-h-8");
  });
});

function findScroller(node: Element) {
  let current: Element | null = node.parentElement;
  while (current) {
    if (current instanceof HTMLElement && current.scrollHeight > current.clientHeight + 1) {
      return current;
    }
    current = current.parentElement;
  }
  throw new Error("no scroller");
}

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
