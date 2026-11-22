import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_SECTION_LABELS } from "./settingsSearch";
import { resolveSettingsPath } from "./settingsPath.logic";

describe("resolveSettingsPath", () => {
  it("treats a path in neither the page list nor the rename table as missing", () => {
    expect(resolveSettingsPath("/settings/commander", "")).toEqual({ kind: "missing" });
    expect(resolveSettingsPath("/settings/commander/", "#section")).toEqual({ kind: "missing" });
    expect(resolveSettingsPath("/settings/general/extra", "")).toEqual({ kind: "missing" });
    expect(resolveSettingsPath("/settings/integrations/extra", "")).toEqual({ kind: "missing" });
  });

  it("sends the settings index home and keeps renamed paths on their new pages", () => {
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
    expect(resolveSettingsPath("/settings/about", "")).toEqual({
      kind: "redirect",
      to: "/settings/maintenance",
      hash: "about",
      retainSearch: true,
    });
    expect(resolveSettingsPath("/settings/network", "")).toEqual({
      kind: "redirect",
      to: "/settings/general",
      hash: "network",
      retainSearch: true,
    });
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
    expect(resolveSettingsPath("/settings/general", "text-generation-model")).toEqual({
      kind: "redirect",
      to: "/settings/threads",
      hash: "text-generation-model",
      retainSearch: true,
    });
    expect(resolveSettingsPath("/settings/general", "#text-generation-model")).toEqual({
      kind: "redirect",
      to: "/settings/threads",
      hash: "text-generation-model",
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
