import { converter } from "culori/fn";
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../test/render";
import { Button } from "./components/ui/button";
import {
  applyThemePalette,
  EMBER_THEME,
  getStandardPaintedThemeColors,
  getThemeColorsForMode,
  GROVE_THEME,
} from "./themePalette";

const toRgb = converter("rgb");

function paintedChannels(variable: string, canvas: readonly number[] = [0, 0, 0]): number[] {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${variable})`;
  document.body.append(probe);
  try {
    const color = toRgb(getComputedStyle(probe).backgroundColor)!;
    const alpha = color.alpha ?? 1;
    return [color.r, color.g, color.b].map(
      (channel, index) => (channel * alpha + (canvas[index]! / 255) * (1 - alpha)) * 255,
    );
  } finally {
    probe.remove();
  }
}

describe("standard painted theme colors", () => {
  it("match the chip surfaces index.css paints", () => {
    const root = document.documentElement;
    try {
      for (const appearance of ["light", "dark"] as const) {
        // useTheme applies both: .dark for @variant dark, data-theme for --fa-* tokens.
        root.classList.toggle("dark", appearance === "dark");
        root.dataset.theme = appearance;
        const colors = getStandardPaintedThemeColors(appearance);
        const canvas = paintedChannels("--background");
        for (const [variable, role] of [
          ["--background", "canvas"],
          ["--muted", "surface"],
          ["--surface-raised", "surfaceRaised"],
          ["--message-surface", "messageSurface"],
        ] as const) {
          const expected = toRgb(colors[role])!;
          const painted = paintedChannels(variable, canvas);
          [expected.r, expected.g, expected.b].forEach((channel, index) => {
            expect(Math.abs(channel * 255 - painted[index]!), `${appearance} ${role}`).toBeLessThan(
              1.5,
            );
          });
        }
      }
    } finally {
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("paints fleet-design body and primary button colors for the default theme while preserving Grove and Ember", async () => {
    const root = document.documentElement;
    try {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      root.dataset.theme = "light";
      expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(255, 255, 255)");

      await using screen = await render(createElement(Button, null, "Action"));
      expect(getComputedStyle(screen.getByRole("button").element()).backgroundColor).toBe(
        "rgb(44, 91, 216)",
      );

      root.classList.add("dark");
      root.dataset.theme = "dark";
      expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(24, 24, 27)");

      for (const theme of [GROVE_THEME, EMBER_THEME]) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(theme.id, appearance);
          const expected = toRgb(getThemeColorsForMode(theme, appearance)!.chrome)!;
          const actual = toRgb(getComputedStyle(document.body).backgroundColor)!;
          [expected.r, expected.g, expected.b].forEach((channel, index) => {
            const actualChannel = [actual.r, actual.g, actual.b][index]!;
            expect(
              Math.abs(channel * 255 - actualChannel * 255),
              `${theme.id} ${appearance} body`,
            ).toBeLessThan(1.5);
          });
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });
});
