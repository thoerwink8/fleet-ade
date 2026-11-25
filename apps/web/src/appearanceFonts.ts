import type { FontScale } from "@t3tools/contracts/settings";

const DEFAULT_SANS_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Inter Variable", system-ui, sans-serif';

export const SHELL_BASE_FONT_SIZE_PX = 16;
export const BASE_CODE_FONT_SIZE_PX = 14;

export interface ReadingFontScaleSpec {
  readonly prose: number;
  readonly proseLineHeight: number;
  readonly prompt: number;
  readonly promptLineHeight: number;
  readonly code: number;
  readonly codeLineHeight: number;
}

/** Reading-area typography steps. The shell stays at 16px root; conversation prose, code and composer scale. */
export const READING_FONT_SCALES: Readonly<Record<FontScale, ReadingFontScaleSpec>> = {
  standard: {
    prose: 15,
    proseLineHeight: 1.6,
    prompt: 14,
    promptLineHeight: 1.5,
    code: 14,
    codeLineHeight: 1.55,
  },
  comfortable: {
    prose: 16,
    proseLineHeight: 1.6,
    prompt: 14.875,
    promptLineHeight: 1.5,
    code: 15,
    codeLineHeight: 1.55,
  },
  large: {
    prose: 17,
    proseLineHeight: 1.6,
    prompt: 15.75,
    promptLineHeight: 1.5,
    code: 16,
    codeLineHeight: 1.55,
  },
};

export function resolveReadingFontScaleProperties(
  scale: FontScale,
): Readonly<Record<string, string>> {
  const sizes = READING_FONT_SCALES[scale];
  return {
    "--reading-font-size-prose": `${sizes.prose}px`,
    "--reading-line-height-prose": String(sizes.proseLineHeight),
    "--reading-font-size-prompt": `${sizes.prompt}px`,
    "--reading-line-height-prompt": String(sizes.promptLineHeight),
    "--reading-font-size-code": `${sizes.code}px`,
    "--reading-line-height-code": String(sizes.codeLineHeight),
  };
}

export function applyFontScale(root: HTMLElement, scale: FontScale): void {
  root.style.removeProperty("font-size");
  for (const [property, value] of Object.entries(resolveReadingFontScaleProperties(scale))) {
    root.style.setProperty(property, value);
  }
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
