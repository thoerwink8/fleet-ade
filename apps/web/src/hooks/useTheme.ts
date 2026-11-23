import type { DesktopBridge } from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import {
  applyThemePalette,
  canonicalThemePreference,
  getThemePreferenceMode,
  isKnownThemePreference,
  resolveThemeAppearance,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  ThemePreference,
  type ThemeAppearance,
  type ThemePreferenceMode,
} from "../themePalette";

type Theme = ThemePreference;
type ThemeSnapshot = {
  theme: Theme;
  resolvedTheme: ThemeAppearance;
  systemDark: boolean;
  appearanceMode: ThemePreferenceMode;
};

type DesktopThemeBridge = Pick<DesktopBridge, "setTheme">;

const STORAGE_KEY = "t3code:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  resolvedTheme: "light",
  systemDark: false,
  appearanceMode: "system",
};

const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

export class ThemeStorageError extends Schema.TaggedError<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

const isThemeStorageError = Schema.is(ThemeStorageError);

export class DesktopThemeSyncError extends Schema.TaggedError<DesktopThemeSyncError>()(
  "DesktopThemeSyncError",
  {
    theme: ThemePreference,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sync the ${this.theme} theme to the desktop shell.`;
  }
}

const isDesktopThemeSyncError = Schema.is(DesktopThemeSyncError);

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let snapshotStale = true;
let lastDesktopTheme: ThemePreferenceMode | null = null;
let lastAppliedTheme: Omit<ThemeSnapshot, "resolvedTheme"> | null = null;
let themeStorageReadFailure: ThemeStorageError | null = null;

function emitChange() {
  snapshotStale = true;
  for (const listener of listeners) listener();
}

function getSystemDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

function readStoredFollowSystem(theme: Theme): boolean {
  if (typeof window === "undefined") return theme === "system";

  try {
    const raw = window.localStorage.getItem(THEME_FOLLOW_SYSTEM_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {}

  return theme === "system";
}

function isThemePreferenceMode(value: string | null): value is ThemePreferenceMode {
  return value === "light" || value === "dark" || value === "system";
}

export function readAppearanceModePreference(theme: Theme): ThemePreferenceMode {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY);
      if (isThemePreferenceMode(raw)) return raw;
    } catch {}
  }

  if (readStoredFollowSystem(theme)) return "system";
  return getThemePreferenceMode(theme) ?? "light";
}

function writeAppearanceModePreference(appearanceMode: ThemePreferenceMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_APPEARANCE_MODE_STORAGE_KEY, appearanceMode);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: THEME_APPEARANCE_MODE_STORAGE_KEY,
      cause,
    });
  }
}

/** A stored theme that is no longer built in (a removed palette or an old custom one) reads as the default. */
export function readThemePreference(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT.theme;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: STORAGE_KEY,
      cause,
    });
  }
  if (raw !== null && isKnownThemePreference(canonicalThemePreference(raw))) {
    return canonicalThemePreference(raw);
  }
  return DEFAULT_THEME_SNAPSHOT.theme;
}

function writeThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
    themeStorageReadFailure = null;
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: STORAGE_KEY,
      theme,
      cause,
    });
  }
}

function getStored(): Theme {
  if (themeStorageReadFailure !== null) {
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
  try {
    return readThemePreference();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "read",
          storageKey: STORAGE_KEY,
          cause,
        });
    themeStorageReadFailure = error;
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const rootStyles = getComputedStyle(document.documentElement);
  const themeChromeColor = document.documentElement.dataset.themeId
    ? normalizeThemeColor(rootStyles.getPropertyValue("--app-chrome-background"))
    : null;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = themeChromeColor ?? surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  const themeColorMetas = document.querySelectorAll<HTMLMetaElement>(
    `meta[name="${THEME_COLOR_META_NAME}"]`,
  );
  if (themeColorMetas.length === 0) {
    ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
    return;
  }
  for (const element of themeColorMetas) {
    element.setAttribute("content", backgroundColor);
  }
}

function applyTheme(theme: Theme, { suppressTransitions = false } = {}) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const appearanceMode = readAppearanceModePreference(theme);
  const systemDark = appearanceMode === "system" ? getSystemDark() : false;
  if (
    lastAppliedTheme?.theme === theme &&
    lastAppliedTheme.systemDark === systemDark &&
    lastAppliedTheme.appearanceMode === appearanceMode
  ) {
    syncDesktopTheme(theme, appearanceMode);
    return;
  }

  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  const resolvedAppearance = resolveThemeAppearance(appearanceMode, systemDark);
  applyThemePalette(theme, resolvedAppearance);
  // fleet-design's token sheet swaps its --fa-* variables on html[data-theme].
  document.documentElement.dataset.theme = resolvedAppearance;
  document.documentElement.classList.toggle("dark", resolvedAppearance === "dark");
  lastAppliedTheme = { theme, systemDark, appearanceMode };
  syncBrowserChromeTheme();
  syncDesktopTheme(theme, appearanceMode);
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    void document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

async function syncDesktopThemePreference(
  bridge: DesktopThemeBridge,
  theme: Theme,
  appearanceMode: ThemePreferenceMode,
): Promise<void> {
  try {
    await bridge.setTheme(appearanceMode);
  } catch (cause) {
    throw new DesktopThemeSyncError({ theme, cause });
  }
}

function syncDesktopTheme(theme: Theme, appearanceMode: ThemePreferenceMode) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.setTheme !== "function" || lastDesktopTheme === appearanceMode) {
    return;
  }

  lastDesktopTheme = appearanceMode;
  void syncDesktopThemePreference(bridge, theme, appearanceMode).catch((cause: unknown) => {
    const error = isDesktopThemeSyncError(cause)
      ? cause
      : new DesktopThemeSyncError({ theme, cause });
    console.error(error.message, {
      theme: error.theme,
      ...safeErrorLogAttributes(error),
    });
    if (lastDesktopTheme === appearanceMode) {
      lastDesktopTheme = null;
    }
  });
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT;
  // Cache localStorage reads until signalled; useTheme calls this every render.
  if (!snapshotStale && lastSnapshot) return lastSnapshot;
  snapshotStale = false;
  const theme = getStored();
  const appearanceMode = readAppearanceModePreference(theme);
  const systemDark = appearanceMode === "system" ? getSystemDark() : false;
  const resolvedTheme = resolveThemeAppearance(appearanceMode, systemDark);
  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.resolvedTheme === resolvedTheme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.appearanceMode === appearanceMode
  ) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, resolvedTheme, systemDark, appearanceMode };
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function handleSystemAppearanceChange() {
  const storedTheme = getStored();
  if (readAppearanceModePreference(storedTheme) === "system") {
    applyTheme(storedTheme, { suppressTransitions: true });
  }
  emitChange();
}

function handleStorageChange(e: StorageEvent) {
  if (
    e.key === STORAGE_KEY ||
    e.key === THEME_FOLLOW_SYSTEM_STORAGE_KEY ||
    e.key === THEME_APPEARANCE_MODE_STORAGE_KEY ||
    e.key === null
  ) {
    if (e.key === STORAGE_KEY || e.key === null) themeStorageReadFailure = null;
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  }
}

let removeWindowListeners: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  if (!removeWindowListeners) {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
    mq?.addEventListener("change", handleSystemAppearanceChange);
    window.addEventListener("storage", handleStorageChange);
    removeWindowListeners = () => {
      mq?.removeEventListener("change", handleSystemAppearanceChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    if (listeners.length === 0) {
      removeWindowListeners?.();
      removeWindowListeners = null;
    }
  };
}

/** For shortcuts and other handlers outside React that read the theme at event time. */
export function getThemeSnapshot(): ThemeSnapshot {
  return getSnapshot();
}

/** For code outside React (worker pools) that follows the rendered appearance. */
export function subscribeRenderedAppearance(listener: () => void): () => void {
  return subscribe(listener);
}

export function getRenderedAppearance(): ThemeAppearance {
  return getSnapshot().resolvedTheme;
}

export function useRenderedAppearance() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot).resolvedTheme;
}

export function setTheme(next: Theme): boolean {
  if (typeof window === "undefined") return false;
  try {
    // Save the current mode first; a legacy "dark" theme id would otherwise read as light.
    writeAppearanceModePreference(readAppearanceModePreference(getStored()));
    writeThemePreference(next);
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "write",
          storageKey: STORAGE_KEY,
          theme: next,
          cause,
        });
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      theme: next,
      ...safeErrorLogAttributes(error),
    });
    return false;
  }
  applyTheme(next, { suppressTransitions: true });
  emitChange();
  return true;
}

export function setAppearanceMode(nextAppearanceMode: ThemePreferenceMode): boolean {
  if (typeof window === "undefined") return false;
  try {
    writeAppearanceModePreference(nextAppearanceMode);
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "write",
          storageKey: THEME_APPEARANCE_MODE_STORAGE_KEY,
          cause,
        });
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return false;
  }
  themeStorageReadFailure = null;
  applyTheme(getStored(), { suppressTransitions: true });
  emitChange();
  return true;
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    theme: snapshot.theme,
    setTheme,
    setAppearanceMode,
    appearanceMode: snapshot.appearanceMode,
    resolvedTheme: snapshot.resolvedTheme,
  } as const;
}
