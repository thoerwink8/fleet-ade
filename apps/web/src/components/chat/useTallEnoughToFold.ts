import { type CSSProperties, type Ref, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";

// Folds clip with `max-h-44` (11rem). The probe is twice that and clipped to the content, so it
// reaches this height only when a fold hides at least as much as it shows. Compare in px against
// the live root font size: the interface scale is 16, 17, or 18.
const FOLD_MIN_HEIGHT = "22rem";

// One read per inline font-size. A computed-style read per row blows the cold-open budget.
let cachedRootRem: { readonly key: string; readonly px: number } | null = null;

function rootRemPx(): number {
  const root = document.documentElement;
  const key = root.style.fontSize;
  if (cachedRootRem?.key === key) return cachedRootRem.px;
  const parsed = Number.parseFloat(getComputedStyle(root).fontSize);
  const px = Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
  cachedRootRem = { key, px };
  return px;
}

const PROBE_STYLE: CSSProperties = {
  position: "absolute",
  insetInlineStart: 0,
  insetBlockStart: 0,
  inlineSize: "1px",
  blockSize: FOLD_MIN_HEIGHT,
  maxBlockSize: "100%",
  overflow: "clip",
  visibility: "hidden",
  pointerEvents: "none",
};

export interface TallEnoughToFold {
  readonly ref: Ref<HTMLDivElement>;
  readonly tallEnough: boolean;
  /** Goes on the probe rendered right after the measured content. */
  readonly probeProps: { readonly ref: Ref<HTMLDivElement>; readonly style: CSSProperties };
}

const NO_REF: Ref<HTMLDivElement> = () => {};

const DISABLED: TallEnoughToFold = {
  ref: NO_REF,
  tallEnough: false,
  probeProps: { ref: NO_REF, style: { display: "none" } },
};

/** The probe's box must stay unclipped. Clipping it shrinks the probe and drops the fold. */
export function useTallEnoughToFold(enabled = true): TallEnoughToFold {
  const [tallEnough, setTallEnough] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  // Stable identity: a fresh ref every render would re-observe and flushSync the row.
  const ref = useStableCallback((node: HTMLDivElement | null) => {
    stopRef.current?.();
    stopRef.current = null;
    if (node === null) return;
    stopRef.current = observeResize(node, (entries) => {
      const last = entries.at(-1);
      const height = last?.borderBoxSize?.[0]?.blockSize ?? last?.contentRect.height ?? 0;
      setTallEnough(height >= 22 * rootRemPx() - 0.5);
    });
  });
  if (!enabled) return DISABLED;
  return {
    ref,
    tallEnough,
    probeProps: { ref, style: PROBE_STYLE },
  };
}
