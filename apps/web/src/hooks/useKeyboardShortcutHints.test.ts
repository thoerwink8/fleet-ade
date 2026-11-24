import { describe, expect, it } from "vite-plus/test";

import {
  KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES,
  shouldHideKeyboardShortcutHints,
  shouldHideKeyboardShortcutHintsFromCapabilities,
} from "./useKeyboardShortcutHints";

describe("useKeyboardShortcutHints", () => {
  it.each([
    {
      name: "shows hints on a desktop with a mouse",
      capabilities: { isCoarsePointer: false, hasFinePointer: true },
      expected: false,
    },
    {
      name: "shows hints on a touch laptop whose primary pointer is fine",
      capabilities: { isCoarsePointer: false, hasFinePointer: true },
      expected: false,
    },
    {
      name: "hides hints on a touch-only phone or tablet",
      capabilities: { isCoarsePointer: true, hasFinePointer: false },
      expected: true,
    },
    {
      name: "shows hints on a touch tablet with a trackpad or mouse attached",
      capabilities: { isCoarsePointer: true, hasFinePointer: true },
      expected: false,
    },
    {
      name: "shows hints when no pointer is reported at all",
      capabilities: { isCoarsePointer: false, hasFinePointer: false },
      expected: false,
    },
  ])("$name", ({ capabilities, expected }) => {
    expect(shouldHideKeyboardShortcutHintsFromCapabilities(capabilities)).toBe(expected);
  });

  it("evaluates window.matchMedia queries and defaults to showing without a window", () => {
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
        makeWindow(
          new Set([
            KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.coarsePointer,
            KEYBOARD_SHORTCUT_HINT_MEDIA_QUERIES.anyFinePointer,
          ]),
        ),
      ),
    ).toBe(false);
  });
});
