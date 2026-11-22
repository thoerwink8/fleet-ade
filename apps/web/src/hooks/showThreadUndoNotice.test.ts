import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import { announce, cancelAnnouncement } from "../lib/announce";
import {
  releaseThreadUndoShortcut,
  showThreadUndoNotice,
  threadUndoClaimsShortcut,
  useThreadUndoNotice,
} from "./showThreadUndoNotice";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";

vi.mock("../lib/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const add = vi.spyOn(toastManager, "add").mockReturnValue("error-toast");
  const undo = vi.fn(async () => AsyncResult.success(undefined));
  const claim = ThreadUndo.begin("pin", "env/thread");
  const options = { action: "Unpinned" as const, failureTitle: "Restore failed", undo, claim };
  return { add, undo, claim, options };
}

function notice() {
  const value = useThreadUndoNotice.getState().notice;
  if (!value) throw new Error("Undo notice is missing");
  return value;
}

describe("thread undo notice", () => {
  it("drops invalidated claims immediately and rejects a captured stale undo", async () => {
    const { undo, options } = setup();
    showThreadUndoNotice(options);
    const stale = notice();
    ThreadUndo.invalidate("pin", "env/thread");
    expect(useThreadUndoNotice.getState().notice).toBeNull();
    showThreadUndoNotice({ ...options, claim: ThreadUndo.begin("pin", "env/thread") });
    await stale.undo();
    expect(undo).not.toHaveBeenCalled();
    await notice().undo();
    expect(undo).toHaveBeenCalledOnce();
  });

  it("claims mod+z from text fields until the user types, then again for a new notice", () => {
    const { options } = setup();
    expect(threadUndoClaimsShortcut()).toBe(false);
    showThreadUndoNotice(options);
    expect(threadUndoClaimsShortcut()).toBe(true);
    releaseThreadUndoShortcut();
    expect(threadUndoClaimsShortcut()).toBe(false);
    showThreadUndoNotice({ ...options, claim: ThreadUndo.begin("pin", "env/next") });
    expect(threadUndoClaimsShortcut()).toBe(true);
  });

  it("stops claiming mod+z once nothing is left to undo", async () => {
    const { options } = setup();
    showThreadUndoNotice(options);
    await notice().undo();
    expect(threadUndoClaimsShortcut()).toBe(false);
    showThreadUndoNotice({ ...options, claim: ThreadUndo.begin("pin", "env/expiring") });
    vi.advanceTimersByTime(5_000);
    expect(threadUndoClaimsShortcut()).toBe(false);
  });

  it("announces each new summary once, and cancels it when the notice clears", async () => {
    const { options } = setup();
    vi.mocked(announce).mockClear();
    vi.mocked(cancelAnnouncement).mockClear();
    showThreadUndoNotice(options);
    expect(announce).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^Unpinned 1 thread, /),
      "thread-undo-notice",
    );
    ThreadUndo.invalidate("pin", "env/other");
    expect(announce).toHaveBeenCalledOnce();
    showThreadUndoNotice({ ...options, claim: ThreadUndo.begin("pin", "env/second") });
    expect(announce).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Unpinned 2 threads, /),
      "thread-undo-notice",
    );
    await notice().undo();
    expect(cancelAnnouncement).toHaveBeenCalledWith("thread-undo-notice");
  });

  it("announces that the undo happened, naming the undone action", async () => {
    const { options } = setup();
    showThreadUndoNotice(options);
    vi.mocked(announce).mockClear();
    await notice().undo();
    expect(announce).toHaveBeenCalledExactlyOnceWith("Undid unpin of 1 thread");
  });

  it("does not announce an undo that failed", async () => {
    const { options, add } = setup();
    showThreadUndoNotice({
      ...options,
      undo: async () => AsyncResult.failure(Cause.fail(new Error("offline"))),
    });
    vi.mocked(announce).mockClear();
    await notice().undo();
    expect(add).toHaveBeenCalledOnce();
    expect(announce).not.toHaveBeenCalled();
  });

  it("shows and updates a persistent settle toast and closes it only when undone or expired", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("settle-toast");
    const update = vi.spyOn(toastManager, "update").mockImplementation(() => {});
    const close = vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const undoFirst = vi.fn(async () => AsyncResult.success(undefined));
    const undoSecond = vi.fn(async () => AsyncResult.success(undefined));

    showThreadUndoNotice({
      action: "Settled",
      failureTitle: "无法撤销收尾",
      undo: undoFirst,
      claim: ThreadUndo.begin("settle", "env/first"),
    });
    expect(add).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "success",
        title: "已收尾",
        timeout: 0,
        actionProps: expect.objectContaining({ children: "撤销" }),
      }),
    );

    vi.advanceTimersByTime(4_000);
    showThreadUndoNotice({
      action: "Settled",
      failureTitle: "无法撤销收尾",
      undo: undoSecond,
      claim: ThreadUndo.begin("settle", "env/second"),
    });
    expect(update).toHaveBeenCalledExactlyOnceWith(
      "settle-toast",
      expect.objectContaining({
        title: "已收尾 2 个会话",
        timeout: 0,
        actionProps: expect.objectContaining({ children: "撤销" }),
      }),
    );

    // Past the first 5s mark, the extended undo window is still alive and the toast stays open.
    vi.advanceTimersByTime(2_000);
    expect(close).not.toHaveBeenCalled();

    const updatePayload = update.mock.calls[0]?.[1];
    const actionOnClick =
      typeof updatePayload === "object" && updatePayload !== null
        ? (updatePayload.actionProps?.onClick as (() => void) | undefined)
        : undefined;
    actionOnClick?.();
    await Promise.resolve();
    expect(close).toHaveBeenCalledExactlyOnceWith("settle-toast");
    expect(undoFirst).toHaveBeenCalledOnce();
    expect(undoSecond).toHaveBeenCalledOnce();

    // When not undone manually, expiry closes the settle toast.
    close.mockClear();
    showThreadUndoNotice({
      action: "Settled",
      failureTitle: "无法撤销收尾",
      undo: undoFirst,
      claim: ThreadUndo.begin("settle", "env/third"),
    });
    vi.advanceTimersByTime(4_999);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledExactlyOnceWith("settle-toast");
  });
});
