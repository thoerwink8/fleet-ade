import type {
  ConfirmDialogCheckbox,
  ConfirmDialogChoice,
  ConfirmDialogOptions,
  ConfirmDialogVariant,
} from "@t3tools/contracts";

export const DEFAULT_CONFIRM_CANCEL_LABEL = "取消";

type ConfirmDialogCopy = {
  readonly message: string;
  readonly title: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly variant: ConfirmDialogVariant;
  readonly initialFocus: ConfirmDialogOptions["initialFocus"];
  readonly checkbox: { readonly label: string; readonly checked: boolean } | null;
};

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | ({ readonly status: "confirming" } & ConfirmDialogCopy)
  | ({ readonly status: "closing" } & ConfirmDialogCopy);

type PendingConfirmation = {
  readonly copy: ConfirmDialogCopy;
  readonly resolve: (choice: ConfirmDialogChoice) => void;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(confirmed: boolean): void {
  const settle = (confirmation: PendingConfirmation) =>
    confirmation.resolve({ confirmed, checked: confirmation.copy.checkbox?.checked ?? false });
  if (activeConfirmation) settle(activeConfirmation);
  for (const confirmation of queuedConfirmations) settle(confirmation);
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

/**
 * Only themed hosts subscribe, so a subscriber is a mounted host. When the last
 * one leaves, pending confirmations resolve as cancelled.
 */
export function subscribeConfirmDialogHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    resolvePendingConfirmations(false);
    publish(idleState);
  };
}

function enqueue(
  message: string,
  options: ConfirmDialogOptions & { readonly checkbox?: ConfirmDialogCheckbox },
): Promise<ConfirmDialogChoice> | undefined {
  if (listeners.size === 0) return undefined;

  return new Promise<ConfirmDialogChoice>((resolve) => {
    const pending = {
      copy: {
        message,
        title: options.title,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel ?? DEFAULT_CONFIRM_CANCEL_LABEL,
        variant: options.variant ?? "default",
        initialFocus: options.initialFocus,
        checkbox: options.checkbox
          ? { label: options.checkbox.label, checked: options.checkbox.defaultChecked ?? false }
          : null,
      },
      resolve,
    } satisfies PendingConfirmation;
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({ status: "confirming", ...pending.copy });
  });
}

/** Undefined means no themed host is available. */
export function requestConfirmDialog(
  message: string,
  options: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  return enqueue(message, options)?.then((choice) => choice.confirmed);
}

/** Undefined means no themed host is available. */
export function requestConfirmDialogWithCheckbox(
  message: string,
  options: ConfirmDialogOptions & { readonly checkbox: ConfirmDialogCheckbox },
): Promise<ConfirmDialogChoice> | undefined {
  return enqueue(message, options);
}

export function isConfirmDialogActive(): boolean {
  return state.status !== "idle" || activeConfirmation !== null || queuedConfirmations.length > 0;
}

export function setConfirmDialogChecked(checked: boolean): void {
  if (state.status !== "confirming" || !state.checkbox) return;
  publish({ ...state, checkbox: { ...state.checkbox, checked } });
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  const { status: _status, ...copy } = state;
  confirmation.resolve({ confirmed, checked: copy.checkbox?.checked ?? false });
  publish({ status: "closing", ...copy });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({ status: "confirming", ...next.copy });
}

export function resetConfirmDialogForTests(): void {
  listeners.clear();
  resolvePendingConfirmations(false);
  publish(idleState);
}
