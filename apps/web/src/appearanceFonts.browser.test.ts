import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyFontScale } from "./appearanceFonts";

function renderedFontSize(style: (probe: HTMLElement) => void): string {
  const probe = document.createElement("div");
  style(probe);
  document.body.append(probe);
  try {
    return getComputedStyle(probe).fontSize;
  } finally {
    probe.remove();
  }
}

const composerFontSize = () =>
  renderedFontSize((probe) => {
    // The composer editor's own size class.
    probe.className = "text-(length:--font-size-prompt,var(--text-sm))";
  });

const touchComposerFontSize = () =>
  renderedFontSize((probe) => {
    probe.style.fontSize = "var(--font-size-prompt-touch)";
  });

const proseFontSize = () =>
  renderedFontSize((probe) => {
    probe.style.fontSize = "var(--text-prose)";
  });

describe("applyFontScale", () => {
  it("moves the interface, composer and chat prose together, keeping touch inputs at 16px", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    try {
      applyFontScale(root, "standard");
      expect(getComputedStyle(root).fontSize).toBe("16px");
      expect(composerFontSize()).toBe("14px");
      expect(proseFontSize()).toBe("15px");
      // iOS zooms into inputs under 16px.
      expect(touchComposerFontSize()).toBe("16px");

      applyFontScale(root, "large");
      expect(getComputedStyle(root).fontSize).toBe("18px");
      expect(composerFontSize()).toBe("15.75px");
      expect(proseFontSize()).toBe("17px");
      expect(touchComposerFontSize()).toBe("16px");
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });
});
