import { useMediaQuery } from "./useMediaQuery";

export const KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES = {
  coarsePointer: "(pointer: coarse)",
  anyFinePointer: "(any-pointer: fine)",
} as const;

export interface KeyboardShortcutHintCapabilities {
  /** The primary pointer is a finger (`pointer: coarse`). */
  readonly isCoarsePointer: boolean;
  /** Some attached device is a mouse, trackpad or pen (`any-pointer: fine`). */
  readonly hasFinePointer: boolean;
}

/**
 * Hide key hints only when the primary pointer is a finger and no mouse or
 * trackpad is attached (a tablet with a keyboard cover reports one). Never use
 * screen width: a narrow desktop window still has a keyboard.
 */
export function shouldHideKeyboardShortcutHintsFromCapabilities(
  capabilities: KeyboardShortcutHintCapabilities,
): boolean {
  return capabilities.isCoarsePointer && !capabilities.hasFinePointer;
}

/** Non-React snapshot check for imperative helpers such as toast notices. */
export function shouldHideKeyboardShortcutHints(
  win: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window,
): boolean {
  if (!win) return false;
  return shouldHideKeyboardShortcutHintsFromCapabilities({
    isCoarsePointer: win.matchMedia(KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.coarsePointer).matches,
    hasFinePointer: win.matchMedia(KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.anyFinePointer).matches,
  });
}

/** Reactive single source of truth for hiding keyboard shortcut hints across the app. */
export function useHideKeyboardShortcutHints(): boolean {
  const isCoarsePointer = useMediaQuery(KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.coarsePointer);
  const hasFinePointer = useMediaQuery(KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.anyFinePointer);
  return shouldHideKeyboardShortcutHintsFromCapabilities({ isCoarsePointer, hasFinePointer });
}

/** Returns `label` when keyboard hints are shown, or `null` on devices without a keyboard. */
export function useVisibleShortcutLabel(label: string | null | undefined): string | null {
  const hide = useHideKeyboardShortcutHints();
  return hide ? null : (label ?? null);
}
