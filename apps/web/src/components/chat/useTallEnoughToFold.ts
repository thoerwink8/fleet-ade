import { useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";

// The folds clip with `max-h-44`, which is 11rem.
const FOLDED_HEIGHT_REM = 11;

let cachedRootRemPx: number | null = null;
let observingRootFontSize = false;

function readRootRemPx(): number {
  if (cachedRootRemPx !== null) return cachedRootRemPx;
  const root = document.documentElement;
  if (!observingRootFontSize && typeof MutationObserver !== "undefined") {
    observingRootFontSize = true;
    new MutationObserver(() => {
      cachedRootRemPx = null;
    }).observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  }
  const typedFontSize =
    typeof root.computedStyleMap === "function" ? root.computedStyleMap().get("font-size") : null;
  if (
    typedFontSize &&
    "value" in typedFontSize &&
    typeof typedFontSize.value === "number" &&
    Number.isFinite(typedFontSize.value) &&
    typedFontSize.value > 0
  ) {
    cachedRootRemPx = typedFontSize.value;
    return cachedRootRemPx;
  }
  cachedRootRemPx = Number.parseFloat(getComputedStyle(root).fontSize) || 16;
  return cachedRootRemPx;
}

/**
 * Put `ref` on the unclipped content inside a fold. `tallEnough` is true when that content is at
 * least twice the folded height, so opening a fold always at least doubles what was on screen.
 */
export function useTallEnoughToFold(enabled = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [tallEnough, setTallEnough] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the fold depends on the rendered height, which only the DOM knows
  useLayoutEffect(() => {
    const content = ref.current;
    if (!enabled || !content) return;
    const update = (height: number) => {
      setTallEnough(height >= FOLDED_HEIGHT_REM * 2 * readRootRemPx());
    };
    // Measured here too: waiting for the observer would paint one unfolded frame.
    update(content.offsetHeight);
    return observeResize(content, (entries) => {
      const last = entries.at(-1);
      const height =
        last?.borderBoxSize?.[0]?.blockSize ?? last?.contentRect.height ?? content.offsetHeight;
      update(height);
    });
  }, [enabled]);
  return { ref, tallEnough: enabled && tallEnough };
}
