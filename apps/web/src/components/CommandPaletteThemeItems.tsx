import { MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";

import { useTheme } from "../hooks/useTheme";
import { BUILT_IN_THEMES, getThemeDefinition } from "../themePalette";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  STANDARD_THEME_CARD,
  getThemeCardDefinition,
  ThemePreviewCircle,
} from "./settings/ThemePreviewCircles";
import { stackedThreadToast, toastManager } from "./ui/toast";

export const APPEARANCE_OPTIONS = [
  { mode: "system", label: "跟随系统", icon: MonitorIcon },
  { mode: "light", label: "浅色", icon: SunIcon },
  { mode: "dark", label: "深色", icon: MoonIcon },
] as const;

export function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "无法保存主题选择",
      description: "请重试。",
    }),
  );
}

const THEME_CARDS = [
  { ...STANDARD_THEME_CARD, id: null },
  ...BUILT_IN_THEMES.map(getThemeCardDefinition),
];

export function useCommandPaletteThemeItems() {
  const { theme, appearanceMode, setAppearanceMode, setTheme } = useTheme();
  const activeThemeId = getThemeDefinition(theme)?.id ?? null;

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: "切换主题",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: "切换主题",
        items: THEME_CARDS.map(({ id, label, previews }) => ({
          kind: "action",
          value: id === null ? "theme:standard" : `theme:palette:${id}`,
          title: label,
          searchTerms: [label, "theme", "appearance"],
          icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: (
            <span className="flex shrink-0 items-center gap-2">
              {activeThemeId === id ? <span className="st">当前</span> : null}
              <span className="flex items-center gap-1" aria-hidden>
                {previews.map((preview) => (
                  <ThemePreviewCircle
                    key={preview.mode}
                    colors={preview.colors}
                    mode={preview.mode}
                    className="size-3 border-0"
                  />
                ))}
              </span>
            </span>
          ),
          run: async () => {
            if (!setTheme(id ?? appearanceMode)) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
    title: "切换外观",
    icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: "切换外观",
        items: APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => ({
          kind: "action",
          value: `appearance:${mode}`,
          title: label,
          searchTerms: [label, "appearance", "mode"],
          icon: <Icon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            appearanceMode === mode ? <span className="st">当前</span> : undefined,
          run: async () => {
            if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };

  return { changeThemeItem, changeAppearanceItem };
}
