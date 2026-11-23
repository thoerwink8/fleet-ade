import { type CSSProperties, type Ref, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";

// The folds clip with `max-h-44`, which is 11rem. A fold only earns its control when it hides at
// least as much as it shows, so the content has to reach twice that.
const FOLD_MIN_HEIGHT = "calc(22rem + 1px)";

// The same threshold in px at the 16px root the app renders with. The probe is exactly this tall,
// so a reported size below it means the content clipped it.
const FOLD_MIN_HEIGHT_PX = 22 * 16 + 1;

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

/** Probe clipped to the content height; it reaches the threshold only when a fold hides at least as much as it shows. */
export function useTallEnoughToFold(enabled = true): TallEnoughToFold {
  const [tallEnough, setTallEnough] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  // Stable identity: a fresh ref every render would re-observe and flushSync the row.
  const ref = useStableCallback((node: HTMLDivElement | null) => {
    stopRef.current?.();
    stopRef.current = null;
    if (node === null) return;
    const stop = observeResize(node, (entries) => {
      const last = entries.at(-1);
      const height = last?.borderBoxSize?.[0]?.blockSize ?? last?.contentRect.height ?? 0;
      if (height < FOLD_MIN_HEIGHT_PX) return;
      stop();
      if (stopRef.current === stop) stopRef.current = null;
      setTallEnough(true);
    });
    stopRef.current = stop;
  });
  if (!enabled) return DISABLED;
  return {
    ref,
    tallEnough,
    probeProps: { ref, style: PROBE_STYLE },
  };
}
