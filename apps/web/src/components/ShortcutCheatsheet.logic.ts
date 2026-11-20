import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { formatShortcutLabel } from "../keybindings";
import {
  buildKeybindingRows,
  commandLabel,
  groupKeybindingRows,
  type KeybindingRow,
} from "./settings/KeybindingsSettings.logic";

export interface ShortcutCheatsheetEntry {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly label: string;
  readonly keys: ReadonlyArray<string>;
  /** Commands whose binding shares this one's key and can be active at the same time. */
  readonly conflicts: ReadonlyArray<string>;
}

export interface ShortcutCheatsheetGroup {
  readonly id: string;
  readonly title: string;
  readonly entries: ReadonlyArray<ShortcutCheatsheetEntry>;
}

/**
 * Groups the bound commands the way the settings page does, from the default
 * table plus the user's saved bindings. A command with no key is omitted, and
 * one command keeps every key it is bound to.
 */
export function shortcutCheatsheetGroups(
  keybindings: ResolvedKeybindingsConfig,
  platform = navigator.platform,
): ReadonlyArray<ShortcutCheatsheetGroup> {
  // Callers pass the merged table (`primaryServerKeybindingsAtom` already folds
  // defaults in). Merging again would let a default binding outrank a saved one.
  const rows = buildKeybindingRows(keybindings, platform).filter((row) => row.key.length > 0);
  return groupKeybindingRows(rows).flatMap((group) => {
    const entries = cheatsheetEntries(group.rows, platform);
    return entries.length > 0 ? [{ id: group.id, title: group.title, entries }] : [];
  });
}

function cheatsheetEntries(
  rows: ReadonlyArray<KeybindingRow>,
  platform: string,
): ReadonlyArray<ShortcutCheatsheetEntry> {
  const entries: Array<ShortcutCheatsheetEntry> = [];
  for (const row of rows) {
    const key = formatShortcutLabel(row.binding.shortcut, platform);
    const existing = entries.find((entry) => entry.command === row.command);
    if (existing) {
      const index = entries.indexOf(existing);
      entries[index] = {
        ...existing,
        keys: existing.keys.includes(key) ? existing.keys : [...existing.keys, key],
        conflicts: [...new Set([...existing.conflicts, ...row.conflicts])],
      };
      continue;
    }
    entries.push({
      id: row.command,
      command: row.command,
      label: commandLabel(row.command),
      keys: [key],
      conflicts: [...row.conflicts],
    });
  }
  return entries;
}
