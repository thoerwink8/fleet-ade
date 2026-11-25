export const FOLDED_HEIGHT_PROSE_LINES = 7.5;

const CSS_LENGTH_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)(px|rem)$/iu;
const UNITLESS_NUMBER_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)$/u;

export function parseCssLengthPx(raw: string, rootFontSizePx: number): number | null {
  const trimmed = raw.trim();
  const match = CSS_LENGTH_PATTERN.exec(trimmed);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2]!.toLowerCase();
  if (unit === "px") return value;
  return Number.isFinite(rootFontSizePx) && rootFontSizePx > 0 ? value * rootFontSizePx : null;
}

export function parseLineHeightMultiplier(raw: string, fontSizePx: number): number | null {
  const trimmed = raw.trim();
  if (UNITLESS_NUMBER_PATTERN.test(trimmed)) {
    const value = Number.parseFloat(trimmed);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return null;
  const px = parseCssLengthPx(trimmed, fontSizePx);
  return px !== null ? px / fontSizePx : null;
}

export function resolveFoldThresholdPx(input: {
  readonly proseFontSizePx: number;
  readonly proseLineHeight: number;
}): number {
  return input.proseFontSizePx * input.proseLineHeight * FOLDED_HEIGHT_PROSE_LINES * 2;
}

export function isTallEnoughToFold(contentHeightPx: number, thresholdPx: number): boolean {
  return contentHeightPx >= thresholdPx;
}
