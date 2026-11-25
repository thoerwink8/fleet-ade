import { useLayoutEffect, useRef, useState } from "react";

import { READING_FONT_SCALES, SHELL_BASE_FONT_SIZE_PX } from "~/appearanceFonts";
import { observeResize } from "~/lib/observeResize";
import {
  isTallEnoughToFold,
  parseCssLengthPx,
  parseLineHeightMultiplier,
  resolveFoldThresholdPx,
} from "./useTallEnoughToFold.logic";

let cachedRootRemPx: number | null = null;
let cachedThresholdByScope = new WeakMap<Element, number>();
let observingDocumentRoot = false;
const rootMutationSubscribers = new Set<() => void>();

function ensureDocumentRootObserver(): void {
  if (observingDocumentRoot || typeof MutationObserver === "undefined") return;
  observingDocumentRoot = true;
  new MutationObserver(() => {
    cachedRootRemPx = null;
    cachedThresholdByScope = new WeakMap();
    for (const notify of rootMutationSubscribers) notify();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class"],
  });
}

function readRootRemPx(): number {
  if (cachedRootRemPx !== null) return cachedRootRemPx;
  cachedRootRemPx =
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
    SHELL_BASE_FONT_SIZE_PX;
  return cachedRootRemPx;
}

function measureFoldThresholdPx(content: HTMLElement): number {
  const rootRemPx = readRootRemPx();
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

function readFoldThresholdPx(content: HTMLElement): number {
  ensureDocumentRootObserver();
  if (content.style.getPropertyValue("--font-size-prose").trim().length > 0) {
    return measureFoldThresholdPx(content);
  }
  const scope = content.closest("[data-reading-area]") ?? document.documentElement;
  const cached = cachedThresholdByScope.get(scope);
  if (cached !== undefined) return cached;
  const measured = measureFoldThresholdPx(content);
  cachedThresholdByScope.set(scope, measured);
  return measured;
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
    const onRootMutation = () => {
      update(content.offsetHeight);
    };
    rootMutationSubscribers.add(onRootMutation);
    return () => {
      stopResize();
      rootMutationSubscribers.delete(onRootMutation);
    };
  }, [enabled]);
  return { ref, tallEnough: enabled && tallEnough };
}
