/**
 * Which control answers the composer.mode shortcut. The footer keeps four controls (attach,
 * model and effort, voice, send), so the permissions chip never shows: Permissions live in the
 * model picker's footer, which therefore always owns composer.mode.
 */
export function resolveComposerControlsOwnership() {
  return {
    accessDisplay: "hidden" as "hidden" | "icon" | "label",
    showModeBlock: false,
    hiddenBlockCount: 0,
    hiddenBlockIds: [] as readonly "mode"[],
    overflowShowsPermissions: false,
    pickerOwnsModeShortcut: true,
  };
}
