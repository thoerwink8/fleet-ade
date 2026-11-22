import type { FontScale } from "@t3tools/contracts/settings";

const DEFAULT_SANS_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Inter Variable", system-ui, sans-serif';

/** Pixel sizes per step. The interface size sets the root; code, terminal and chat prose follow in pixels. */
export const FONT_SCALES: Readonly<
  Record<FontScale, { readonly interface: number; readonly code: number; readonly prose: number }>
> = {
  standard: { interface: 16, code: 13, prose: 15 },
  comfortable: { interface: 17, code: 14, prose: 16 },
  large: { interface: 18, code: 15, prose: 17 },
};

export function applyFontScale(root: HTMLElement, scale: FontScale): void {
  const sizes = FONT_SCALES[scale];
  root.style.fontSize = `${sizes.interface}px`;
  root.style.setProperty("--font-size-prose", `${sizes.prose}px`);
  root.style.setProperty("--font-size-prompt", "var(--text-sm)");
  root.style.setProperty("--font-size-code", `${sizes.code}px`);
  root.style.setProperty("--diffs-font-size", `${sizes.code}px`);
}

/** The widest single-digit `ol` marker in the interface face; CSS cannot measure it to size the list gutter. */
export function applyListMarkerWidth(root: HTMLElement): void {
  const markerWidth = probeWidth(DEFAULT_SANS_FONT_STACK, LIST_MARKER_PROBE_TEXT);
  if (markerWidth === null) {
    root.style.removeProperty("--list-marker-sans");
  } else {
    root.style.setProperty("--list-marker-sans", `${(markerWidth / PROBE_FONT_SIZE).toFixed(3)}em`);
  }
}

const LIST_MARKER_PROBE_TEXT = "0. ";
const PROBE_FONT_SIZE = 16;
let fontProbeContext: CanvasRenderingContext2D | null | undefined;

function probeWidth(fontList: string, text: string): number | null {
  if (fontProbeContext === undefined) {
    fontProbeContext = document.createElement("canvas").getContext("2d");
  }
  if (fontProbeContext === null) return null;
  fontProbeContext.font = `${PROBE_FONT_SIZE}px ${fontList}`;
  return fontProbeContext.measureText(text).width;
}

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(", ") : null;
}

const MONOSPACE_PROBE_VARIANTS = ["normal 400", "normal 700", "italic 400", "italic 700"] as const;
const MONOSPACE_PROBE_GLYPHS = ["i", "M", "W", "0", "@", "#", ".", " "] as const;
const MONOSPACE_ADVANCE_TOLERANCE = 0.01;

function areFontAdvancesMonospace(advances: readonly number[]): boolean {
  const reference = advances[0];
  if (
    reference === undefined ||
    reference <= 0 ||
    advances.some((advance) => !Number.isFinite(advance) || advance <= 0)
  ) {
    return true;
  }
  return advances.every((advance) => Math.abs(advance - reference) < MONOSPACE_ADVANCE_TOLERANCE);
}

export function isMonospaceFamily(family: string): boolean {
  const families = cssFontFamilies(family);
  if (families === null) return true;
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement("canvas").getContext("2d");
    }
    if (fontProbeContext === null) return true;
    const context = fontProbeContext;
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${families}, monospace`;
      const advances = MONOSPACE_PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width);
      if (!areFontAdvancesMonospace(advances)) return false;
    }
    return true;
  } catch {
    return true;
  }
}
