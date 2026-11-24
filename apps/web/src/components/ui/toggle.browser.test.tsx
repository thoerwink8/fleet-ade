import { PlusIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import { converter, wcagContrast } from "culori/fn";

import "~/index.css";
import { render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { Button } from "./button";
import { Toggle } from "./toggle";

const toRgb = converter("rgb");

const SIZES = [
  ["default", "--fa-ctrl", "default", "icon"],
  ["sm", "--fa-ctrl-sm", "sm", "icon-sm"],
  ["compact", "--fa-ctrl-sm", "sm", "icon-sm"],
  ["xs", "--fa-ctrl-xs", "xs", "icon-xs"],
  ["segmented", "--fa-ctrl-xs", "xs", "icon-xs"],
] as const;

function computed(prop: "height" | "backgroundColor" | "color" | "outlineColor", value: string) {
  const probe = document.createElement("div");
  probe.style[prop] = value;
  document.body.append(probe);
  try {
    return getComputedStyle(probe)[prop];
  } finally {
    probe.remove();
  }
}

function paint(top: string, bottom: string): string {
  const over = toRgb(top);
  const base = toRgb(bottom);
  if (!over || !base) throw new Error(`unparsed color: ${top} on ${bottom}`);
  const alpha = over.alpha ?? 1;
  const channel = (value: number, under: number) =>
    Math.round((value * alpha + under * (1 - alpha)) * 255);
  return `rgb(${channel(over.r, base.r)}, ${channel(over.g, base.g)}, ${channel(over.b, base.b)})`;
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

function fill(el: Element) {
  const style = getComputedStyle(el);
  return `${style.backgroundColor} ${style.backgroundImage}`;
}

describe("Toggle", () => {
  it("paints every size at the fleet-design height, matching the same-size button at both viewports", async () => {
    const prev = { width: window.innerWidth, height: window.innerHeight };
    try {
      for (const [width, height] of [
        [1280, 800],
        [390, 844],
      ] as const) {
        await page.viewport(width, height);
        await using screen = await render(
          <div className="flex flex-wrap items-center gap-2 p-4">
            {SIZES.map(([size]) => (
              <Toggle key={size} aria-label={size} size={size}>
                <PlusIcon />
              </Toggle>
            ))}
            {SIZES.map(([size]) => (
              <Toggle key={`${size}-text`} aria-label={`${size} text`} size={size}>
                非
              </Toggle>
            ))}
            <Button aria-label="button default" size="default">
              <PlusIcon />
            </Button>
            <Button aria-label="button sm" size="sm">
              <PlusIcon />
            </Button>
            <Button aria-label="button xs" size="xs">
              <PlusIcon />
            </Button>
            <Button aria-label="button icon" size="icon">
              <PlusIcon />
            </Button>
            <Button aria-label="button icon-sm" size="icon-sm">
              <PlusIcon />
            </Button>
            <Button aria-label="button icon-xs" size="icon-xs">
              <PlusIcon />
            </Button>
          </div>,
        );
        const button = (name: string) =>
          getComputedStyle(screen.getByRole("button", { name }).element());
        for (const [size, token, textSize, iconSize] of SIZES) {
          const expected = computed("height", `var(${token})`);
          const icon = button(size);
          const text = button(`${size} text`);
          expect(icon.height, `${width}px ${size} height`).toBe(expected);
          expect(icon.width, `${width}px ${size} square`).toBe(icon.height);
          expect(icon.fontSize, `${width}px ${size} fontSize`).toBe("14px");
          expect(Number(icon.fontWeight), `${width}px ${size} weight`).toBeLessThanOrEqual(500);
          expect(text.height, `${width}px ${size} text height`).toBe(expected);
          expect(Number.parseFloat(text.width), `${width}px ${size} text wider`).toBeGreaterThan(
            Number.parseFloat(expected),
          );
          const sameText = button(`button ${textSize}`);
          const sameIcon = button(`button ${iconSize}`);
          expect(icon.borderRadius, `${width}px ${size} radius`).toBe(sameIcon.borderRadius);
          expect(icon.paddingLeft, `${width}px ${size} padding`).toBe(sameIcon.paddingLeft);
          expect(text.paddingLeft, `${width}px ${size} text padding`).toBe(sameText.paddingLeft);
          expect(text.paddingRight, `${width}px ${size} text padding`).toBe(sameText.paddingRight);
          expect(text.borderRadius, `${width}px ${size} text radius`).toBe(sameText.borderRadius);
        }
      }
    } finally {
      await page.viewport(prev.width, prev.height);
    }
  });

  it("separates idle, hover and pressed without the accent, and keeps disabled at full opacity", async () => {
    await using screen = await render(
      <div className="flex flex-wrap gap-2 p-4">
        <Toggle aria-label="Idle" />
        <Toggle aria-label="Pressed" defaultPressed />
        <Toggle aria-label="Outline" variant="outline" />
        <Toggle aria-label="Outline Pressed" variant="outline" defaultPressed />
        <Toggle aria-label="Disabled" disabled />
        <Toggle aria-label="Pressed Disabled" defaultPressed disabled />
      </div>,
    );
    const el = (name: string) => screen.getByRole("button", { name }).element();
    const selected = computed("backgroundColor", "var(--fa-selected)");
    const accent = computed("backgroundColor", "var(--fa-accent)");
    const muted = computed("color", "var(--fa-fg-muted)");

    const idle = el("Idle");
    expect(getComputedStyle(idle).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(idle).backgroundImage).toBe("none");
    const idleFill = fill(idle);
    await screen.getByRole("button", { name: "Idle" }).hover();
    const hovered = getComputedStyle(idle);
    expect(hovered.backgroundImage, "hover fill").toContain("linear-gradient(");
    expect(hovered.backgroundColor, "hover keeps no solid fill").toBe("rgba(0, 0, 0, 0)");

    const pressed = el("Pressed");
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    expect(pressed.hasAttribute("data-pressed")).toBe(true);
    const pressedStyle = getComputedStyle(pressed);
    expect(pressedStyle.backgroundColor, "pressed fill").toBe(selected);
    expect(pressedStyle.backgroundImage, "pressed drops the hover gradient").toBe("none");
    expect(pressedStyle.backgroundColor, "pressed is not the accent").not.toBe(accent);
    expect(fill(pressed), "pressed differs from idle").not.toBe(idleFill);
    expect(fill(pressed), "pressed differs from hover").not.toBe(
      `${hovered.backgroundColor} ${hovered.backgroundImage}`,
    );

    const outline = el("Outline");
    const outlinePressed = el("Outline Pressed");
    expect(getComputedStyle(outline).backgroundImage, "outline idle has the neutral wash").not.toBe(
      "none",
    );
    expect(getComputedStyle(outlinePressed).backgroundColor).toBe(selected);
    expect(fill(outlinePressed), "outline pressed differs from its idle").not.toBe(fill(outline));

    for (const name of ["Disabled", "Pressed Disabled"]) {
      const style = getComputedStyle(el(name));
      expect(style.opacity, `${name} opacity`).toBe("1");
      expect(style.color, `${name} color`).toBe(muted);
    }
    expect(getComputedStyle(el("Disabled")).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(el("Pressed Disabled")).backgroundColor).toBe(selected);
  });

  it("stretches the coarse-pointer hit area to 44px without growing the painted box", async () => {
    await using _pointer = await emulateCoarsePointer();
    await using screen = await render(
      <div className="p-12">
        <Toggle aria-label="Touch" size="sm">
          <PlusIcon />
        </Toggle>
      </div>,
    );
    const toggle = screen.getByRole("button", { name: "Touch" }).element();
    const rect = toggle.getBoundingClientRect();
    expect(Math.round(rect.height)).toBe(
      Number.parseFloat(computed("height", "var(--fa-ctrl-sm)")),
    );
    expect(Number.parseFloat(getComputedStyle(toggle, "::after").minHeight)).toBe(44);
    expect(Number.parseFloat(getComputedStyle(toggle, "::after").minWidth)).toBe(44);
    expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top - 4)).toBe(toggle);
  });

  it("toggles with Space and Enter and shows the library focus ring", async () => {
    await using screen = await render(<Toggle aria-label="面板">面板</Toggle>);
    const toggle = screen.getByRole("button", { name: "面板" });
    await userEvent.keyboard("{Tab}");
    await expect.element(toggle).toHaveFocus();
    expect(toggle.element().getAttribute("aria-pressed")).toBe("false");
    await userEvent.keyboard(" ");
    expect(toggle.element().getAttribute("aria-pressed")).toBe("true");
    await userEvent.keyboard("{Enter}");
    expect(toggle.element().getAttribute("aria-pressed")).toBe("false");

    const style = getComputedStyle(toggle.element());
    expect(style.outlineStyle).toBe("solid");
    expect(style.outlineWidth).toBe("2px");
    expect(style.outlineOffset).toBe("2px");
    expect(style.outlineColor).toBe(computed("outlineColor", "var(--fa-focus-ring)"));
  });

  it("keeps pressed text at 4.5:1 in the default, Grove and Ember themes, and themes leave disabled text muted", async () => {
    const root = document.documentElement;
    try {
      await using screen = await render(
        <div>
          <Toggle aria-label="Pressed" defaultPressed>
            按下
          </Toggle>
          <div data-panel-layout-controls>
            <Toggle aria-label="Panel" defaultPressed>
              面板
            </Toggle>
            <Toggle aria-label="Panel Disabled" disabled>
              禁用
            </Toggle>
          </div>
        </div>,
      );
      const pressed = screen.getByRole("button", { name: "Pressed" }).element();
      const panel = screen.getByRole("button", { name: "Panel" }).element();
      const disabled = screen.getByRole("button", { name: "Panel Disabled" }).element();

      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const mode of ["light", "dark"] as const) {
          root.classList.toggle("dark", mode === "dark");
          root.dataset.theme = mode;
          applyThemePalette(themeId, mode);
          const where = `${themeId} ${mode}`;
          const style = getComputedStyle(pressed);
          const surface = getComputedStyle(document.body).backgroundColor;
          expect(surface, `${where} page background`).not.toBe("rgba(0, 0, 0, 0)");
          const contrast = wcagContrast(
            toRgb(style.color)!,
            toRgb(paint(style.backgroundColor, surface))!,
          );
          expect(contrast, `${where} pressed contrast`).toBeGreaterThanOrEqual(4.5);
          expect(style.backgroundColor, `${where} pressed is not the accent`).not.toBe(
            computed("backgroundColor", "var(--fa-accent)"),
          );
          expect(getComputedStyle(disabled).color, `${where} disabled text`).toBe(
            computed("color", "var(--fa-fg-muted)"),
          );
          expect(getComputedStyle(disabled).opacity, `${where} disabled opacity`).toBe("1");
          expect(
            getComputedStyle(disabled).color,
            `${where} disabled differs from enabled`,
          ).not.toBe(getComputedStyle(panel).color);
        }
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });
});
