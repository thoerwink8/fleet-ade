import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyFontScale,
  BASE_CODE_FONT_SIZE_PX,
  READING_FONT_SCALES,
  resolveReadingFontScaleProperties,
  SHELL_BASE_FONT_SIZE_PX,
} from "./appearanceFonts";

describe("appearanceFonts", () => {
  it("keeps shell constants fixed and defines exact reading tiers without 13px", () => {
    expect(SHELL_BASE_FONT_SIZE_PX).toBe(16);
    expect(BASE_CODE_FONT_SIZE_PX).toBe(14);
    expect(READING_FONT_SCALES).toEqual({
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
    });
    for (const spec of Object.values(READING_FONT_SCALES)) {
      expect(Object.values(spec)).not.toContain(13);
      expect(Math.max(spec.prompt, SHELL_BASE_FONT_SIZE_PX)).toBeGreaterThanOrEqual(16);
    }
  });

  it("emits only --reading-* tokens from resolveReadingFontScaleProperties", () => {
    const props = resolveReadingFontScaleProperties("large");
    expect(props).toEqual({
      "--reading-font-size-prose": "17px",
      "--reading-line-height-prose": "1.6",
      "--reading-font-size-prompt": "15.75px",
      "--reading-line-height-prompt": "1.5",
      "--reading-font-size-code": "16px",
      "--reading-line-height-code": "1.55",
    });
    expect(Object.keys(props).every((key) => key.startsWith("--reading-"))).toBe(true);
    expect(props).not.toHaveProperty("--font-size-prose");
    expect(props).not.toHaveProperty("--font-size-code");
    expect(props).not.toHaveProperty("--font-size-prompt");
    expect(props).not.toHaveProperty("--diffs-font-size");
  });

  it("removes any root font-size and updates --reading-* properties on scale switches", () => {
    const properties = new Map<string, string>();
    const removeProperty = vi.fn((name: string) => {
      properties.delete(name);
      return "";
    });
    const setProperty = vi.fn((name: string, value: string) => {
      properties.set(name, value);
    });
    const root = {
      style: {
        removeProperty,
        setProperty,
      },
    } as unknown as HTMLElement;

    applyFontScale(root, "standard");
    expect(removeProperty).toHaveBeenCalledWith("font-size");
    expect(properties.get("--reading-font-size-prose")).toBe("15px");
    expect(properties.get("--reading-font-size-prompt")).toBe("14px");
    expect(properties.get("--reading-font-size-code")).toBe("14px");

    applyFontScale(root, "comfortable");
    expect(properties.get("--reading-font-size-prose")).toBe("16px");
    expect(properties.get("--reading-font-size-prompt")).toBe("14.875px");
    expect(properties.get("--reading-font-size-code")).toBe("15px");

    applyFontScale(root, "large");
    expect(properties.get("--reading-font-size-prose")).toBe("17px");
    expect(properties.get("--reading-font-size-prompt")).toBe("15.75px");
    expect(properties.get("--reading-font-size-code")).toBe("16px");
    expect(properties.has("--font-size-prose")).toBe(false);
    expect(properties.has("--font-size-code")).toBe(false);
    expect(properties.has("--font-size-prompt")).toBe(false);
    expect(properties.has("--diffs-font-size")).toBe(false);
  });
});
