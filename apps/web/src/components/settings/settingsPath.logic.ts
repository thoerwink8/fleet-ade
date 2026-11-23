import {
  movedSettingsRedirect,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
} from "./settingsSearch";

const SETTINGS_PAGES: ReadonlySet<string> = new Set([
  ...Object.keys(SETTINGS_SECTION_LABELS),
  "/settings/open-source-licenses",
]);

export type SettingsPathDecision =
  | {
      readonly kind: "redirect";
      readonly to: SettingsPath;
      readonly hash?: string;
      readonly retainSearch: boolean;
    }
  | { readonly kind: "page" }
  | { readonly kind: "missing" };

function normalizeSettingsPathname(pathname: string): string {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return trimmed.toLowerCase();
}

export function isSettingsIndexPath(pathname: string): boolean {
  return normalizeSettingsPathname(pathname) === "/settings";
}

export function resolveSettingsPath(
  pathname: string,
  hash: string,
  options?: { readonly isMobile?: boolean },
): SettingsPathDecision {
  const path = normalizeSettingsPathname(pathname);
  if (path === "/settings") {
    if (options?.isMobile) return { kind: "page" };
    return { kind: "redirect", to: "/settings/general", retainSearch: false };
  }
  const moved = movedSettingsRedirect(path, hash.replace(/^#/, ""));
  if (moved) {
    return {
      kind: "redirect",
      to: moved.to,
      retainSearch: true,
      ...(moved.hash ? { hash: moved.hash } : {}),
    };
  }
  if (SETTINGS_PAGES.has(path)) return { kind: "page" };
  if (path.startsWith("/settings/")) return { kind: "missing" };
  return { kind: "page" };
}
