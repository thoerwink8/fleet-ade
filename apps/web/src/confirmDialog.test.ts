import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  requestConfirmDialog,
  requestConfirmDialogWithCheckbox,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
  setConfirmDialogChecked,
  subscribeConfirmDialogHost,
} from "./confirmDialog";

const mountHost = () => subscribeConfirmDialogHost(() => {});

const copy = { title: "继续吗？", confirmLabel: "继续" } as const;
const stateCopy = {
  title: "继续吗？",
  confirmLabel: "继续",
  cancelLabel: "取消",
  variant: "default",
  checkbox: null,
} as const;

function requireConfirmation(confirmation: Promise<boolean> | undefined): Promise<boolean> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

describe("confirm dialog coordinator", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = mountHost();
    const first = requireConfirmation(
      requestConfirmDialog("Delete the project?", { ...copy, initialFocus: "confirm" }),
    );
    const second = requireConfirmation(requestConfirmDialog("同时删除工作树？", copy));

    respondToConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      ...stateCopy,
      message: "Delete the project?",
      initialFocus: "confirm",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      ...stateCopy,
      message: "同时删除工作树？",
      initialFocus: undefined,
    });

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = mountHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?", copy));
    const queued = requireConfirmation(requestConfirmDialog("同时删除工作树？", copy));

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("has no host until one subscribes", () => {
    expect(requestConfirmDialog("Continue?", copy)).toBeUndefined();
    const unsubscribe = mountHost();
    expect(requestConfirmDialog("Continue?", copy)).toBeDefined();
    unsubscribe();
    expect(requestConfirmDialog("Continue?", copy)).toBeUndefined();
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = mountHost();
    const confirmation = requireConfirmation(requestConfirmDialog("Continue?", copy));

    respondToConfirmDialog(true);
    respondToConfirmDialog(false);
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    return expect(confirmation).resolves.toBe(true);
  });

  it("returns the checkbox state with the answer, and cancelling keeps the default", async () => {
    const unregister = mountHost();
    const checked = requestConfirmDialogWithCheckbox("Delete?", {
      ...copy,
      checkbox: { label: "同时删除工作树" },
    });
    if (!checked) throw new Error("Expected a registered confirmation host.");
    expect(readConfirmDialogState()).toMatchObject({ checkbox: { checked: false } });
    setConfirmDialogChecked(true);
    expect(readConfirmDialogState()).toMatchObject({ checkbox: { checked: true } });
    respondToConfirmDialog(true);
    await expect(checked).resolves.toEqual({ confirmed: true, checked: true });
    completeConfirmDialogClose();

    const cancelled = requestConfirmDialogWithCheckbox("Delete?", {
      ...copy,
      checkbox: { label: "同时删除工作树", defaultChecked: true },
    });
    respondToConfirmDialog(false);
    await expect(cancelled).resolves.toEqual({ confirmed: false, checked: true });
    unregister();
  });
});
