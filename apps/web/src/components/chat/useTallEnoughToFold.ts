import { useLayoutEffect, useRef, useState } from "react";

import { READING_FONT_SCALES, SHELL_BASE_FONT_SIZE_PX } from "~/appearanceFonts";
import { observeResize } from "~/lib/observeResize";
import {
  isTallEnoughToFold,
  parseCssLengthPx,
  parseLineHeightMultiplier,
  resolveFoldThresholdPx,
} from "./useTallEnoughToFold.logic";

function readFoldThresholdPx(content: HTMLElement): number {
  const rootRemPx =
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
    SHELL_BASE_FONT_SIZE_PX;
  const styles = getComputedStyle(content);
  const proseFontSizePx =
    parseCssLengthPx(styles.getPropertyValue("--font-size-prose"), rootRemPx) ??
    parseCssLengthPx(styles.fontSize, rootRemPx) ??
    READING_FONT_SCALES.standard.prose;
  const proseLineHeight =
    parseLineHeightMultiplier(styles.getPropertyValue("--line-height-prose"), proseFontSizePx) ??
    parseLineHeightMultiplier(styles.lineHeight, proseFontSizePx) ??
    READING_FONT_SCALES.standard.proseLineHeight;
  return resolveFoldThresholdPx({ proseFontSizePx, proseLineHeight });
}

/**
 * Put `ref` on the unclipped content inside a fold. `tallEnough` is true when that content is at
 * least twice the folded height, so opening a fold always at least doubles what was on screen.
 */
export function useTallEnoughToFold(enabled = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [tallEnough, setTallEnough] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the fold depends on the rendered height and reading typography tokens, which only the DOM knows
  useLayoutEffect(() => {
    const content = ref.current;
    if (!enabled || !content) return;
    const update = (height: number) => {
      setTallEnough(isTallEnoughToFold(height, readFoldThresholdPx(content)));
    };
    // Measured here too: waiting for the observer would paint one unfolded frame.
    update(content.offsetHeight);
    const stopResize = observeResize(content, (entries) => {
      const last = entries.at(-1);
      const height =
        last?.borderBoxSize?.[0]?.blockSize ?? last?.contentRect.height ?? content.offsetHeight;
      update(height);
    });
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            update(content.offsetHeight);
          })
        : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    return () => {
      stopResize();
      observer?.disconnect();
    };
  }, [enabled]);
  return { ref, tallEnough: enabled && tallEnough };
}
