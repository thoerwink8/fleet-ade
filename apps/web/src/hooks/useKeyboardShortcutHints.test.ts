import { describe, expect, it } from "vite-plus/test";

import {
  KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES,
  shouldHideKeyboardShortcutHints,
  shouldHideKeyboardShortcutHintsFromCapabilities,
} from "./useKeyboardShortcutHints";

describe("useKeyboardShortcutHints", () => {
  it.each([
    {
      name: "shows hints on wide fine-pointer desktop with hover",
      capabilities: { isCoarsePointer: false, lacksHover: false, isMobileViewport: false },
      expected: false,
    },
    {
      name: "hides hints on wide touch tablets with coarse primary pointer",
      capabilities: { isCoarsePointer: true, lacksHover: false, isMobileViewport: false },
      expected: true,
    },
    {
      name: "hides hints when primary input lacks hover",
      capabilities: { isCoarsePointer: false, lacksHover: true, isMobileViewport: false },
      expected: true,
    },
    {
      name: "hides hints on narrow mobile viewports even with fine pointer",
      capabilities: { isCoarsePointer: false, lacksHover: false, isMobileViewport: true },
      expected: true,
    },
    {
      name: "hides hints on phones with coarse pointer, no hover, and narrow viewport",
      capabilities: { isCoarsePointer: true, lacksHover: true, isMobileViewport: true },
      expected: true,
    },
  ])("$name", ({ capabilities, expected }) => {
    expect(shouldHideKeyboardShortcutHintsFromCapabilities(capabilities)).toBe(expected);
  });

  it("evaluates window.matchMedia queries and defaults to false without a window", () => {
    expect(shouldHideKeyboardShortcutHints(undefined)).toBe(false);

    const makeWindow = (matchedQueries: ReadonlySet<string>) => ({
      matchMedia: (query: string) => ({ matches: matchedQueries.has(query) }) as MediaQueryList,
    });

    expect(shouldHideKeyboardShortcutHints(makeWindow(new Set()))).toBe(false);
    expect(
      shouldHideKeyboardShortcutHints(
        makeWindow(new Set([KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.coarsePointer])),
      ),
    ).toBe(true);
    expect(
      shouldHideKeyboardShortcutHints(
        makeWindow(new Set([KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.noHover])),
      ),
    ).toBe(true);
    expect(
      shouldHideKeyboardShortcutHints(
        makeWindow(new Set([KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.mobileViewport])),
      ),
    ).toBe(true);
  });
});
