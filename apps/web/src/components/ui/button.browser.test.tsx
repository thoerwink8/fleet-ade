import { PlusIcon } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import {
  applyThemePalette,
  EMBER_THEME,
  getThemeColorsForMode,
  GROVE_THEME,
} from "../../themePalette";
import { Button, type ButtonSize } from "./button";

const SIZE_GROUPS = [
  ["--fa-ctrl", ["default", "multiline", "icon"]],
  [
    "--fa-ctrl-sm",
    ["sm", "action", "compact", "sm-pill", "sm-multiline", "icon-sm", "icon-sm-pill"],
  ],
  ["--fa-ctrl-xs", ["xs", "micro", "icon-xs", "icon-micro", "icon-tiny"]],
  ["--fa-ctrl-lg", ["lg", "xl", "icon-lg", "icon-xl"]],
] as const satisfies ReadonlyArray<readonly [string, ReadonlyArray<ButtonSize>]>;

function resolveStyle(prop: "height" | "backgroundColor", value: string): string {
  const probe = document.createElement("div");
  probe.style[prop] = value;
  document.body.append(probe);
  try {
    return getComputedStyle(probe)[prop];
  } finally {
    probe.remove();
  }
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

describe("Button", () => {
  it("maps every size to fleet-design's four control heights at uniform font size across viewports", async () => {
    const prev = { width: window.innerWidth, height: window.innerHeight };
    try {
      for (const [width, height] of [
        [1280, 800],
        [390, 844],
      ] as const) {
        await page.viewport(width, height);
        await using screen = await render(
          <div className="flex flex-wrap items-center gap-2 p-4">
            {SIZE_GROUPS.flatMap(([, sizes]) =>
              sizes.map((size) => (
                <Button key={size} size={size} aria-label={size}>
                  {size.startsWith("icon") ? <PlusIcon /> : size}
                </Button>
              )),
            )}
          </div>,
        );
        const baseFont = getComputedStyle(
          screen.getByRole("button", { name: "default" }).element(),
        ).fontSize;
        for (const [token, sizes] of SIZE_GROUPS) {
          const expected = resolveStyle("height", `var(${token})`);
          for (const size of sizes) {
            const style = getComputedStyle(screen.getByRole("button", { name: size }).element());
            expect(style.fontSize, `${width}px ${size} fontSize`).toBe(baseFont);
            if (size.endsWith("multiline")) {
              expect(style.minHeight, `${width}px ${size} minHeight`).toBe(expected);
              expect(style.whiteSpace, `${width}px ${size} whiteSpace`).toBe("normal");
              // One line of text must still land exactly on the control height.
              expect(style.height, `${width}px ${size} single-line height`).toBe(expected);
            } else {
              expect(style.height, `${width}px ${size} height`).toBe(expected);
            }
            if (size.startsWith("icon")) {
              expect(style.width, `${width}px ${size} width`).toBe(expected);
            }
          }
        }
      }
    } finally {
      await page.viewport(prev.width, prev.height);
    }
  });

  it("keeps expanded/pressed fill, neutral outline/solid glass, and excludes theme accent from disabled targets", async () => {
    const root = document.documentElement;
    try {
      await using screen = await render(
        <div className="flex flex-wrap gap-2 p-4">
          <Button>Enabled Primary</Button>
          <Button disabled>Disabled Primary</Button>
          <Button render={<a href="#disabled" />} aria-disabled="true" variant="outline">
            Disabled Link
          </Button>
          <Button variant="ghost" aria-expanded="true">
            Expanded Trigger
          </Button>
          <Button variant="ghost-muted" aria-pressed="true">
            Pressed Toggle
          </Button>
          <Button variant="outline">Neutral Outline</Button>
          <Button variant="glass">Solid Glass</Button>
          <div data-chat-header="">
            <Button variant="outline">Header Enabled</Button>
            <Button variant="outline" disabled>
              Header Disabled
            </Button>
          </div>
        </div>,
      );
      const btn = (name: string) => screen.getByRole("button", { name }).element();
      const disabledLink = screen.container.querySelector('a[data-slot="button"]')!;
      const outlineStyle = getComputedStyle(btn("Neutral Outline"));
      const glassStyle = getComputedStyle(btn("Solid Glass"));

      expect(getComputedStyle(btn("Expanded Trigger")).backgroundImage).toContain(
        "linear-gradient(",
      );
      expect(getComputedStyle(btn("Pressed Toggle")).backgroundImage).toContain("linear-gradient(");
      expect(outlineStyle.borderTopColor).toBe("rgba(0, 0, 0, 0)");
      expect(outlineStyle.backgroundImage).not.toBe("none");
      expect(glassStyle.backdropFilter).toBe("none");
      expect(glassStyle.backgroundColor).toBe(resolveStyle("backgroundColor", "var(--fa-overlay)"));
      expect(glassStyle.borderTopColor).toBe(resolveStyle("backgroundColor", "var(--fa-border)"));

      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const mode of ["light", "dark"] as const) {
          root.classList.toggle("dark", mode === "dark");
          root.dataset.theme = mode;
          applyThemePalette(themeId, mode);
          const enabledBg = getComputedStyle(btn("Enabled Primary")).backgroundColor;
          if (themeId !== "system") {
            const theme = themeId === GROVE_THEME.id ? GROVE_THEME : EMBER_THEME;
            expect(enabledBg).toBe(
              resolveStyle("backgroundColor", getThemeColorsForMode(theme, mode)!.messageAction),
            );
          }
          expect(getComputedStyle(btn("Disabled Primary")).backgroundColor).not.toBe(enabledBg);
          expect(getComputedStyle(btn("Disabled Primary")).backgroundColor).toBe(
            "rgba(0, 0, 0, 0)",
          );
          // The Grove/Ember toolbar fill in the chat header must not reach a disabled button.
          if (themeId !== "system") {
            expect(getComputedStyle(btn("Header Disabled")).backgroundColor).toBe(
              "rgba(0, 0, 0, 0)",
            );
            expect(getComputedStyle(btn("Header Enabled")).backgroundColor).not.toBe(
              "rgba(0, 0, 0, 0)",
            );
          }
          expect(getComputedStyle(disabledLink).backgroundColor).toBe("rgba(0, 0, 0, 0)");
          expect(getComputedStyle(disabledLink).cursor).toBe("not-allowed");
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("expands pointer-coarse hit targets to 44px via ::after while keeping visual box and compact override", async () => {
    await using _pointer = await emulateCoarsePointer();
    await using screen = await render(
      <div className="flex items-center gap-12 p-12">
        <Button size="icon-micro" aria-label="Touch Micro">
          <PlusIcon />
        </Button>
        <Button size="icon-micro" touchTarget="compact" aria-label="Touch Compact">
          <PlusIcon />
        </Button>
      </div>,
    );
    await vi.waitFor(() => expect(window.matchMedia("(pointer: coarse)").matches).toBe(true));

    const microEl = screen.getByRole("button", { name: "Touch Micro" }).element();
    const compactEl = screen.getByRole("button", { name: "Touch Compact" }).element();
    const microRect = microEl.getBoundingClientRect();
    const xsPx = Number.parseFloat(resolveStyle("height", "var(--fa-ctrl-xs)"));
    const ctrlPx = Number.parseFloat(resolveStyle("height", "var(--fa-ctrl)"));

    expect(Math.round(microRect.height)).toBe(xsPx);
    expect(Number.parseFloat(getComputedStyle(microEl, "::after").minWidth)).toBe(44);
    expect(Number.parseFloat(getComputedStyle(microEl, "::after").minHeight)).toBe(44);
    expect(document.elementFromPoint(microRect.left + microRect.width / 2, microRect.top - 4)).toBe(
      microEl,
    );
    expect(Math.round(compactEl.getBoundingClientRect().height)).toBe(ctrlPx);
    expect(Number.parseFloat(getComputedStyle(compactEl, "::after").minHeight)).toBe(ctrlPx);
  });
});
