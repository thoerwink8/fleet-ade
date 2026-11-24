import { converter } from "culori/fn";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import {
  applyThemePalette,
  EMBER_THEME,
  getThemeColorsForMode,
  GROVE_THEME,
} from "../../themePalette";
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipScrollDismissArea,
  TooltipTrigger,
} from "./tooltip";

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

function expectCloseColor(actualValue: string, expectedValue: string, label: string) {
  const expected = toRgb(expectedValue)!;
  const actual = toRgb(actualValue)!;
  expect(actual.alpha ?? 1, `${label} alpha`).toBeCloseTo(expected.alpha ?? 1, 2);
  [expected.r, expected.g, expected.b].forEach((channel, index) => {
    const actualChannel = [actual.r, actual.g, actual.b][index]!;
    expect(Math.abs(channel * 255 - actualChannel * 255), `${label} ch${index}`).toBeLessThan(1.5);
  });
}
it.each([
  { focus: "mouse", keptOpen: false },
  { focus: "keyboard", keptOpen: true },
])("scrolling with a $focus-focused hovered trigger keeps it open: $keptOpen", async (c) => {
  const onScroll = vi.fn();
  await using screen = await render(
    <TooltipScrollDismissArea
      data-testid="timeline"
      onScrollCapture={onScroll}
      className="h-32 overflow-y-auto"
    >
      <Tooltip>
        <TooltipTrigger>Timeline action</TooltipTrigger>
        <TooltipPopup>描述</TooltipPopup>
      </Tooltip>
      <div className="h-96" />
    </TooltipScrollDismissArea>,
  );
  const trigger = screen.getByRole("button", { name: "Timeline action" });
  if (c.focus === "mouse") {
    // A press closes the tooltip; hovering again reopens it with mouse focus kept.
    await userEvent.click(trigger);
    await userEvent.unhover(trigger);
  } else {
    await userEvent.keyboard("{Tab}");
  }
  await userEvent.hover(trigger);
  await expect.element(trigger).toHaveFocus();
  await expect.element(page.getByText("描述")).toBeVisible();

  screen.getByTestId("timeline").element().scrollTop = 20;
  await vi.waitFor(() => expect(onScroll).toHaveBeenCalledOnce());

  if (c.keptOpen) await expect.element(page.getByText("描述")).toBeVisible();
  else await expect.element(page.getByText("描述")).not.toBeInTheDocument();
});

it("opens on hover after 500ms by default, respects provider delay, and stays closed when disabled", async () => {
  await using screen = await render(
    <div>
      <Tooltip>
        <TooltipTrigger>默认提示</TooltipTrigger>
        <TooltipPopup>默认延迟文本</TooltipPopup>
      </Tooltip>
      <TooltipProvider delay={150}>
        <Tooltip>
          <TooltipTrigger>快速提示</TooltipTrigger>
          <TooltipPopup>快速延迟文本</TooltipPopup>
        </Tooltip>
      </TooltipProvider>
      <Tooltip disabled>
        <TooltipTrigger>禁用提示</TooltipTrigger>
        <TooltipPopup>不应显示</TooltipPopup>
      </Tooltip>
    </div>,
  );
  using _timers = fakeTimers();

  await userEvent.hover(screen.getByRole("button", { name: "默认提示" }));
  await act(() => vi.advanceTimersByTime(499));
  expect(page.getByText("默认延迟文本").query()).toBeNull();
  await act(() => vi.advanceTimersByTime(1));
  expect(page.getByText("默认延迟文本").query()).not.toBeNull();

  await userEvent.unhover(screen.getByRole("button", { name: "默认提示" }));
  await userEvent.hover(screen.getByRole("button", { name: "快速提示" }));
  await act(() => vi.advanceTimersByTime(149));
  expect(page.getByText("快速延迟文本").query()).toBeNull();
  await act(() => vi.advanceTimersByTime(1));
  expect(page.getByText("快速延迟文本").query()).not.toBeNull();

  await userEvent.unhover(screen.getByRole("button", { name: "快速提示" }));
  await userEvent.hover(screen.getByRole("button", { name: "禁用提示" }));
  await act(() => vi.advanceTimersByTime(600));
  expect(page.getByText("不应显示").query()).toBeNull();
});

it("opens on keyboard focus and closes on Escape", async () => {
  await using screen = await render(
    <Tooltip>
      <TooltipTrigger>焦点按钮</TooltipTrigger>
      <TooltipPopup>焦点提示</TooltipPopup>
    </Tooltip>,
  );

  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("button", { name: "焦点按钮" })).toHaveFocus();
  await expect.element(page.getByText("焦点提示")).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("焦点提示")).not.toBeInTheDocument();
});

it("renders .fa-tip with fleet-design colors and >= 4.5 contrast across light, dark, Grove, and Ember", async () => {
  const root = document.documentElement;
  try {
    applyThemePalette("system", "light");
    await using _screen = await render(
      <Tooltip open>
        <TooltipTrigger>样式触发器</TooltipTrigger>
        <TooltipPopup>样式内容</TooltipPopup>
      </Tooltip>,
    );
    const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!;
    expect(popup.classList.contains("fa-tip")).toBe(true);

    for (const [appearance, expectedBg, expectedFg, expectedBorder] of [
      ["light", "rgb(255, 255, 255)", "rgb(27, 27, 31)", "rgb(226, 226, 230)"],
      ["dark", "rgb(39, 39, 43)", "rgb(236, 236, 238)", "rgb(48, 48, 54)"],
    ] as const) {
      root.classList.toggle("dark", appearance === "dark");
      root.dataset.theme = appearance;
      const style = getComputedStyle(popup);
      expect(style.backgroundColor, `${appearance} bg`).toBe(expectedBg);
      expect(style.color, `${appearance} fg`).toBe(expectedFg);
      expect(style.borderColor, `${appearance} border`).toBe(expectedBorder);
      expect(style.borderRadius, `${appearance} radius`).toBe("4px");
      expect(style.padding, `${appearance} padding`).toBe("4px 8px");
      expect(
        contrastRatio(style.color, style.backgroundColor),
        `${appearance} .fa-tip contrast`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    for (const theme of [GROVE_THEME, EMBER_THEME]) {
      for (const appearance of ["light", "dark"] as const) {
        root.classList.toggle("dark", appearance === "dark");
        root.dataset.theme = appearance;
        applyThemePalette(theme.id, appearance);
        const colors = getThemeColorsForMode(theme, appearance)!;
        const style = getComputedStyle(popup);
        expectCloseColor(
          style.backgroundColor,
          colors.surfaceOverlay,
          `${theme.id} ${appearance} .fa-tip bg`,
        );
        expectCloseColor(style.color, colors.text, `${theme.id} ${appearance} .fa-tip fg`);
        expect(
          contrastRatio(style.color, style.backgroundColor),
          `${theme.id} ${appearance} .fa-tip contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  } finally {
    applyThemePalette("system", "light");
    root.classList.remove("dark");
    delete root.dataset.theme;
  }
});
