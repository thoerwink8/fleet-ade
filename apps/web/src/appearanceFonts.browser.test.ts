import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyFontScale } from "./appearanceFonts";

function withProbe(
  insideReadingArea: boolean,
  build: (probe: HTMLElement) => HTMLElement | void,
): { fontSize: string; lineHeight: string } {
  const host = document.createElement("div");
  if (insideReadingArea) {
    host.setAttribute("data-reading-area", "true");
  }
  const probe = document.createElement("div");
  const target = build(probe) ?? probe;
  host.append(probe);
  document.body.append(host);
  try {
    const computed = getComputedStyle(target);
    return { fontSize: computed.fontSize, lineHeight: computed.lineHeight };
  } finally {
    host.remove();
  }
}

const composerFontSize = (insideReadingArea: boolean) =>
  withProbe(insideReadingArea, (probe) => {
    probe.className = "text-(length:--font-size-prompt,var(--text-sm))";
  }).fontSize;

const touchComposerFontSize = (insideReadingArea: boolean) =>
  withProbe(insideReadingArea, (probe) => {
    probe.style.fontSize = "var(--font-size-prompt-touch)";
  }).fontSize;

const proseMetrics = (insideReadingArea: boolean) =>
  withProbe(insideReadingArea, (probe) => {
    probe.className = "chat-markdown-prose";
  });

const codeFontSize = (insideReadingArea: boolean) =>
  withProbe(insideReadingArea, (probe) => {
    probe.className = "chat-markdown";
    const block = document.createElement("div");
    block.className = "chat-markdown-codeblock";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.append(code);
    block.append(pre);
    probe.append(block);
    return code;
  }).fontSize;

const diffsFontSize = (insideReadingArea: boolean) =>
  withProbe(insideReadingArea, (probe) => {
    probe.style.fontSize = "var(--diffs-font-size)";
  }).fontSize;

describe("applyFontScale", () => {
  it("scales only the reading area and composer while keeping root, shell and touch composer fixed", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    try {
      applyFontScale(root, "standard");
      expect(getComputedStyle(root).fontSize).toBe("16px");
      expect(proseMetrics(false).fontSize).toBe("15px");
      expect(codeFontSize(false)).toBe("14px");
      expect(diffsFontSize(false)).toBe("14px");
      expect(proseMetrics(true)).toEqual({ fontSize: "15px", lineHeight: "24px" });
      expect(composerFontSize(true)).toBe("14px");
      expect(codeFontSize(true)).toBe("14px");
      // iOS zooms into inputs under 16px.
      expect(touchComposerFontSize(true)).toBe("16px");

      applyFontScale(root, "comfortable");
      expect(getComputedStyle(root).fontSize).toBe("16px");
      expect(proseMetrics(false).fontSize).toBe("15px");
      expect(codeFontSize(false)).toBe("14px");
      expect(diffsFontSize(false)).toBe("14px");
      expect(proseMetrics(true)).toEqual({ fontSize: "16px", lineHeight: "25.6px" });
      expect(composerFontSize(true)).toBe("14.875px");
      expect(codeFontSize(true)).toBe("15px");
      expect(touchComposerFontSize(true)).toBe("16px");

      applyFontScale(root, "large");
      expect(getComputedStyle(root).fontSize).toBe("16px");
      expect(proseMetrics(false).fontSize).toBe("15px");
      expect(codeFontSize(false)).toBe("14px");
      expect(diffsFontSize(false)).toBe("14px");
      expect(proseMetrics(true)).toEqual({ fontSize: "17px", lineHeight: "27.2px" });
      expect(composerFontSize(true)).toBe("15.75px");
      expect(codeFontSize(true)).toBe("16px");
      expect(touchComposerFontSize(true)).toBe("16px");
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });
});
