import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand } from "../keybindings";
import { shortcutCheatsheetGroups } from "./ShortcutCheatsheet.logic";
import { commandLabel } from "./settings/KeybindingsSettings.logic";

const LINUX = "Linux x86_64";

function press(key: string, extra: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  return {
    key,
    code: "Slash",
    ctrlKey: extra.ctrlKey ?? false,
    metaKey: extra.metaKey ?? false,
    altKey: false,
    shiftKey: false,
  };
}

describe("shortcut cheatsheet", () => {
  it("binds mod+/ by default and keeps it while a terminal or a text field is focused", () => {
    const binding = DEFAULT_KEYBINDINGS.find(
      (entry) => entry.command === "shortcutCheatsheet.toggle",
    );
    expect(binding).toEqual({ key: "mod+/", command: "shortcutCheatsheet.toggle" });

    const contexts = [
      {},
      { terminalFocus: true },
      { editableFocus: true },
      { composerFocus: true },
    ];
    for (const context of contexts) {
      expect(
        resolveShortcutCommand(press("/", { ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
          platform: LINUX,
          context,
        }),
      ).toBe("shortcutCheatsheet.toggle");
    }
    expect(
      resolveShortcutCommand(press("/", { metaKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
      }),
    ).toBe("shortcutCheatsheet.toggle");
  });

  it("is a command the palette can offer, grouped and named like the settings page", () => {
    expect(STATIC_KEYBINDING_COMMANDS).toContain("shortcutCheatsheet.toggle");
    expect(commandLabel("shortcutCheatsheet.toggle")).toBe("快捷键速查");

    const groups = shortcutCheatsheetGroups(DEFAULT_RESOLVED_KEYBINDINGS, LINUX);
    const navigation = groups.find((group) => group.id === "navigation");
    expect(
      navigation?.entries.find((entry) => entry.command === "shortcutCheatsheet.toggle"),
    ).toMatchObject({ label: "快捷键速查", keys: ["Ctrl+/"] });
  });

  it("lists only bound commands and follows a saved binding", () => {
    const groups = shortcutCheatsheetGroups(DEFAULT_RESOLVED_KEYBINDINGS, LINUX);
    const entries = groups.flatMap((group) => group.entries);
    expect(entries.every((entry) => entry.keys.length > 0)).toBe(true);
    // No default key, and the saved binding is only a modifier, which compile drops.
    expect(entries.map((entry) => entry.command)).not.toContain("composer.cycleHost");

    const custom = shortcutCheatsheetGroups(
      mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([
          { key: "mod+shift+/", command: "shortcutCheatsheet.toggle" },
          { key: "mod", command: "composer.cycleHost" },
        ]),
      ),
      LINUX,
    );
    const commands = custom.flatMap((group) => group.entries.map((entry) => entry.command));
    expect(commands).not.toContain("composer.cycleHost");
    const navigation = custom.find((group) => group.id === "navigation");
    expect(
      navigation?.entries.find((entry) => entry.command === "shortcutCheatsheet.toggle")?.keys,
    ).toEqual(["Ctrl+Shift+/"]);
  });

  it("names the other command when a saved binding takes its key", () => {
    const groups = shortcutCheatsheetGroups(
      mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([{ key: "mod+/", command: "sidebar.toggle" }]),
      ),
      LINUX,
    );
    const entries = groups.flatMap((group) => group.entries);
    const sidebar = entries.find((entry) => entry.command === "sidebar.toggle");
    const cheatsheet = entries.find((entry) => entry.command === "shortcutCheatsheet.toggle");
    expect(sidebar?.conflicts).toContain("快捷键速查");
    expect(cheatsheet?.conflicts).toContain(commandLabel("sidebar.toggle"));
  });
});
