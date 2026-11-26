import { converter, modeOklch, modeRgb, useMode } from "culori/fn";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { openCommandPalette } from "../../commandPaletteBus";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { LAST_USED_PROJECT_STORAGE_KEY } from "../../hooks/useHandleNewThread";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import type { Project, Thread } from "../../types";
import { CommandPalette } from "../CommandPalette";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandInput,
  CommandPanel,
} from "./command";
import { StandalonePage, StandalonePageHeader } from "./standalone-page";

useMode(modeRgb);
useMode(modeOklch);
const toRgb = converter("rgb");

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
}));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  useProjects: () => entities.projects,
  useVisibleThreadShells: () => entities.threads,
}));

function setup() {
  removeLocalStorageItem(LAST_USED_PROJECT_STORAGE_KEY);
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = [];
  entities.threads = [];
}

function paletteShell() {
  const popup = document.querySelector<HTMLElement>('[data-slot="command-dialog-popup"]');
  const inputRow = document.querySelector<HTMLElement>('[data-slot="command-input-row"]');
  const backdrop = document.querySelector<HTMLElement>('[data-slot="command-dialog-backdrop"]');
  const field = inputRow?.querySelector("input");
  if (!popup || !inputRow || !backdrop || !field) {
    throw new Error("command palette shell is missing a part");
  }
  const footer = document.querySelector<HTMLElement>('[data-slot="command-footer"]');
  return { popup, inputRow, footer, backdrop, field };
}

function roleColor(name: "--fa-overlay" | "--fa-border" | "--fa-scrim") {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

describe("command palette shell", () => {
  it("paints an opaque 640px palette, a 48px field and a 32px footer", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette({});

    const dialog = page.getByRole("dialog", { name: "命令面板" });
    await expect.element(dialog).toBeVisible();
    await vi.waitFor(() => {
      expect(getComputedStyle(paletteShell().popup).opacity).toBe("1");
    });

    const { popup, inputRow, footer, backdrop, field } = paletteShell();
    if (!footer) throw new Error("desktop palette footer is missing");
    const popupStyle = getComputedStyle(popup);
    expect(Math.round(popup.getBoundingClientRect().width)).toBe(640);
    expect(popupStyle.borderRadius).toBe("12px");
    expect(popupStyle.borderTopWidth).toBe("1px");
    expect(popupStyle.borderBottomWidth).toBe("1px");
    expect(popupStyle.borderLeftWidth).toBe("1px");
    expect(popupStyle.borderRightWidth).toBe("1px");
    expect(popupStyle.backdropFilter).toBe("none");
    expect(popupStyle.willChange).toBe("auto");
    expect(toRgb(popupStyle.backgroundColor)?.alpha ?? 1).toBe(1);
    expect(getComputedStyle(inputRow).height).toBe("48px");
    expect(getComputedStyle(footer).height).toBe("32px");
    expect(getComputedStyle(footer).fontSize).toBe("12px");

    const fieldStyle = getComputedStyle(field);
    expect(fieldStyle.borderTopWidth).toBe("0px");
    expect(fieldStyle.borderBottomWidth).toBe("0px");
    expect(fieldStyle.outlineStyle).toBe("none");
    expect(fieldStyle.boxShadow).toBe("none");

    const scrim = getComputedStyle(backdrop);
    const scrimAlpha = toRgb(scrim.backgroundColor)?.alpha ?? 1;
    expect(scrim.backdropFilter).toBe("none");
    expect(scrimAlpha).toBeGreaterThan(0);
    expect(scrimAlpha).toBeLessThan(1);

    const row = page.getByRole("option").first().element();
    const heading = popup.querySelector<HTMLElement>('[data-slot="command-group-label"]');
    const list = popup.querySelector<HTMLElement>('[data-slot="command-list"]');
    expect(heading, "group heading").not.toBeNull();
    expect(list, "virtualised list").not.toBeNull();
    // Result rows are library rows now: the 14px title is the row's first line.
    // The headings and the virtualised list keep their computed height and font size.
    expect(row.getBoundingClientRect().height).toBe(32);
    expect(getComputedStyle(row.querySelector(".l1")!).fontSize).toBe("14px");
    expect(heading!.getBoundingClientRect().height).toBe(28);
    expect(getComputedStyle(heading!).fontSize).toBe("12px");
    expect(list!.getBoundingClientRect().height).toBe(448);
    expect(getComputedStyle(list!).fontSize).toBe("16px");
  });

  it("is full width inside the viewport margin at 390", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(390, 844);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette({});
    await expect.element(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();

    await vi.waitFor(() => {
      expect(getComputedStyle(paletteShell().popup).opacity).toBe("1");
    });
    const { popup, inputRow } = paletteShell();
    const frame = popup.parentElement;
    if (!frame) throw new Error("palette viewport is missing");
    const margin = parseFloat(getComputedStyle(frame).paddingLeft);
    const box = popup.getBoundingClientRect();
    expect(margin).toBeGreaterThan(0);
    expect(box.left).toBeCloseTo(margin, 0);
    expect(box.width).toBeCloseTo(390 - margin * 2, 0);
    expect(getComputedStyle(inputRow).height).toBe("48px");
    expect(getComputedStyle(popup).borderRadius).toBe("12px");
    expect(getComputedStyle(popup).backdropFilter).toBe("none");
  });

  it("reads overlay and border from the default, Grove and Ember themes", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 800);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    openCommandPalette({});
    await expect.element(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
    const root = document.documentElement;
    try {
      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(themeId, appearance);
          const { popup } = paletteShell();
          const style = getComputedStyle(popup);
          const label = `${themeId} ${appearance}`;
          expect(style.backgroundColor, label).toBe(roleColor("--fa-overlay"));
          expect(style.borderTopColor, label).toBe(roleColor("--fa-border"));
          expect(toRgb(style.backgroundColor)?.alpha ?? 1, label).toBe(1);
          expect(style.borderTopWidth, label).toBe("1px");
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });
});

describe("command palette shell in a fixed-height popup", () => {
  it("keeps the input row at 48px and the footer at 32px when the list overflows", async () => {
    await using _screen = await render(
      <CommandDialog open>
        <CommandDialogPopup aria-label="固定高度" className="h-64">
          <Command>
            <CommandInput placeholder="搜索" />
            <CommandPanel>
              <div style={{ height: 2000 }} />
            </CommandPanel>
            <CommandFooter>底部</CommandFooter>
          </Command>
        </CommandDialogPopup>
      </CommandDialog>,
    );
    await expect.element(page.getByRole("dialog", { name: "固定高度" })).toBeVisible();
    const { inputRow, footer } = paletteShell();
    if (!footer) throw new Error("footer is missing");
    expect(inputRow.getBoundingClientRect().height).toBe(48);
    expect(footer.getBoundingClientRect().height).toBe(32);
  });
});

describe("standalone page surface", () => {
  it("uses the solid dialog surface", async () => {
    await using _screen = await render(
      <StandalonePage>
        <StandalonePageHeader title="配对" description="把这台机器连上" />
      </StandalonePage>,
    );
    const card = document.querySelector("section");
    if (!card) throw new Error("standalone card is missing");
    const style = getComputedStyle(card);
    expect(style.borderRadius).toBe("12px");
    expect(style.borderTopWidth).toBe("1px");
    expect(style.backdropFilter).toBe("none");
    expect(style.willChange).toBe("auto");
    expect(toRgb(style.backgroundColor)?.alpha ?? 1).toBe(1);
    expect(style.backgroundColor).toBe(roleColor("--fa-overlay"));
  });
});
