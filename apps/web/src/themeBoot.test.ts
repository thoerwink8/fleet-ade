import { describe, expect, it, vi } from "vite-plus/test";

import indexHtml from "../index.html?raw";
import { readAppearanceModePreference, readThemePreference } from "./hooks/useTheme";
import {
  getThemeColorsForMode,
  resolveThemeAppearance,
  EMBER_THEME,
  GROVE_THEME,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  toCanonicalThemeColor,
} from "./themePalette";

const THEME_STORAGE_KEY = "t3code:theme";

const bootScript = (() => {
  const match = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("Could not find the inline boot script in index.html");
  return match[1];
})();

type BootResult = {
  isDark: boolean;
  themeId: string | undefined;
  themeSelected: string | undefined;
  backgroundColor: string;
  bootVariables: Record<string, string>;
  metaContent: string | null;
};

function runBootScript(options: {
  storage?: Record<string, string>;
  storageThrows?: boolean;
  prefersDark: boolean;
}): BootResult {
  const classes = new Set<string>();
  const bootVariables: Record<string, string> = {};
  const meta = {
    content: null as string | null,
    setAttribute(_name: string, value: string) {
      this.content = value;
    },
  };
  const documentElement = {
    dataset: {} as Record<string, string | undefined>,
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
      toggle: (name: string, force?: boolean) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
    },
    style: {
      backgroundColor: "",
      setProperty: (name: string, value: string) => {
        bootVariables[name] = value;
      },
    },
  };
  const fakeDocument = {
    documentElement,
    querySelectorAll: (selector: string) => (selector === 'meta[name="theme-color"]' ? [meta] : []),
  };
  const fakeWindow = {
    localStorage: {
      getItem: (key: string): string | null => {
        if (options.storageThrows) throw new Error("storage blocked");
        return options.storage?.[key] ?? null;
      },
    },
    matchMedia: () => ({ matches: options.prefersDark }),
  };

  const fakeCss = {
    supports: (property: string, value: string) =>
      property === "color" && toCanonicalThemeColor(value) !== null,
  };

  new Function("window", "document", "CSS", bootScript)(fakeWindow, fakeDocument, fakeCss);

  return {
    isDark: classes.has("dark"),
    themeId: documentElement.dataset.themeId,
    themeSelected: documentElement.dataset.themeSelected,
    backgroundColor: documentElement.style.backgroundColor,
    bootVariables,
    metaContent: meta.content,
  };
}

function runtimeResolvedAppearance(
  storage: Record<string, string>,
  prefersDark: boolean,
): "light" | "dark" {
  vi.stubGlobal("window", {
    localStorage: { getItem: (key: string) => storage[key] ?? null },
    matchMedia: () => ({ matches: prefersDark }),
  });
  try {
    return resolveThemeAppearance(readAppearanceModePreference(readThemePreference()), prefersDark);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("index.html boot script", () => {
  const parityCases: ReadonlyArray<{
    name: string;
    storage: Record<string, string>;
    prefersDark: boolean;
  }> = [
    { name: "no stored preference on a dark OS", storage: {}, prefersDark: true },
    {
      name: "Grove follows a dark OS",
      storage: { [THEME_STORAGE_KEY]: "grove", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    {
      name: "an explicit global dark mode applies to Ember",
      storage: {
        [THEME_STORAGE_KEY]: "ember",
        [THEME_APPEARANCE_MODE_STORAGE_KEY]: "dark",
        [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false",
      },
      prefersDark: false,
    },
    {
      name: "a legacy t3-grove preference resolves through the alias",
      storage: { [THEME_STORAGE_KEY]: "t3-grove", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },
      prefersDark: true,
    },
    ...["t3-chat", "ocean", "iris", "t3-chat-dark", "my-custom-theme", "aurora:dark"].map(
      (removed) => ({
        name: `a removed or custom theme (${removed}) falls back to the default`,
        storage: { [THEME_STORAGE_KEY]: removed },
        prefersDark: true,
      }),
    ),
    {
      name: "a corrupted follow-system value falls back to inference",
      storage: { [THEME_STORAGE_KEY]: "system", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "1" },
      prefersDark: true,
    },
    {
      name: "follow-system off keeps an explicit light preference on a dark OS",
      storage: { [THEME_STORAGE_KEY]: "light", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false" },
      prefersDark: true,
    },
    {
      name: "a bare dark preference stays dark on a light OS",
      storage: { [THEME_STORAGE_KEY]: "dark" },
      prefersDark: false,
    },
    {
      name: "follow-system off keeps a bare dark preference on a light OS",
      storage: { [THEME_STORAGE_KEY]: "dark", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "false" },
      prefersDark: false,
    },
  ];

  it.each(parityCases)("matches the runtime appearance: $name", ({ storage, prefersDark }) => {
    const boot = runBootScript({ storage, prefersDark });
    expect(boot.isDark).toBe(runtimeResolvedAppearance(storage, prefersDark) === "dark");
  });

  it("keeps every built-in boot splash in sync with the real palettes", () => {
    for (const theme of [GROVE_THEME, EMBER_THEME]) {
      expect(theme.appearance).toBe("light");
      for (const mode of ["light", "dark"] as const) {
        const colors = getThemeColorsForMode(theme, mode);
        expect(colors).not.toBeNull();
        const boot = runBootScript({
          storage: {
            [THEME_STORAGE_KEY]: theme.id,
            [THEME_APPEARANCE_MODE_STORAGE_KEY]: mode,
          },
          prefersDark: mode === "dark",
        });
        expect(boot.themeId).toBe(theme.id);
        expect(boot.isDark).toBe(mode === "dark");
        expect(boot.bootVariables["--boot-background"]).toBe(colors!.canvas);
        expect(boot.bootVariables["--boot-foreground"]).toBe(colors!.text);
        expect(boot.bootVariables["--boot-accent"]).toBe(colors!.accent);
        expect(boot.backgroundColor).toBe(colors!.chrome);
        expect(boot.metaContent).toBe(colors!.chrome);
      }
    }
  });

  it("paints the default splash for a removed or custom theme, ignoring old custom data", () => {
    for (const removed of ["t3-chat", "ocean", "iris", "aurora"]) {
      const boot = runBootScript({
        storage: {
          [THEME_STORAGE_KEY]: removed,
          [THEME_APPEARANCE_MODE_STORAGE_KEY]: "dark",
          "t3code:themes:v1": JSON.stringify([
            { id: "aurora", label: "Aurora", appearance: "dark", colors: { canvas: "#101827" } },
          ]),
          "t3code:theme-halves:v1": JSON.stringify({ dark: "aurora" }),
        },
        prefersDark: false,
      });
      expect(boot.isDark).toBe(true);
      expect(boot.themeId).toBeUndefined();
      expect(boot.themeSelected).toBeUndefined();
      expect(boot.backgroundColor).toBe("#000000");
      expect(boot.metaContent).toBe("#000000");
    }
  });

  it("follows the OS appearance when storage is unavailable", () => {
    const light = runBootScript({ storageThrows: true, prefersDark: false });
    expect(light.isDark).toBe(false);
    expect(light.themeId).toBeUndefined();

    const dark = runBootScript({ storageThrows: true, prefersDark: true });
    expect(dark.isDark).toBe(true);
  });
});
