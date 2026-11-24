import { useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { create } from "zustand";

import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Kbd } from "./ui/kbd";
import { shortcutCheatsheetGroups } from "./ShortcutCheatsheet.logic";

interface ShortcutCheatsheetState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly toggle: () => void;
}

const useShortcutCheatsheetStore = create<ShortcutCheatsheetState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));

export function openShortcutCheatsheet(): void {
  useShortcutCheatsheetStore.getState().setOpen(true);
}

export function toggleShortcutCheatsheet(): void {
  useShortcutCheatsheetStore.getState().toggle();
}

export function ShortcutCheatsheetDialog() {
  const open = useShortcutCheatsheetStore((state) => state.open);
  const setOpen = useShortcutCheatsheetStore((state) => state.setOpen);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const panelRef = useRef<HTMLDivElement>(null);
  const groups = shortcutCheatsheetGroups(keybindings);
  const shortcut = shortcutLabelForCommand(keybindings, "shortcutCheatsheet.toggle");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-h-[85vh] sm:max-w-xl" initialFocus={panelRef}>
        <DialogHeader>
          <DialogTitle>快捷键</DialogTitle>
          <DialogDescription>
            <span className="block leading-6">
              {shortcut ? (
                <>
                  按 <Kbd variant="outline">{shortcut}</Kbd> 或 Esc 关闭。
                </>
              ) : (
                <>按 Esc 关闭。</>
              )}{" "}
              改键后这里跟着变。
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel ref={panelRef} tabIndex={-1}>
          {groups.length === 0 ? (
            <p className="text-sm leading-6 text-muted-foreground">没有已绑定的快捷键。</p>
          ) : (
            <div className="space-y-5">
              {groups.map((group) => (
                <section key={group.id} className="space-y-1">
                  <h3 className="text-row font-medium leading-6 text-muted-foreground">
                    {group.title}
                  </h3>
                  <ul>
                    {group.entries.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm leading-6 last:border-b-0"
                      >
                        <span className="min-w-0">
                          <span className="wrap-anywhere">{entry.label}</span>
                          {entry.conflicts.length > 0 ? (
                            <span className="mt-0.5 block text-sm leading-6 text-warning">
                              与 {entry.conflicts.join("、")} 冲突
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 flex-wrap justify-end gap-1">
                          {entry.keys.map((key) => (
                            <Kbd key={key} variant="outline">
                              {key}
                            </Kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </DialogPanel>
        <div className="px-6 pb-4 text-sm leading-6">
          <Link
            to="/settings/general"
            hash="keybindings"
            className="text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setOpen(false)}
          >
            去设置里修改
          </Link>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
