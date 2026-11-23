import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_SECTION_LABELS } from "./settingsSearch";
import { isSettingsIndexPath, resolveSettingsPath } from "./settingsPath.logic";

describe("resolveSettingsPath", () => {
  it("treats a path in neither the page list nor the rename table as missing", () => {
    expect(resolveSettingsPath("/settings/commander", "")).toEqual({ kind: "missing" });
    expect(resolveSettingsPath("/settings/commander/", "#section")).toEqual({ kind: "missing" });
    expect(resolveSettingsPath("/settings/general/extra", "")).toEqual({ kind: "missing" });
    expect(resolveSettingsPath("/settings/integrations/extra", "")).toEqual({ kind: "missing" });
  });

  it("sends the settings index home, and integrations and beta to their new pages", () => {
    expect(resolveSettingsPath("/settings", "")).toEqual({
      kind: "redirect",
      to: "/settings/general",
      retainSearch: false,
    });
    expect(resolveSettingsPath("/settings/", "")).toEqual({
      kind: "redirect",
      to: "/settings/general",
      retainSearch: false,
    });
    expect(resolveSettingsPath("/settings", "", { isMobile: true })).toEqual({ kind: "page" });
    expect(resolveSettingsPath("/settings/", "", { isMobile: true })).toEqual({ kind: "page" });
    expect(isSettingsIndexPath("/settings")).toBe(true);
    expect(isSettingsIndexPath("/settings/")).toBe(true);
    expect(isSettingsIndexPath("/settings/general")).toBe(false);
    expect(resolveSettingsPath("/settings/integrations", "")).toEqual({
      kind: "redirect",
      to: "/settings/providers",
      retainSearch: true,
    });
    expect(resolveSettingsPath("/settings/beta", "")).toEqual({
      kind: "redirect",
      to: "/settings/maintenance",
      retainSearch: true,
    });
  });

  it("leaves pages that still render, including folded ones, on the page", () => {
    expect(resolveSettingsPath("/settings/providers", "")).toEqual({ kind: "page" });
    expect(resolveSettingsPath("/settings/Providers", "")).toEqual({ kind: "page" });
    expect(resolveSettingsPath("/settings/diagnostics", "")).toEqual({ kind: "page" });
    expect(resolveSettingsPath("/settings/open-source-licenses", "")).toEqual({ kind: "page" });
    expect(resolveSettingsPath("/settings/general", "time-format")).toEqual({ kind: "page" });
    for (const path of Object.keys(SETTINGS_SECTION_LABELS)) {
      expect(["page", "redirect"]).toContain(resolveSettingsPath(path, "").kind);
    }
  });
});
