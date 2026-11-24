import { converter } from "culori/fn";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { ToastProvider, toastManager } from "./toast";

const toRgb = converter("rgb");

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

// Fades a translucent foreground (element opacity < 1) onto the opaque surface behind it.
function blendedOnSurface(foreground: string, background: string, alpha: number): string {
  const fg = toRgb(foreground)!;
  const bg = toRgb(background)!;
  const channel = (value: number) => Math.round(value * 255);
  const blend = (key: "r" | "g" | "b") => channel(fg[key] * alpha + bg[key] * (1 - alpha));
  return `rgb(${blend("r")}, ${blend("g")}, ${blend("b")})`;
}

describe("toastManager", () => {
  it("shows a toast added before any provider mounted", async () => {
    toastManager.add({ type: "info", title: "Raised before the first render" });

    await using _screen = await render(<ToastProvider>{null}</ToastProvider>);

    await expect.element(page.getByText("Raised before the first render")).toBeVisible();
  });

  it("auto-dismisses an actionless toast after 4s and one with an action after 8s", async () => {
    await using _screen = await render(<ToastProvider>{null}</ToastProvider>);
    using _timers = fakeTimers();

    await act(() => {
      toastManager.add({ type: "info", title: "quiet toast" });
      toastManager.add({
        type: "info",
        title: "action toast",
        actionProps: { children: "重试", onClick: () => {} },
      });
    });
    const quiet = page.getByRole("dialog", { name: "quiet toast" });
    const withAction = page.getByRole("dialog", { name: "action toast" });
    await expect.element(quiet).toBeInTheDocument();
    await expect.element(withAction).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(3_999));
    await expect.element(quiet).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(1));
    await expect.element(quiet).not.toBeInTheDocument();
    await expect.element(withAction).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(3_999));
    await expect.element(withAction).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(1));
    await expect.element(withAction).not.toBeInTheDocument();
  });

  it("keeps at most 3 toasts in the visible stack", async () => {
    await using _screen = await render(<ToastProvider>{null}</ToastProvider>);

    await act(() => {
      for (const title of ["one", "two", "three", "four"]) {
        toastManager.add({ type: "info", title, timeout: 0 });
      }
    });

    await vi.waitFor(() => {
      const toasts = document.querySelectorAll<HTMLElement>(
        '[data-slot="toast-viewport"] > [role="dialog"]',
      );
      expect(toasts).toHaveLength(4);
      const limited = [...toasts].filter((toast) => toast.hasAttribute("data-limited"));
      expect(limited).toHaveLength(1);
    });
  });

  it("pauses auto-dismiss while a toast is hovered", async () => {
    await using _screen = await render(<ToastProvider>{null}</ToastProvider>);
    using _timers = fakeTimers();

    await act(() => {
      toastManager.add({ type: "info", title: "hovered toast" });
    });
    const toast = page.getByRole("dialog", { name: "hovered toast" });
    await expect.element(toast).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(2_000));
    await userEvent.hover(toast);
    await act(() => vi.advanceTimersByTime(10_000));
    await expect.element(toast).toBeInTheDocument();

    await userEvent.unhover(toast);
    // The hover pause banks the first 2s, so dismissal lands 2s after unhover.
    await act(() => vi.advanceTimersByTime(1_999));
    await expect.element(toast).toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(1));
    await expect.element(toast).not.toBeInTheDocument();
  });
});

describe("toast colors", () => {
  const cases = [
    { type: "error", title: "error toast" },
    { type: "info", title: "info toast" },
    { type: "loading", title: "loading toast" },
    { type: "success", title: "success toast" },
    { type: "warning", title: "warning toast" },
  ] as const;

  it.each(cases)(
    "keeps 4.5:1 contrast for a $type toast in light and dark across default, Grove, and Ember",
    async ({ type, title }) => {
      const root = document.documentElement;
      try {
        applyThemePalette("system", "light");
        await using _screen = await render(<ToastProvider>{null}</ToastProvider>);
        await act(() => {
          toastManager.add({ type, title, timeout: 0 });
        });
        const toast = page.getByRole("dialog", { name: title }).element();
        const titleElement = toast.querySelector<HTMLElement>('[data-slot="toast-title"]')!;
        const iconElement = toast.querySelector<HTMLElement>('[data-slot="toast-icon"]')!;

        for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
          for (const appearance of ["light", "dark"] as const) {
            root.classList.toggle("dark", appearance === "dark");
            root.dataset.theme = appearance;
            applyThemePalette(themeId, appearance);
            // Titles are text (4.5:1) in every theme. The default theme keeps 4.5:1 on icons too; Grove
            // and Ember inherit status hues from their palettes, so their icons are held to the 3:1 non-text floor.
            const iconFloor = themeId === "system" ? 4.5 : 3;
            const label = `${themeId} ${appearance} ${type}`;
            const background = getComputedStyle(toast).backgroundColor;
            const titleColor = getComputedStyle(titleElement).color;
            expect(
              contrastRatio(titleColor, background),
              `${label} title (${titleColor} on ${background})`,
            ).toBeGreaterThanOrEqual(4.5);
            const iconStyle = getComputedStyle(iconElement);
            const iconColor =
              iconStyle.opacity === "1"
                ? iconStyle.color
                : blendedOnSurface(
                    iconStyle.color,
                    background,
                    Number.parseFloat(iconStyle.opacity),
                  );
            expect(
              contrastRatio(iconColor, background),
              `${label} icon (${iconColor} on ${background})`,
            ).toBeGreaterThanOrEqual(iconFloor);
          }
        }
      } finally {
        applyThemePalette("system", "light");
        root.classList.remove("dark");
        delete root.dataset.theme;
      }
    },
  );
});
