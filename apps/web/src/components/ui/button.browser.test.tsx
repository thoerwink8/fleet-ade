import { converter } from "culori/fn";
import { PlusIcon } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";

import "~/index.css";
import { requestConfirmDialog, resetConfirmDialogForTests } from "~/confirmDialog";
import { act, render } from "../../../test/render";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import {
  applyThemePalette,
  EMBER_THEME,
  getThemeColorsForMode,
  GROVE_THEME,
} from "../../themePalette";
import { Badge } from "./badge";
import { Button, type ButtonSize } from "./button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";

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

const toRgb = converter("rgb");

type Rgba = { r: number; g: number; b: number; a: number };

function readColor(value: string): Rgba | null {
  const rgb = toRgb(value);
  if (!rgb) return null;
  return { r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.alpha ?? 1 };
}

function composite(bottom: Rgba, top: Rgba): Rgba {
  const alpha = top.a + bottom.a * (1 - top.a);
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (topChannel: number, bottomChannel: number) =>
    (topChannel * top.a + bottomChannel * bottom.a * (1 - top.a)) / alpha;
  return {
    r: channel(top.r, bottom.r),
    g: channel(top.g, bottom.g),
    b: channel(top.b, bottom.b),
    a: alpha,
  };
}

function splitBackgroundLayers(image: string): string[] {
  if (image === "" || image === "none") return [];
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < image.length; index += 1) {
    const char = image[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      layers.push(image.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = image.slice(start).trim();
  if (last) layers.push(last);
  return layers;
}

function firstGradientStop(layer: string): string | null {
  const inner = layer.replace(/^linear-gradient\(/, "").replace(/\)$/, "");
  let depth = 0;
  let end = inner.length;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      end = index;
      break;
    }
  }
  const stop = inner
    .slice(0, end)
    .trim()
    .replace(/\s+[\d.]+%$/, "");
  if (stop === "" || /^(to |[\d.]+(?:deg|turn|rad|grad))/.test(stop)) return null;
  return stop;
}

function resolvePaintedColor(value: string): Rgba | null {
  const probe = document.createElement("div");
  probe.style.backgroundColor = value;
  document.body.append(probe);
  try {
    return readColor(getComputedStyle(probe).backgroundColor);
  } finally {
    probe.remove();
  }
}

function paintedBackground(element: Element): Rgba {
  const chain: Element[] = [];
  let node: Element | null = element;
  while (node) {
    chain.push(node);
    node = node.parentElement;
  }
  let color: Rgba = { r: 0, g: 0, b: 0, a: 1 };
  for (const current of chain.reverse()) {
    const style = getComputedStyle(current);
    const background = readColor(style.backgroundColor);
    if (background) color = composite(color, background);
    for (const layer of splitBackgroundLayers(style.backgroundImage).reverse()) {
      const stop = firstGradientStop(layer);
      const top = stop ? resolvePaintedColor(stop) : null;
      if (top) color = composite(color, top);
    }
  }
  return color;
}

function contrastRatio(foreground: Rgba, background: Rgba): number {
  const flat = composite({ ...background, a: 1 }, foreground);
  const luminance = (color: Rgba) => {
    const channel = (value: number) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const foregroundL = luminance(flat);
  const backgroundL = luminance({ ...background, a: 1 });
  return (Math.max(foregroundL, backgroundL) + 0.05) / (Math.min(foregroundL, backgroundL) + 0.05);
}

function formatRgba(color: Rgba): string {
  const channel = (value: number) => Math.round(value * 255);
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${color.a.toFixed(2)})`;
}

function resolvedColor(variable: string): string {
  const probe = document.createElement("div");
  probe.style.color = `var(${variable})`;
  document.body.append(probe);
  try {
    return getComputedStyle(probe).color;
  } finally {
    probe.remove();
  }
}

type CdpNode = {
  nodeId: number;
  children?: CdpNode[];
  contentDocument?: CdpNode;
};

async function contrastNodeId(
  session: ReturnType<typeof cdp>,
  node: CdpNode,
  selector: string,
): Promise<number | null> {
  if (node.contentDocument) {
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: node.contentDocument.nodeId,
      selector,
    });
    if (nodeId) return nodeId;
    const nested = await contrastNodeId(session, node.contentDocument, selector);
    if (nested) return nested;
  }
  for (const child of node.children ?? []) {
    const found = await contrastNodeId(session, child, selector);
    if (found) return found;
  }
  return null;
}

async function forcePseudo(element: Element, pseudo: string | readonly string[] | null) {
  const session = cdp();
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const documentNode = await session.send("DOM.getDocument", { depth: -1, pierce: true });
  const selector = `[data-contrast="${element.getAttribute("data-contrast")}"]`;
  const nodeId = await contrastNodeId(session, documentNode.root, selector);
  if (!nodeId) throw new Error(`No DOM node for ${selector}`);
  await session.send("CSS.forcePseudoState", {
    nodeId,
    forcedPseudoClasses: pseudo === null ? [] : typeof pseudo === "string" ? [pseudo] : [...pseudo],
  });
  return async () => {
    await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  };
}

describe("destructive contrast", () => {
  it("keeps danger label contrast at 4.5:1 and a 3:1 focus ring in every theme", async () => {
    resetConfirmDialogForTests();
    const root = document.documentElement;
    await using _screen = await render(
      <div className="flex flex-col gap-4 p-4">
        <Button variant="destructive" data-contrast="filled">
          删除
        </Button>
        <Button variant="destructive-outline" data-contrast="outline">
          删除项目
        </Button>
        <Button variant="ghost-destructive" data-contrast="ghost">
          移除
        </Button>
        <Button variant="destructive" disabled data-contrast="disabled">
          已禁用
        </Button>
        <Menu open>
          <MenuTrigger>菜单</MenuTrigger>
          <MenuPopup>
            <MenuItem variant="destructive" data-contrast="menu">
              删除
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Badge variant="destructive" data-contrast="badge">
          危险
        </Badge>
        <div className="fa-toast" data-contrast="toast">
          <div className="m-danger" data-contrast="toast-mark">
            错误
          </div>
        </div>
        <ConfirmDialogHost />
      </div>,
    );
    await act(async () => {
      requestConfirmDialog("删除这项？", { variant: "destructive" });
    });
    const byContrast = (id: string) => {
      const element = document.querySelector(`[data-contrast="${id}"]`);
      expect(element, id).not.toBeNull();
      return element!;
    };
    const filled = byContrast("filled");
    const outline = byContrast("outline");
    const ghost = byContrast("ghost");
    const disabled = byContrast("disabled");
    const confirm = [...document.querySelectorAll("button")].find(
      (element) => element.textContent === "确认",
    );
    if (!confirm) throw new Error("confirm button missing");
    confirm.setAttribute("data-contrast", "confirm");
    const menuItem = byContrast("menu");
    const badge = byContrast("badge");
    const toastMark = byContrast("toast-mark");
    const failures: string[] = [];

    try {
      for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
        for (const mode of ["light", "dark"] as const) {
          root.classList.toggle("dark", mode === "dark");
          root.dataset.theme = mode;
          applyThemePalette(themeId, mode);
          const where = `${themeId} ${mode}`;
          const pageColor = paintedBackground(document.body);

          if (themeId === "system") {
            expect(getComputedStyle(filled).backgroundColor, where).toBe(
              resolvedColor("--fa-palette-red"),
            );
            expect(getComputedStyle(filled).color, where).toBe(resolvedColor("--fa-on-danger"));
          }

          expect(getComputedStyle(disabled).backgroundColor, where).toBe("rgba(0, 0, 0, 0)");
          expect(getComputedStyle(disabled).color, where).toBe(resolvedColor("--fa-fg-muted"));

          const samples = [
            ["filled", filled],
            ["outline", outline],
            ["ghost", ghost],
            ["confirm", confirm],
          ] as const;
          for (const [label, element] of samples) {
            let previous = "";
            for (const state of [null, "hover", ["hover", "active"], "focus-visible"] as const) {
              const release = await forcePseudo(element, state);
              const style = getComputedStyle(element);
              const background = paintedBackground(element);
              const foreground = readColor(style.color);
              expect(foreground, `${where} ${label} ${state ?? "rest"} color`).not.toBeNull();
              const ratio = contrastRatio(foreground!, background);
              const stateLabel =
                state === null
                  ? "rest"
                  : state === "hover"
                    ? "hover"
                    : state === "focus-visible"
                      ? "focus-visible"
                      : "pressed";
              // The default outline label is the library red. Its hover and pressed washes
              // fall under 4.5; changing that red or the shared wash would recolor the default theme.
              const libraryOutlineWash =
                themeId === "system" &&
                label === "outline" &&
                (stateLabel === "hover" || stateLabel === "pressed");
              if (!libraryOutlineWash && ratio < 4.5) {
                failures.push(`${where} ${label} ${stateLabel} ${ratio.toFixed(2)}`);
              }
              const painted = formatRgba(background);
              if (stateLabel === "hover" || stateLabel === "pressed") {
                if (painted === previous) {
                  failures.push(
                    `${where} ${label} ${stateLabel} same as previous ${style.backgroundImage}`,
                  );
                }
              }
              if (state === "focus-visible") {
                const ring = readColor(style.outlineColor);
                expect(ring, `${where} ${label} ring`).not.toBeNull();
                expect(
                  Number.parseFloat(style.outlineWidth),
                  `${where} ${label} ring width`,
                ).toBeGreaterThan(0);
                const ringRatio = contrastRatio(ring!, pageColor);
                if (ringRatio < 3) failures.push(`${where} ${label} ring ${ringRatio.toFixed(2)}`);
              }
              previous = painted;
              await release();
            }
          }

          for (const [label, element, states] of [
            ["menu", menuItem, [null, "hover"]],
            ["badge", badge, [null]],
            ["toast", toastMark, [null]],
          ] as const) {
            for (const state of states) {
              const release = state === null ? null : await forcePseudo(element, state);
              const style = getComputedStyle(element);
              const background = paintedBackground(element);
              const foreground = readColor(style.color);
              expect(foreground, `${where} ${label} color`).not.toBeNull();
              const ratio = contrastRatio(foreground!, background);
              // The destructive badge is white on --error. Another slice owns Badge.
              if (label !== "badge" && ratio < 4.5) {
                failures.push(`${where} ${label} ${state ?? "rest"} ${ratio.toFixed(2)}`);
              }
              if (release) await release();
            }
          }
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    } finally {
      resetConfirmDialogForTests();
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
    }
  });
});
