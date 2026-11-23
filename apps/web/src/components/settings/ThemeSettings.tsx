import { cn } from "../../lib/utils";
import { BUILT_IN_THEMES, getThemeDefinition, type ThemeAppearance } from "../../themePalette";
import { notifyThemeSaveFailure } from "../CommandPaletteThemeItems";
import { SettingsSectionHeader } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  STANDARD_THEME_CARD,
  getThemeCardDefinition,
  previewColorsOf,
  ThemePreviewCircle,
  type ThemeCardDefinition,
  type ThemeMode,
} from "./ThemePreviewCircles";
import { ThemeWireframe } from "./ThemeWireframe";

const THEME_CARDS: ReadonlyArray<ThemeCardDefinition & { readonly themeId: string | null }> = [
  { ...STANDARD_THEME_CARD, themeId: null },
  ...BUILT_IN_THEMES.map((definition) => ({
    ...getThemeCardDefinition(definition),
    themeId: definition.id,
  })),
];

const MODE_LABELS: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

/** Mode and palette are independent: the mode picks light or dark, the palette colors both. */
export function ThemeLibrary({
  theme,
  setTheme,
  appearanceMode,
  setAppearanceMode,
}: {
  theme: string;
  setTheme: (theme: string) => boolean;
  appearanceMode: ThemeMode;
  setAppearanceMode: (mode: ThemeMode) => boolean;
}) {
  const activeThemeId = getThemeDefinition(theme)?.id ?? null;
  const activeCard = THEME_CARDS.find((card) => card.themeId === activeThemeId) ?? THEME_CARDS[0]!;

  const wireframeColors = (appearance: ThemeAppearance) =>
    previewColorsOf(activeCard, appearance) ?? activeCard.previews[0]!.colors;

  const pickTheme = (themeId: string | null) => {
    // The standard palette is stored as the plain mode, matching what older builds wrote.
    if (!setTheme(themeId ?? appearanceMode)) notifyThemeSaveFailure();
  };

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="space-y-1.5">
        <SettingsSectionHeader as="h3" title={searchableSetting("color-scheme").title} />
        <div aria-label="外观模式" className="grid w-full grid-cols-3 gap-3" role="group">
          {(["system", "light", "dark"] as const).map((mode) => {
            const isActive = appearanceMode === mode;
            return (
              <button
                aria-label={mode === "system" ? "跟随系统外观" : `使用${MODE_LABELS[mode]}模式`}
                aria-pressed={isActive}
                className={cn(
                  // The accent ring marks the picked tile; focus is a neutral ring set inside it with a gap.
                  "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-7 focus-visible:outline-foreground/60",
                  isActive
                    ? "border-transparent bg-accent/30 ring-2 ring-inset ring-ring"
                    : "border-border/70 bg-card/60 hover:bg-accent/10",
                )}
                key={mode}
                onClick={() => {
                  if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
                }}
                type="button"
              >
                <ThemeWireframe
                  className="h-[8.75rem]"
                  panes={
                    mode === "system"
                      ? [
                          { clip: "left", colors: wireframeColors("light") },
                          { clip: "right", colors: wireframeColors("dark") },
                        ]
                      : [{ colors: wireframeColors(mode) }]
                  }
                />
                <span
                  className={cn(
                    "flex items-center justify-center text-xs font-medium",
                    isActive ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {MODE_LABELS[mode]}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1.5">
        <SettingsSectionHeader as="h3" title={searchableSetting("theme").title} />
        <div
          aria-label="主题"
          className="@container/theme-grid grid w-full grid-cols-3 gap-3"
          role="group"
        >
          {THEME_CARDS.map((card) => {
            const isActive = card.themeId === activeThemeId;
            return (
              <button
                aria-label={`使用 ${card.label} 主题`}
                aria-pressed={isActive}
                className={cn(
                  "flex min-w-0 cursor-pointer flex-col items-center gap-2 rounded-xl border px-2 pb-2.5 pt-3 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-7 focus-visible:outline-foreground/60 @min-[30rem]/theme-grid:px-3 @min-[30rem]/theme-grid:pb-3 @min-[30rem]/theme-grid:pt-4",
                  isActive
                    ? "border-transparent bg-accent/30 ring-2 ring-inset ring-ring"
                    : "border-border/70 bg-card/60 hover:bg-accent/10",
                )}
                data-theme-library-card={card.id}
                key={card.id}
                onClick={() => pickTheme(card.themeId)}
                type="button"
              >
                <span className="flex w-full items-center justify-center gap-1.5 @min-[30rem]/theme-grid:gap-2.5">
                  {card.previews.map((preview) => (
                    <ThemePreviewCircle
                      className="aspect-square h-auto w-full min-w-0 max-w-14 flex-1 shrink"
                      colors={preview.colors}
                      key={preview.mode}
                      mode={preview.mode}
                    />
                  ))}
                </span>
                <span className="text-sm font-medium text-foreground">{card.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
