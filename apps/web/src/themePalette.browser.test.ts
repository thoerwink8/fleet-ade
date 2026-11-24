import { converter } from "culori/fn";
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../test/render";
import { Badge } from "./components/ui/badge";
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

function contrastRatio(first: string, second: string): number {
  const luminance = (value: string) => {
    const rgb = toRgb(value)!;
    return [rgb.r, rgb.g, rgb.b]
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  };
  const firstL = luminance(first);
  const secondL = luminance(second);
  return (Math.max(firstL, secondL) + 0.05) / (Math.min(firstL, secondL) + 0.05);
}

function resolvedCssVariable(variable: string): string {
  const probe = document.createElement("div");
  probe.style.color = `var(${variable})`;
  document.body.append(probe);
  try {
    return getComputedStyle(probe).color;
  } finally {
    probe.remove();
  }
}

function expectCloseColor(actualValue: string, expectedValue: string, label: string) {
  const expected = toRgb(expectedValue)!;
  const actual = toRgb(actualValue)!;
  expect(actual.alpha ?? 1, `${label} alpha`).toBeCloseTo(expected.alpha ?? 1, 2);
  [expected.r, expected.g, expected.b].forEach((channel, index) => {
    const actualChannel = [actual.r, actual.g, actual.b][index]!;
    expect(Math.abs(channel * 255 - actualChannel * 255), `${label} ch${index}`).toBeLessThan(1.5);
  });
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
      expectCloseColor(
        getComputedStyle(document.body).color,
        resolvedCssVariable("--fa-fg"),
        "light body color == --fa-fg",
      );
      expect(
        contrastRatio(
          getComputedStyle(document.body).color,
          getComputedStyle(document.body).backgroundColor,
        ),
        "light body contrast",
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(
          resolvedCssVariable("--muted-foreground"),
          getComputedStyle(document.body).backgroundColor,
        ),
        "light muted-foreground contrast",
      ).toBeGreaterThanOrEqual(4.5);

      await using screen = await render(createElement(Button, null, "Action"));
      expect(getComputedStyle(screen.getByRole("button").element()).backgroundColor).toBe(
        "rgb(44, 91, 216)",
      );

      root.classList.add("dark");
      root.dataset.theme = "dark";
      expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(24, 24, 27)");
      expectCloseColor(
        getComputedStyle(document.body).color,
        resolvedCssVariable("--fa-fg"),
        "dark body color == --fa-fg",
      );
      expect(
        contrastRatio(
          getComputedStyle(document.body).color,
          getComputedStyle(document.body).backgroundColor,
        ),
        "dark body contrast",
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(
          resolvedCssVariable("--muted-foreground"),
          getComputedStyle(document.body).backgroundColor,
        ),
        "dark muted-foreground contrast",
      ).toBeGreaterThanOrEqual(4.5);

      for (const theme of [GROVE_THEME, EMBER_THEME]) {
        for (const appearance of ["light", "dark"] as const) {
          root.classList.toggle("dark", appearance === "dark");
          root.dataset.theme = appearance;
          applyThemePalette(theme.id, appearance);
          const colors = getThemeColorsForMode(theme, appearance)!;
          expectCloseColor(
            getComputedStyle(document.body).backgroundColor,
            colors.chrome,
            `${theme.id} ${appearance} body`,
          );
          const expectedVariables: ReadonlyArray<readonly [string, string]> = [
            ["--background", colors.canvas],
            ["--foreground", colors.text],
            ["--primary", colors.messageAction],
            ["--accent", colors.accentSurface],
            ["--border", colors.border],
            // Success and info stay un-themed (pre-bridge Tailwind defaults) in Grove and Ember.
            ["--info", "oklch(0.623 0.214 259.815)"],
            ["--success", "oklch(0.696 0.17 162.48)"],
            ["--warning", colors.warning],
            [
              "--info-foreground",
              appearance === "dark" ? "oklch(0.707 0.165 254.624)" : "oklch(0.488 0.243 264.376)",
            ],
            [
              "--success-foreground",
              appearance === "dark" ? "oklch(0.765 0.177 163.223)" : "oklch(0.508 0.118 165.612)",
            ],
            ["--error", colors.error],
            ["--fa-bg", colors.canvas],
            ["--fa-panel", colors.surface],
            ["--fa-overlay", colors.surfaceOverlay],
            ["--fa-fg", colors.text],
            ["--fa-fg-muted", colors.mutedForeground],
            ["--fa-border", colors.border],
            ["--fa-accent", colors.messageAction],
            ["--fa-on-accent", colors.messageActionForeground],
            ["--fa-danger", colors.error],
            ["--fa-focus-ring", colors.focus],
          ];
          for (const [variable, expectedColor] of expectedVariables) {
            expectCloseColor(
              resolvedCssVariable(variable),
              expectedColor,
              `${theme.id} ${appearance} ${variable}`,
            );
          }
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });

  it("keeps at least 4.5:1 contrast on destructive Button and Badge in light and dark default themes", async () => {
    const root = document.documentElement;
    try {
      applyThemePalette("system", "light");
      await using screen = await render(
        createElement(
          "div",
          null,
          createElement(Button, { variant: "destructive" }, "Delete"),
          createElement(Badge, { variant: "destructive" }, "Danger"),
        ),
      );
      const buttonEl = screen.getByRole("button").element();
      const badgeEl = screen.getByText("Danger").element();
      for (const appearance of ["light", "dark"] as const) {
        root.classList.toggle("dark", appearance === "dark");
        root.dataset.theme = appearance;
        const buttonStyle = getComputedStyle(buttonEl);
        const badgeStyle = getComputedStyle(badgeEl);
        const badgeSurface =
          badgeStyle.backgroundColor === "rgba(0, 0, 0, 0)"
            ? getComputedStyle(document.body).backgroundColor
            : badgeStyle.backgroundColor;
        expect(
          contrastRatio(buttonStyle.color, buttonStyle.backgroundColor),
          `${appearance} destructive Button (${buttonStyle.color} on ${buttonStyle.backgroundColor})`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(badgeStyle.color, badgeSurface),
          `${appearance} destructive Badge (${badgeStyle.color} on ${badgeSurface})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });
});
