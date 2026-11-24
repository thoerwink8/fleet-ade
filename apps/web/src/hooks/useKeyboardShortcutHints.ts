import { useMediaQuery } from "./useMediaQuery";

export const KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES = {
  coarsePointer: "(pointer: coarse)",
  noHover: "(hover: none)",
  mobileViewport: "(max-width: 639px)",
} as const;

export interface KeyboardShortcutHintCapabilities {
  readonly isCoarsePointer: boolean;
  readonly lacksHover: boolean;
  readonly isMobileViewport: boolean;
}

/**
 * Pure decision rule for hiding keyboard shortcut hints on touch-first or narrow
 * viewports. Shortcuts themselves continue working when a hardware keyboard is
 * connected; only inline visual hints (Kbd badges, tooltip chords, footer
 * legends) are suppressed so touch screens stay uncluttered.
 */
export function shouldHideKeyboardShortcutHintsFromCapabilities(
  capabilities: KeyboardShortcutHintCapabilities,
): boolean {
  return capabilities.isCoarsePointer || capabilities.lacksHover || capabilities.isMobileViewport;
}

/** Non-React snapshot check for imperative helpers such as toast notices. */
export function shouldHideKeyboardShortcutHints(
  win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window,
): boolean {
  if (!win) return false;
  return shouldHideKeyboardShortcutHintsFromCapabilities({
    isCoarsePointer: win.matchMedia(KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.coarsePointer).matches,
    lacksHover: win.matchMedia(KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.noHover).matches,
    isMobileViewport: win.matchMedia(KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.mobileViewport).matches,
  });
}

/** Reactive single source of truth for hiding keyboard shortcut hints across the app. */
export function useHideKeyboardShortcutHints(): boolean {
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const lacksHover = useMediaQuery(KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.noHover);
  const isMobileViewport = useMediaQuery("max-sm");
  return shouldHideKeyboardShortcutHintsFromCapabilities({
    isCoarsePointer,
    lacksHover,
    isMobileViewport,
  });
}

/** Returns `label` when keyboard hints are shown, or `null` when hidden on touch/narrow viewports. */
export function useVisibleShortcutLabel(label: string | null | undefined): string | null {
  const hide = useHideKeyboardShortcutHints();
  return hide ? null : (label ?? null);
}
