import { create } from "zustand";

export interface PreparingComposerImage {
  readonly id: string;
  readonly name: string;
  /** The uncompressed source, thumbnailed so the placeholder shows the image itself. */
  readonly file: File;
  /** Looks like an image the draft already has: it holds its slot but shows no tile. */
  readonly hidden: boolean;
}

export interface PreparingComposerImageFailure {
  readonly sequence: number;
  readonly fileName: string;
  readonly reason: "unreadable" | "too-large";
}

const NO_PREPARING_IMAGES: ReadonlyArray<PreparingComposerImage> = [];
let nextImageFailureSequence = 0;

/**
 * Images accepted into a draft but still being compressed, keyed by attachment target. Large
 * screenshots take a noticeable moment to re-encode, so the strip shows these right away and
 * they hold their attachment slots until the real image joins the draft.
 */
const usePreparingComposerImageStore = create<{
  readonly byTargetKey: Readonly<Record<string, ReadonlyArray<PreparingComposerImage>>>;
  readonly lastFailureByTargetKey: Readonly<Record<string, PreparingComposerImageFailure>>;
}>(() => ({ byTargetKey: {}, lastFailureByTargetKey: {} }));

export function usePreparingComposerImages(targetKey: string) {
  return usePreparingComposerImageStore(
    (state) => state.byTargetKey[targetKey] ?? NO_PREPARING_IMAGES,
  );
}

export function usePreparingComposerImageFailure(
  targetKey: string,
): PreparingComposerImageFailure | null {
  return usePreparingComposerImageStore((state) => state.lastFailureByTargetKey[targetKey] ?? null);
}

export function getPreparingComposerImages(
  targetKey: string,
): ReadonlyArray<PreparingComposerImage> {
  return usePreparingComposerImageStore.getState().byTargetKey[targetKey] ?? NO_PREPARING_IMAGES;
}

export function getPreparingComposerImageFailure(
  targetKey: string,
): PreparingComposerImageFailure | null {
  return usePreparingComposerImageStore.getState().lastFailureByTargetKey[targetKey] ?? null;
}

export function countPreparingComposerImages(targetKey: string): number {
  return getPreparingComposerImages(targetKey).length;
}

export function addPreparingComposerImages(
  targetKey: string,
  images: ReadonlyArray<PreparingComposerImage>,
): void {
  usePreparingComposerImageStore.setState((state) => ({
    byTargetKey: {
      ...state.byTargetKey,
      [targetKey]: [...(state.byTargetKey[targetKey] ?? NO_PREPARING_IMAGES), ...images],
    },
  }));
}

export function recordPreparingComposerImageFailure(
  targetKey: string,
  failure: {
    readonly fileName: string;
    readonly reason: "unreadable" | "too-large";
  },
): void {
  const entry: PreparingComposerImageFailure = {
    sequence: ++nextImageFailureSequence,
    fileName: failure.fileName,
    reason: failure.reason,
  };
  usePreparingComposerImageStore.setState((state) => ({
    lastFailureByTargetKey: {
      ...state.lastFailureByTargetKey,
      [targetKey]: entry,
    },
  }));
}

export function isPreparingComposerImage(targetKey: string, imageId: string): boolean {
  return (
    usePreparingComposerImageStore
      .getState()
      .byTargetKey[targetKey]?.some((image) => image.id === imageId) ?? false
  );
}

/** Returns the ids that were still preparing; any other id was cancelled from the strip. */
export function removePreparingComposerImages(
  targetKey: string,
  imageIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const current =
    usePreparingComposerImageStore.getState().byTargetKey[targetKey] ?? NO_PREPARING_IMAGES;
  const removed = new Set(
    current.filter((image) => imageIds.has(image.id)).map((image) => image.id),
  );
  if (removed.size === 0) return removed;
  usePreparingComposerImageStore.setState((state) => {
    const remaining = (state.byTargetKey[targetKey] ?? NO_PREPARING_IMAGES).filter(
      (image) => !removed.has(image.id),
    );
    const byTargetKey = { ...state.byTargetKey };
    if (remaining.length > 0) {
      byTargetKey[targetKey] = remaining;
    } else {
      delete byTargetKey[targetKey];
    }
    return { byTargetKey };
  });
  return removed;
}

export function whenPreparingComposerImagesIdle(
  targetKey: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (countPreparingComposerImages(targetKey) === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    };
    const unsubscribe = usePreparingComposerImageStore.subscribe(() => {
      if (settled || countPreparingComposerImages(targetKey) > 0) return;
      settled = true;
      cleanup();
      resolve(true);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (countPreparingComposerImages(targetKey) === 0 && !settled) {
      settled = true;
      cleanup();
      resolve(true);
    }
  });
}
