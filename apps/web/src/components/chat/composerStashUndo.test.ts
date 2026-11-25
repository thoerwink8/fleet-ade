import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { createMemoryStorage } from "../../lib/storage";
import {
  PROMPT_STASH_STORAGE_KEY,
  type PromptStashEntry,
  usePromptStashStore,
  writePromptStashStorageForTest,
} from "../../promptStashStore";
import { toastManager } from "../ui/toast";
import {
  STASH_DELETE_UNDO_TIMEOUT_MS,
  clearPendingStashUndosForTest,
  deleteStashEntryWithUndo,
} from "./composerStashUndo";

const ENV = EnvironmentId.make("env-1");

function makeEntry(id: string, prompt = `prompt ${id}`, withFile = false): PromptStashEntry {
  return {
    id,
    createdAt: "2026-11-25T00:00:00.000Z",
    prompt,
    attachments: [],
    droppedImageNames: [],
    ...(withFile
      ? {
          files: [
            {
              id: `file-${id}`,
              name: `${id}.txt`,
              mimeType: "text/plain",
              sizeBytes: 12,
              attachmentId: `pending-${id}`,
              environmentId: ENV,
            },
          ],
        }
      : {}),
  };
}

async function setupDurableUndoTest() {
  const storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.resetModules();
  const stashMod = await import("../../promptStashStore");
  const undoMod = await import("./composerStashUndo");
  const toastMod = await import("../ui/toast");
  return {
    store: stashMod.usePromptStashStore,
    toast: toastMod.toastManager,
    deleteWithUndo: undoMod.deleteStashEntryWithUndo,
    clearTimers: undoMod.clearPendingStashUndosForTest,
    timeoutMs: undoMod.STASH_DELETE_UNDO_TIMEOUT_MS,
  };
}

describe("composerStashUndo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPendingStashUndosForTest();
    usePromptStashStore.setState({ entries: [], stashSeq: 0 });
    writePromptStashStorageForTest("");
    removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
  });

  afterEach(() => {
    clearPendingStashUndosForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("restores a deleted entry to its original position within 8 seconds without releasing uploads", async () => {
    const { store, toast, deleteWithUndo, clearTimers, timeoutMs } = await setupDurableUndoTest();
    try {
      expect(timeoutMs).toBe(8_000);
      const entryC = makeEntry("c");
      const entryB = makeEntry("b", "second prompt", true);
      const entryA = makeEntry("a");
      store.getState().stashEntry(entryC);
      store.getState().stashEntry(entryB);
      store.getState().stashEntry(entryA);

      const add = vi.spyOn(toast, "add").mockReturnValue("undo-toast-1");
      const close = vi.spyOn(toast, "close").mockImplementation(() => {});
      const releaseUpload = vi.fn();

      const result = deleteWithUndo(entryB, { releaseUpload });
      expect(result.deleted).toBe(true);
      expect(store.getState().entries.map((entry) => entry.id)).toEqual(["a", "c"]);
      expect(releaseUpload).not.toHaveBeenCalled();
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "success",
          title: "已删除暂存「second prompt」",
          timeout: 0,
          actionProps: expect.objectContaining({ children: "撤销" }),
        }),
      );

      vi.advanceTimersByTime(4_000);
      const actionOnClick = (
        add.mock.calls[0]?.[0] as { actionProps?: { onClick?: () => void } } | undefined
      )?.actionProps?.onClick;
      actionOnClick?.();

      expect(store.getState().entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
      expect(close).toHaveBeenCalledWith("undo-toast-1");
      vi.advanceTimersByTime(timeoutMs);
      expect(releaseUpload).not.toHaveBeenCalled();
    } finally {
      clearTimers();
    }
  });

  it("commits deletion and releases uploaded files once the 8s undo window expires", async () => {
    const { store, toast, deleteWithUndo, clearTimers, timeoutMs } = await setupDurableUndoTest();
    try {
      const entry = makeEntry("expired", "will expire", true);
      store.getState().stashEntry(entry);

      const add = vi.spyOn(toast, "add").mockReturnValue("undo-toast-expire");
      const close = vi.spyOn(toast, "close").mockImplementation(() => {});
      const releaseUpload = vi.fn();

      deleteWithUndo(entry, { releaseUpload });
      expect(store.getState().entries).toEqual([]);

      vi.advanceTimersByTime(timeoutMs - 1);
      expect(close).not.toHaveBeenCalled();
      expect(releaseUpload).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(close).toHaveBeenCalledWith("undo-toast-expire");
      expect(releaseUpload).toHaveBeenCalledExactlyOnceWith({
        id: "file-expired",
        environmentId: ENV,
        attachmentId: "pending-expired",
      });

      const actionOnClick = (
        add.mock.calls[0]?.[0] as { actionProps?: { onClick?: () => void } } | undefined
      )?.actionProps?.onClick;
      actionOnClick?.();
      expect(store.getState().entries).toEqual([]);
    } finally {
      clearTimers();
    }
  });

  it("allows undoing two consecutively deleted entries independently in either order", async () => {
    const { store, toast, deleteWithUndo, clearTimers, timeoutMs } = await setupDurableUndoTest();
    try {
      const entryC = makeEntry("c", "third");
      const entryB = makeEntry("b", "second", true);
      const entryA = makeEntry("a", "first", true);
      store.getState().stashEntry(entryC);
      store.getState().stashEntry(entryB);
      store.getState().stashEntry(entryA);

      let seq = 0;
      const add = vi.spyOn(toast, "add").mockImplementation(() => `toast-${++seq}`);
      const close = vi.spyOn(toast, "close").mockImplementation(() => {});
      const releaseUpload = vi.fn();

      deleteWithUndo(entryA, { releaseUpload });
      vi.advanceTimersByTime(2_000);
      deleteWithUndo(entryB, { releaseUpload });
      expect(add).toHaveBeenCalledTimes(2);
      expect(store.getState().entries.map((entry) => entry.id)).toEqual(["c"]);

      // Undo only B; A should expire after its 8s window.
      const clickB = (add.mock.calls[1]?.[0] as { actionProps?: { onClick?: () => void } })
        ?.actionProps?.onClick;
      clickB?.();
      expect(store.getState().entries.map((entry) => entry.id)).toEqual(["b", "c"]);
      expect(close).toHaveBeenCalledWith("toast-2");

      vi.advanceTimersByTime(6_000);
      expect(close).toHaveBeenCalledWith("toast-1");
      expect(releaseUpload).toHaveBeenCalledExactlyOnceWith({
        id: "file-a",
        environmentId: ENV,
        attachmentId: "pending-a",
      });

      // Now test deleting both and undoing A first, then B.
      store.getState().stashEntry(entryA);
      expect(store.getState().entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
      add.mockClear();
      releaseUpload.mockClear();

      deleteWithUndo(entryA, { releaseUpload });
      deleteWithUndo(entryB, { releaseUpload });
      expect(store.getState().entries.map((entry) => entry.id)).toEqual(["c"]);

      const clickA2 = (add.mock.calls[0]?.[0] as { actionProps?: { onClick?: () => void } })
        ?.actionProps?.onClick;
      const clickB2 = (add.mock.calls[1]?.[0] as { actionProps?: { onClick?: () => void } })
        ?.actionProps?.onClick;
      clickA2?.();
      clickB2?.();
      expect(store.getState().entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
      vi.advanceTimersByTime(timeoutMs);
      expect(releaseUpload).not.toHaveBeenCalled();
    } finally {
      clearTimers();
    }
  });

  it("commits cleanup immediately when the user dismisses the undo toast", async () => {
    const { store, toast, deleteWithUndo, clearTimers } = await setupDurableUndoTest();
    try {
      const entry = makeEntry("dismiss", "dismiss me", true);
      store.getState().stashEntry(entry);

      const add = vi.spyOn(toast, "add").mockReturnValue("toast-dismiss");
      const releaseUpload = vi.fn();

      deleteWithUndo(entry, { releaseUpload });
      const onClose = (add.mock.calls[0]?.[0] as { data?: { onClose?: () => void } })?.data
        ?.onClose;
      onClose?.();

      expect(releaseUpload).toHaveBeenCalledOnce();
      const actionOnClick = (
        add.mock.calls[0]?.[0] as { actionProps?: { onClick?: () => void } } | undefined
      )?.actionProps?.onClick;
      actionOnClick?.();
      expect(store.getState().entries).toEqual([]);
    } finally {
      clearTimers();
    }
  });

  it("keeps undo working when storage is memory-only and skips releasing uploads on expiry", () => {
    const entry = makeEntry("mem-only", "in memory", true);
    usePromptStashStore.getState().stashEntry(entry);

    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast-mem");
    const releaseUpload = vi.fn();

    deleteStashEntryWithUndo(entry, { releaseUpload });
    expect(usePromptStashStore.getState().entries).toEqual([]);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "已删除暂存「in memory」",
        actionProps: expect.objectContaining({ children: "撤销" }),
      }),
    );

    vi.advanceTimersByTime(STASH_DELETE_UNDO_TIMEOUT_MS);
    expect(releaseUpload).not.toHaveBeenCalled();
  });
});
