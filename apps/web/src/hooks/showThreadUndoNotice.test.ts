import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import { announce, cancelAnnouncement } from "../lib/announce";
import {
  THREAD_UNDO_NOTICE_TIMEOUT_MS,
  releaseThreadUndoShortcut,
  showThreadUndoNotice,
  showThreadUndoNotices,
  threadUndoClaimsShortcut,
  threadUndoNoticeSummary,
  undoLatestThreadAction,
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
  const add = vi.spyOn(toastManager, "add").mockReturnValue("undo-toast");
  const update = vi.spyOn(toastManager, "update").mockImplementation(() => {});
  const close = vi.spyOn(toastManager, "close").mockImplementation(() => {});
  const undo = vi.fn(async () => AsyncResult.success(undefined));
  const claim = ThreadUndo.begin("pin", "env/thread");
  const options = { action: "Unpinned" as const, failureTitle: "Restore failed", undo, claim };
  return { add, update, close, undo, claim, options };
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
    vi.advanceTimersByTime(THREAD_UNDO_NOTICE_TIMEOUT_MS);
    expect(threadUndoClaimsShortcut()).toBe(false);
  });

  it("announces each new summary once, and cancels it when the notice clears", async () => {
    const { options } = setup();
    vi.mocked(announce).mockClear();
    vi.mocked(cancelAnnouncement).mockClear();
    showThreadUndoNotice(options);
    expect(announce).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^已取消置顶，/),
      "thread-undo-notice",
    );
    ThreadUndo.invalidate("pin", "env/other");
    expect(announce).toHaveBeenCalledOnce();
    showThreadUndoNotice({ ...options, claim: ThreadUndo.begin("pin", "env/second") });
    expect(announce).toHaveBeenLastCalledWith(
      expect.stringMatching(/^已取消置顶 2 个会话，/),
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
    expect(announce).toHaveBeenCalledExactlyOnceWith("已重新置顶 1 个会话");
  });

  it("does not announce an undo that failed", async () => {
    const { options, add } = setup();
    showThreadUndoNotice({
      ...options,
      undo: async () => AsyncResult.failure(Cause.fail(new Error("offline"))),
    });
    add.mockClear();
    vi.mocked(announce).mockClear();
    await notice().undo();
    expect(add).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
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
      failureTitle: "无法撤销标为完成",
      undo: undoFirst,
      claim: ThreadUndo.begin("settle", "env/first"),
    });
    expect(add).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "success",
        title: "已标为完成",
        timeout: 0,
        actionProps: expect.objectContaining({ children: "撤销" }),
      }),
    );

    vi.advanceTimersByTime(4_000);
    showThreadUndoNotice({
      action: "Settled",
      failureTitle: "无法撤销标为完成",
      undo: undoSecond,
      claim: ThreadUndo.begin("settle", "env/second"),
    });
    expect(update).toHaveBeenCalledExactlyOnceWith(
      "settle-toast",
      expect.objectContaining({
        title: "已标为完成 2 个会话",
        timeout: 0,
        actionProps: expect.objectContaining({ children: "撤销" }),
      }),
    );

    // Past the first 8s mark, the extended undo window is still alive and the toast stays open.
    vi.advanceTimersByTime(5_000);
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

    // When not undone manually, expiry closes the settle toast after 8s.
    close.mockClear();
    showThreadUndoNotice({
      action: "Settled",
      failureTitle: "无法撤销标为完成",
      undo: undoFirst,
      claim: ThreadUndo.begin("settle", "env/third"),
    });
    vi.advanceTimersByTime(7_999);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledExactlyOnceWith("settle-toast");
  });

  it.each([
    ["Archived", "archive", "修复登录", "已归档「修复登录」"],
    ["Snoozed", "snooze", "整理文档", "已暂缓「整理文档」"],
    ["Settled", "settle", "发布版本", "已标为完成「发布版本」"],
    ["Unpinned", "pin", "置顶排查", "已取消置顶「置顶排查」"],
    ["Discarded", "discard", "半截草稿", "已丢弃草稿「半截草稿」"],
    ["DismissedAttention", "dismiss-attention", "待确认", "已移出等你处理「待确认」"],
  ] as const)(
    "uses one unified 8s toast with Undo button for %s",
    async (action, kind, title, expectedTitle) => {
      expect(THREAD_UNDO_NOTICE_TIMEOUT_MS).toBe(8_000);
      const { add, close, undo } = setup();
      showThreadUndoNotice({
        action,
        title,
        failureTitle: "无法撤销",
        undo,
        claim: ThreadUndo.begin(kind, `env/${kind}`),
      });
      expect(add).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: "success",
          title: expectedTitle,
          timeout: 0,
          actionProps: expect.objectContaining({ children: "撤销" }),
        }),
      );
      vi.advanceTimersByTime(7_999);
      expect(close).not.toHaveBeenCalled();
      const payload = add.mock.calls[0]?.[0];
      const onClick =
        typeof payload === "object" && payload !== null
          ? (payload.actionProps?.onClick as (() => void) | undefined)
          : undefined;
      onClick?.();
      await Promise.resolve();
      expect(undo).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledWith("undo-toast");
    },
  );

  it("truncates overly long titles with ellipsis without breaking surrogate pairs", () => {
    expect(
      threadUndoNoticeSummary({
        action: "Archived",
        count: 1,
        title: "短标题",
      }),
    ).toBe("已归档「短标题」");

    expect(
      threadUndoNoticeSummary({
        action: "Archived",
        count: 1,
        title: "   ",
      }),
    ).toBe("已归档");

    const longChinese = "这是一条非常非常非常长而且超过显示宽度限制的中文会话标题内容";
    const cjkSummary = threadUndoNoticeSummary({
      action: "Archived",
      count: 1,
      title: longChinese,
    });
    expect(cjkSummary).toMatch(/^已归档「.+…」$/);
    expect(cjkSummary.length).toBeLessThan(longChinese.length);

    const longAscii = "a-very-long-english-thread-title-that-should-be-truncated-cleanly";
    const asciiSummary = threadUndoNoticeSummary({
      action: "Settled",
      count: 1,
      title: longAscii,
    });
    expect(asciiSummary).toMatch(/^已标为完成「.+…」$/);
    expect(asciiSummary.length).toBeLessThan(longAscii.length);

    const emojiTitle = "🚀".repeat(25);
    const emojiSummary = threadUndoNoticeSummary({
      action: "Snoozed",
      count: 1,
      title: emojiTitle,
    });
    expect(emojiSummary).toMatch(/^已暂缓「(?:🚀)+…」$/);
  });

  it("replaces the toast with the latest action, undoes only latest on mod+z, and does not swallow distinct threads", async () => {
    const { add, update, close } = setup();
    const undoUnpin = vi.fn(async () => AsyncResult.success(undefined));
    const undoArchiveA = vi.fn(async () => AsyncResult.success(undefined));
    const undoArchiveB = vi.fn(async () => AsyncResult.success(undefined));

    showThreadUndoNotice({
      action: "Unpinned",
      title: "会话 A",
      failureTitle: "无法撤销取消置顶",
      undo: undoUnpin,
      claim: ThreadUndo.begin("pin", "env/a"),
    });
    expect(add).toHaveBeenCalledTimes(1);

    // Consecutive different action replaces the visible toast; mod+z only undoes the latest.
    showThreadUndoNotice({
      action: "Archived",
      title: "会话 B",
      failureTitle: "无法撤销归档",
      undo: undoArchiveA,
      claim: ThreadUndo.begin("archive", "env/b"),
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith(
      "undo-toast",
      expect.objectContaining({ title: "已归档「会话 B」" }),
    );

    // Consecutive action of same kind on a DIFFERENT thread merges count and undoes BOTH (neither swallowed).
    showThreadUndoNotice({
      action: "Archived",
      title: "会话 C",
      failureTitle: "无法撤销归档",
      undo: undoArchiveB,
      claim: ThreadUndo.begin("archive", "env/c"),
    });
    expect(update).toHaveBeenLastCalledWith(
      "undo-toast",
      expect.objectContaining({ title: "已归档 2 个会话" }),
    );

    expect(undoLatestThreadAction()).toBe(true);
    await Promise.resolve();
    expect(undoArchiveA).toHaveBeenCalledOnce();
    expect(undoArchiveB).toHaveBeenCalledOnce();
    expect(undoUnpin).not.toHaveBeenCalled();

    // Under the existing liveUndos stack, the earlier Unpinned notice becomes visible again within the 8s window.
    expect(update).toHaveBeenLastCalledWith(
      "undo-toast",
      expect.objectContaining({ title: "已取消置顶「会话 A」" }),
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("registers batch notices atomically and drops invalidated entries before Undo", async () => {
    const { add, update } = setup();
    const undoOne = vi.fn(async () => AsyncResult.success(undefined));
    const undoTwo = vi.fn(async () => AsyncResult.success(undefined));
    const undoThree = vi.fn(async () => AsyncResult.success(undefined));

    showThreadUndoNotices([
      {
        action: "Archived",
        title: "甲",
        failureTitle: "无法撤销归档",
        undo: undoOne,
        claim: ThreadUndo.begin("archive", "env/1"),
      },
      {
        action: "Archived",
        title: "乙",
        failureTitle: "无法撤销归档",
        undo: undoTwo,
        claim: ThreadUndo.begin("archive", "env/2"),
      },
      {
        action: "Archived",
        title: "丙",
        failureTitle: "无法撤销归档",
        undo: undoThree,
        claim: ThreadUndo.begin("archive", "env/3"),
      },
    ]);

    expect(add).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "已归档 3 个会话" }),
    );

    ThreadUndo.invalidate("archive", "env/2");
    expect(update).toHaveBeenLastCalledWith(
      "undo-toast",
      expect.objectContaining({ title: "已归档 2 个会话" }),
    );

    expect(undoLatestThreadAction()).toBe(true);
    await Promise.resolve();
    expect(undoOne).toHaveBeenCalledOnce();
    expect(undoTwo).not.toHaveBeenCalled();
    expect(undoThree).toHaveBeenCalledOnce();
  });

  it("reopens a toast after the user manually closed the previous one, even with the same summary", () => {
    const { add } = setup();
    const undo = vi.fn(async () => AsyncResult.success(undefined));

    showThreadUndoNotice({
      action: "Archived",
      title: "同名会话",
      failureTitle: "无法撤销归档",
      undo,
      claim: ThreadUndo.begin("archive", "env/one"),
    });
    expect(add).toHaveBeenCalledTimes(1);

    const firstPayload = add.mock.calls[0]?.[0] as { data?: { onClose?: () => void } } | undefined;
    firstPayload?.data?.onClose?.();

    // Clear the first undo via expiry, then issue another notice with the exact same summary text.
    vi.advanceTimersByTime(THREAD_UNDO_NOTICE_TIMEOUT_MS);
    showThreadUndoNotice({
      action: "Archived",
      title: "同名会话",
      failureTitle: "无法撤销归档",
      undo,
      claim: ThreadUndo.begin("archive", "env/two"),
    });
    expect(add).toHaveBeenCalledTimes(2);
  });
});
