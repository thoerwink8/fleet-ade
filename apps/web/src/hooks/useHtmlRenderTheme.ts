import { htmlRenderTheme } from "@t3tools/shared/htmlRender";

import {
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  themeColorToHex,
  type ThemeAppearance,
  type ThemePreference,
} from "../themePalette";
import { useTheme } from "./useTheme";

function resolveActiveThemeColors(theme: ThemePreference, appearance: ThemeAppearance) {
  const definition = getThemeDefinition(theme);
  return definition === null
    ? getStandardThemeColors(appearance)
    : (getThemeColorsForMode(definition, appearance) ?? definition.colors);
}

export function useHtmlRenderTheme() {
  const { theme, resolvedTheme } = useTheme();
  const colors = resolveActiveThemeColors(theme, resolvedTheme);
  return htmlRenderTheme(
    Object.fromEntries(
      Object.entries(colors).map(([role, color]) => [role, themeColorToHex(color) ?? color]),
    ) as typeof colors,
    resolvedTheme,
  );
}
