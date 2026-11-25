import { describe, expect, it } from "vite-plus/test";

import { READING_FONT_SCALES } from "~/appearanceFonts";
import {
  FOLDED_HEIGHT_PROSE_LINES,
  isTallEnoughToFold,
  parseCssLengthPx,
  parseLineHeightMultiplier,
  resolveFoldThresholdPx,
} from "./useTallEnoughToFold.logic";

describe("useTallEnoughToFold.logic", () => {
  it("parses px and rem CSS lengths and rejects invalid values", () => {
    expect(parseCssLengthPx("15px", 16)).toBe(15);
    expect(parseCssLengthPx(" 0.9375rem ", 16)).toBe(15);
    expect(parseCssLengthPx("0px", 16)).toBeNull();
    expect(parseCssLengthPx("-15px", 16)).toBeNull();
    expect(parseCssLengthPx("auto", 16)).toBeNull();
    expect(parseCssLengthPx("1rem", 0)).toBeNull();
  });

  it("parses unitless and pixel line-heights", () => {
    expect(parseLineHeightMultiplier("1.6", 15)).toBe(1.6);
    expect(parseLineHeightMultiplier("24px", 15)).toBe(1.6);
    expect(parseLineHeightMultiplier("27.2px", 17)).toBeCloseTo(1.6, 5);
    expect(parseLineHeightMultiplier("normal", 15)).toBeNull();
    expect(parseLineHeightMultiplier("0", 15)).toBeNull();
  });

  it("scales fold threshold with reading prose size so 12 lines stay unfolded and 15+ lines fold across all tiers", () => {
    expect(FOLDED_HEIGHT_PROSE_LINES).toBe(7.5);
    const expectedThresholds = {
      standard: 360,
      comfortable: 384,
      large: 408,
    } as const;

    for (const scale of ["standard", "comfortable", "large"] as const) {
      const spec = READING_FONT_SCALES[scale];
      const threshold = resolveFoldThresholdPx({
        proseFontSizePx: spec.prose,
        proseLineHeight: spec.proseLineHeight,
      });
      expect(threshold).toBeCloseTo(expectedThresholds[scale], 5);

      const linePx = spec.prose * spec.proseLineHeight;
      expect(isTallEnoughToFold(linePx * 12, threshold)).toBe(false);
      expect(isTallEnoughToFold(linePx * 15, threshold)).toBe(true);
    }
  });
});
