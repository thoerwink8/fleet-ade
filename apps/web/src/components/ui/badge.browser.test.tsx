import { GitBranchIcon } from "lucide-react";
import { type ComponentProps, type CSSProperties } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { applyThemePalette, EMBER_THEME, GROVE_THEME } from "../../themePalette";
import { Badge } from "./badge";

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;
type BadgeSize = NonNullable<ComponentProps<typeof Badge>["size"]>;

const SIZES = {
  default: true,
  row: true,
  sm: true,
} satisfies Record<BadgeSize, true>;

const TAG_VARIANTS = new Set<BadgeVariant>(["secondary", "outline", "chip", "label"]);

// warning uses the needs dot: fleet-design 0.3.1 has no warning dot.
const DOT_CLASS = {
  secondary: null,
  outline: null,
  chip: null,
  label: "ade-badge__dot--label",
  destructive: "fa-dot--error",
  error: "fa-dot--error",
  info: "fa-dot--needs",
  success: "fa-dot--running",
  warning: "fa-dot--needs",
  "dot-attention": "fa-dot--needs",
  "dot-active": "fa-dot--running",
  "dot-blocked": "fa-dot--error",
  "dot-waiting": "fa-dot--ring",
  "dot-done": "",
} satisfies Record<BadgeVariant, string | null>;

const SEMANTIC_BACKGROUND = {
  success: "--fa-success",
  warning: "--fa-warning",
  error: "--fa-danger",
  info: "--fa-info",
} as const;

function resolved(property: "height" | "backgroundColor", value: string): string {
  const probe = document.createElement("div");
  probe.style[property] = value;
  document.body.append(probe);
  try {
    return getComputedStyle(probe)[property];
  } finally {
    probe.remove();
  }
}

function readPainted(className: string, labelColor?: string) {
  const probe = document.createElement("span");
  probe.className = className;
  probe.textContent = "标签";
  if (labelColor !== undefined) probe.style.setProperty("--label", labelColor);
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const painted = {
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
    borderRadius: style.borderRadius,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    color: style.color,
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
    columnGap: style.columnGap,
    width: style.width,
    height: style.height,
    boxShadow: style.boxShadow,
  };
  probe.remove();
  return painted;
}

function expectOnGrid(value: string, label: string) {
  for (const part of value.trim().split(/\s+/u)) {
    const px = Number.parseFloat(part);
    expect(Number.isFinite(px), `${label} (${value})`).toBe(true);
    expect(px % 4, `${label} (${value})`).toBe(0);
  }
}

function expectIconInside(badge: Element, label: string) {
  const icon = badge.querySelector("svg");
  expect(icon, `${label} icon`).not.toBeNull();
  const badgeRect = badge.getBoundingClientRect();
  const iconRect = icon!.getBoundingClientRect();
  const badgeMid = badgeRect.top + badgeRect.height / 2;
  const iconMid = iconRect.top + iconRect.height / 2;
  expect(Math.abs(badgeMid - iconMid), `${label} icon center`).toBeLessThan(1);
  expect(iconRect.height, `${label} icon height`).toBeGreaterThan(0);
  expect(iconRect.top, `${label} icon top`).toBeGreaterThanOrEqual(badgeRect.top - 0.5);
  expect(iconRect.bottom, `${label} icon bottom`).toBeLessThanOrEqual(badgeRect.bottom + 0.5);
  expect(iconRect.left, `${label} icon left`).toBeGreaterThanOrEqual(badgeRect.left - 0.5);
  expect(iconRect.right, `${label} icon right`).toBeLessThanOrEqual(badgeRect.right + 0.5);
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

describe("Badge", () => {
  it("paints every variant as a fleet-design tag at 390 and 1280", async () => {
    const prev = { width: window.innerWidth, height: window.innerHeight };
    const root = document.documentElement;
    const variants = Object.keys(DOT_CLASS) as Array<BadgeVariant>;
    const sizes = Object.keys(SIZES) as Array<BadgeSize>;
    try {
      for (const [width, height] of [
        [1280, 800],
        [390, 844],
      ] as const) {
        await page.viewport(width, height);
        await using screen = await render(
          <div className="flex flex-wrap items-center gap-2 p-4">
            {variants.flatMap((variant) =>
              sizes.map((size) => (
                <Badge
                  key={`${variant}-${size}`}
                  variant={variant}
                  size={size}
                  data-testid={`${variant}-${size}`}
                  {...(variant === "label"
                    ? { style: { "--label": "#ff0000" } as CSSProperties }
                    : {})}
                >
                  {`${variant}-${size}`}
                </Badge>
              )),
            )}
            <Badge variant="chip" data-testid="chip-icon">
              <GitBranchIcon />
              <span>feature/name</span>
            </Badge>
            <Badge variant="success" data-testid="status-icon">
              <GitBranchIcon className="size-3" />
              已批准
            </Badge>
          </div>,
        );

        const tagHeight = resolved("height", "var(--fa-ctrl-2xs)");
        expect(tagHeight, "tag height token").toBe("20px");

        for (const themeId of ["system", GROVE_THEME.id, EMBER_THEME.id] as const) {
          for (const mode of ["light", "dark"] as const) {
            root.classList.toggle("dark", mode === "dark");
            root.dataset.theme = mode;
            applyThemePalette(themeId, mode);
            const tagPaint = readPainted("fa-tag");
            const statusPaint = readPainted("fa-status");

            for (const variant of variants) {
              const library = TAG_VARIANTS.has(variant) ? tagPaint : statusPaint;
              for (const size of sizes) {
                const label = `${width}px ${themeId} ${mode} ${variant} ${size}`;
                const badgeEl = screen.getByTestId(`${variant}-${size}`).element();
                const style = getComputedStyle(badgeEl);
                expect(style.height, `${label} height`).toBe(tagHeight);
                expect(style.fontSize, `${label} font size`).toBe("12px");
                expect(style.fontSize, `${label} font size vs library`).toBe(library.fontSize);
                expect(Number(style.fontWeight), `${label} weight`).toBeLessThanOrEqual(500);
                expect(style.fontWeight, `${label} weight vs library`).toBe(library.fontWeight);
                expect(style.paddingLeft, `${label} padding`).toBe(library.paddingLeft);
                expect(style.paddingRight, `${label} padding`).toBe(library.paddingRight);
                expect(style.borderRadius, `${label} radius`).toBe(library.borderRadius);
                expect(style.columnGap, `${label} gap`).toBe(library.columnGap);
                expect(style.color, `${label} text`).toBe(library.color);
                expect(style.backgroundColor, `${label} background`).toBe(library.backgroundColor);
                expect(style.backgroundImage, `${label} background image`).toBe(
                  library.backgroundImage,
                );
                expect(style.backdropFilter, `${label} backdrop`).toBe("none");
                expect(style.willChange, `${label} will-change`).toBe("auto");
                expectOnGrid(style.height, `${label} height grid`);
                expectOnGrid(style.paddingLeft, `${label} padding grid`);
                expectOnGrid(style.paddingRight, `${label} padding grid`);
                expectOnGrid(style.borderRadius, `${label} radius grid`);
                expectOnGrid(style.columnGap, `${label} gap grid`);
                expectOnGrid(style.fontSize, `${label} font grid`);

                const semantic = SEMANTIC_BACKGROUND[variant as keyof typeof SEMANTIC_BACKGROUND];
                if (semantic !== undefined) {
                  expect(style.backgroundColor, `${label} semantic fill`).not.toBe(
                    resolved("backgroundColor", `var(${semantic})`),
                  );
                }

                const dotClass = DOT_CLASS[variant];
                const dot = badgeEl.querySelector(".fa-dot");
                if (dotClass === null) {
                  expect(dot, `${label} dot`).toBeNull();
                  continue;
                }
                expect(dot, `${label} dot`).not.toBeNull();
                const dotStyle = getComputedStyle(dot!);
                const dotPaint = readPainted(
                  `fa-dot ${dotClass}`.trim(),
                  variant === "label" ? "#ff0000" : undefined,
                );
                expect(dotStyle.width, `${label} dot width`).toBe(dotPaint.width);
                expect(dotStyle.height, `${label} dot height`).toBe(dotPaint.height);
                expect(dotStyle.backgroundColor, `${label} dot color`).toBe(
                  dotPaint.backgroundColor,
                );
                expect(dotStyle.boxShadow, `${label} dot shadow`).toBe(dotPaint.boxShadow);
                expectOnGrid(dotStyle.width, `${label} dot width grid`);
                expectOnGrid(dotStyle.height, `${label} dot height grid`);
              }
            }

            const chip = getComputedStyle(screen.getByTestId("chip-default").element());
            expect(chip.fontVariantNumeric, `${width}px ${themeId} ${mode} chip figures`).toContain(
              "tabular-nums",
            );
          }
        }

        expectIconInside(screen.getByTestId("chip-icon").element(), `${width}px chip`);
        expectIconInside(screen.getByTestId("status-icon").element(), `${width}px status`);
      }
    } finally {
      applyThemePalette("system", "light");
      root.classList.remove("dark");
      delete root.dataset.theme;
      await page.viewport(prev.width, prev.height);
    }
  });

  it("keeps a linked badge 20px tall and stretches its coarse hit target to 44px", async () => {
    await using _pointer = await emulateCoarsePointer();
    await using screen = await render(
      <div className="p-12">
        <Badge variant="chip" render={<a href="#pr" />}>
          PR #12
        </Badge>
      </div>,
    );
    await vi.waitFor(() => expect(window.matchMedia("(pointer: coarse)").matches).toBe(true));

    const link = screen.getByRole("link", { name: "PR #12" }).element();
    const tagHeight = resolved("height", "var(--fa-ctrl-2xs)");
    expect(getComputedStyle(link).height).toBe(tagHeight);
    expect(tagHeight).toBe("20px");
    expect(Number.parseFloat(getComputedStyle(link, "::after").minHeight)).toBe(44);
    expect(Number.parseFloat(getComputedStyle(link, "::after").minWidth)).toBe(44);
  });
});
