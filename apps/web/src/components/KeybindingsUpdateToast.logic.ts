import type { ServerConfigStreamEvent } from "@t3tools/contracts";

const KEYBINDINGS_TOAST_COOLDOWN_MS = 2_000;

export type KeybindingsUpdateToastDecision = {
  readonly _tag: "InvalidConfiguration";
  readonly message: string;
};

export interface KeybindingsUpdateToastController {
  readonly handle: (event: ServerConfigStreamEvent | null) => KeybindingsUpdateToastDecision | null;
}

export function createKeybindingsUpdateToastController(input: {
  readonly now?: () => number;
}): KeybindingsUpdateToastController {
  const now = input.now ?? Date.now;
  let lastToast: { readonly key: string; readonly at: number } | null = null;

  return {
    handle: (event) => {
      if (event?.type !== "keybindingsUpdated") {
        return null;
      }

      const issue = event.payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      // A clean reload is the file watcher doing its job; nothing to announce.
      if (!issue) {
        return null;
      }
      const decision: KeybindingsUpdateToastDecision = {
        _tag: "InvalidConfiguration",
        message: issue.message,
      };

      // A save and the server's file watcher each publish the same snapshot,
      // so an identical toast inside the cooldown is the same change twice.
      const key = `invalid:${issue.message}`;
      const currentTime = now();
      if (
        lastToast !== null &&
        lastToast.key === key &&
        currentTime - lastToast.at < KEYBINDINGS_TOAST_COOLDOWN_MS
      ) {
        return null;
      }

      lastToast = { key, at: currentTime };
      return decision;
    },
  };
}
