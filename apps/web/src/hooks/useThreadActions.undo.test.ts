import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";
import { useThreadUndoNotice } from "./showThreadUndoNotice";
import { announce } from "../lib/announce";
import { useThreadSelectionStore } from "../threadSelectionStore";

const commands = vi.hoisted(() => ({
  pin: vi.fn(),
  unpin: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  batch: vi.fn(),
  delete: vi.fn(),
  settle: vi.fn(),
  unsettle: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
}));
const router = vi.hoisted(() => {
  const listeners = new Set<(event: { action: { type: string } }) => void>();
  return {
    navigate: vi.fn(async () => {}),
    state: { location: { href: "/" }, matches: [{ params: {} as Record<string, string> }] },
    history: {
      listeners,
      subscribe: (listener: (event: { action: { type: string } }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => {
    router.state.location.href = "/draft/project";
  },
}));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
const threadShell = vi.hoisted(() => ({
  id: "thread",
  title: "会话",
  pinOrderKey: "a0",
  pinnedAt: null as string | null,
  snoozedUntil: null as string | null,
  projectId: "project",
  environmentId: "undo-env",
  session: null,
}));
// Archived rows have no loaded shell, so deleting one takes the unresolved path.
const shellLoaded = vi.hoisted(() => ({ current: true }));
type MockShell = typeof threadShell & { archivedAt?: string | null };
const shellsByKey = vi.hoisted(() => new Map<string, MockShell>());
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentServerConfigLoaded: () => true,
  readThreadShell: (ref: { environmentId: string; threadId: string }) => {
    if (!shellLoaded.current) return null;
    if (shellsByKey.size > 0) {
      return shellsByKey.get(`${ref.environmentId}:${ref.threadId}`) ?? null;
    }
    return threadShell;
  },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case threadEnvironment.pin:
        return commands.pin;
      case threadEnvironment.unpin:
        return commands.unpin;
      case threadEnvironment.archive:
        return commands.archive;
      case threadEnvironment.unarchive:
        return commands.unarchive;
      case threadEnvironment.batch:
        return commands.batch;
      case threadEnvironment.delete:
        return commands.delete;
      case threadEnvironment.settle:
        return commands.settle;
      case threadEnvironment.unsettle:
        return commands.unsettle;
      case threadEnvironment.snooze:
        return commands.snooze;
      case threadEnvironment.unsnooze:
        return commands.unsnooze;
      default:
        return vi.fn();
    }
  },
}));

const target = {
  environmentId: EnvironmentId.make("undo-env"),
  threadId: ThreadId.make("thread"),
};
function currentUndo() {
  const notice = useThreadUndoNotice.getState().notice;
  expect(notice).not.toBeNull();
  return notice!.undo;
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const command of Object.values(commands)) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
  router.navigate.mockClear();
  router.state.location.href = "/";
  router.state.matches[0]!.params = {};
  threadShell.pinnedAt = null;
  threadShell.snoozedUntil = null;
  shellLoaded.current = true;
  shellsByKey.clear();
  useThreadSelectionStore.getState().setVisibleThreadKeys([]);
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("concurrent thread action Undo", () => {
  it.each([
    ["settleThread", "settle", "unsettle", "Settled"],
    ["snoozeThread", "snooze", "unsnooze", "Snoozed"],
    ["unpinThread", "unpin", "pin", "Unpinned"],
    ["archiveThread", "archive", "unarchive", "Archived"],
  ] as const)(
    "%s retains one undo for concurrent successful requests",
    async (handler, action, inverse, notice) => {
      const actions = useThreadActions();
      const run = () =>
        handler === "snoozeThread"
          ? actions.snoozeThread(target, "2099-01-01T09:00:00.000Z")
          : actions[handler](target);
      await Promise.all([run(), run()]);
      expect(commands[action]).toHaveBeenCalledTimes(2);
      expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: notice, count: 1 });
      await currentUndo()();
      expect(commands[inverse]).toHaveBeenCalledOnce();
    },
  );
});

describe("pin", () => {
  it("announces that the thread was pinned", async () => {
    vi.mocked(announce).mockClear();
    await useThreadActions().pinThread(target);
    expect(announce).toHaveBeenCalledExactlyOnceWith("已置顶 1 个会话");
  });
});

describe("unpin Undo", () => {
  it("restores the original snooze after restoring the pin", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = "2030-01-01T09:00:00.000Z";
    await useThreadActions().unpinThread(target);
    vi.mocked(announce).mockClear();
    await currentUndo()();
    expect(announce).not.toHaveBeenCalledWith("已置顶 1 个会话");
    expect(commands.pin).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil: threadShell.snoozedUntil },
    });
    expect(commands.pin.mock.invocationCallOrder[0]).toBeLessThan(
      commands.snooze.mock.invocationCallOrder[0]!,
    );
  });

  it("restores the pin without an already expired snooze", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = "2000-01-01T09:00:00.000Z";
    await useThreadActions().unpinThread(target);
    await currentUndo()();
    expect(commands.pin).toHaveBeenCalledOnce();
    expect(commands.snooze).not.toHaveBeenCalled();
  });

  it("ignores an old notice across hook instances and still restores the latest unpin", async () => {
    const sidebar = useThreadActions();
    const header = useThreadActions();
    await sidebar.unpinThread(target);
    const staleUndo = currentUndo();
    await header.pinThread(target, { orderKey: "a1" });
    await header.unpinThread(target);
    const latestUndo = currentUndo();
    await staleUndo();
    expect(commands.pin).toHaveBeenCalledTimes(1);
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
    expect(commands.pin).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
  });
});

describe("archive Undo", () => {
  it("shows a unified archive toast, unarchives, and returns to the thread when archiving left it", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "update").mockImplementation(() => {});
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    const actions = useThreadActions();
    await actions.archiveThread(target);
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Archived", count: 1 });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "已归档「会话」",
        actionProps: expect.objectContaining({ children: "撤销" }),
      }),
    );
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId: target.threadId },
      }),
    );
  });

  it("navigates to the next or previous sidebar thread when archiving the active thread, or draft when empty", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "update").mockImplementation(() => {});
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const envId = EnvironmentId.make("undo-env");
    const ids = [ThreadId.make("t-1"), ThreadId.make("t-2"), ThreadId.make("t-3")] as const;
    for (const [index, id] of ids.entries()) {
      shellsByKey.set(`${envId}:${id}`, {
        ...threadShell,
        id,
        title: `会话 ${index + 1}`,
        environmentId: envId,
        archivedAt: null,
      });
    }
    useThreadSelectionStore.getState().setVisibleThreadKeys(ids.map((id) => `${envId}:${id}`));

    // Middle thread -> advances to next (t-3).
    router.state.location.href = "/undo-env/t-2";
    router.state.matches[0]!.params = { environmentId: envId, threadId: ids[1] };
    await useThreadActions().archiveThread({ environmentId: envId, threadId: ids[1] });
    expect(router.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: envId, threadId: ids[2] },
    });
    await currentUndo()();
    expect(router.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: envId, threadId: ids[1] },
    });

    // Last thread -> falls back to previous (t-2).
    router.navigate.mockClear();
    router.state.location.href = "/undo-env/t-3";
    router.state.matches[0]!.params = { environmentId: envId, threadId: ids[2] };
    await useThreadActions().archiveThread({ environmentId: envId, threadId: ids[2] });
    expect(router.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: envId, threadId: ids[1] },
    });

    // Only thread left -> falls back to new draft.
    useThreadSelectionStore.getState().setVisibleThreadKeys([`${envId}:${ids[0]}`]);
    router.navigate.mockClear();
    router.state.location.href = "/undo-env/t-1";
    router.state.matches[0]!.params = { environmentId: envId, threadId: ids[0] };
    await useThreadActions().archiveThread({ environmentId: envId, threadId: ids[0] });
    expect(router.navigate).not.toHaveBeenCalled();
    expect(router.state.location.href).toBe("/draft/project");
  });

  it("shows batch count for archiveThreads, restores all on Undo, and restores only succeeded rows on partial failure", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("batch-toast");
    vi.spyOn(toastManager, "update").mockImplementation(() => {});
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const envId = EnvironmentId.make("undo-env");
    const ids = [
      ThreadId.make("t-1"),
      ThreadId.make("t-2"),
      ThreadId.make("t-3"),
      ThreadId.make("t-4"),
    ] as const;
    for (const [index, id] of ids.entries()) {
      shellsByKey.set(`${envId}:${id}`, {
        ...threadShell,
        id,
        title: `会话 ${index + 1}`,
        environmentId: envId,
        pinnedAt: index === 0 ? "2026-01-01T00:00:00.000Z" : null,
        archivedAt: null,
      });
    }
    useThreadSelectionStore.getState().setVisibleThreadKeys(ids.map((id) => `${envId}:${id}`));

    // Full batch (3 threads), including currently viewed t-1 -> advances to t-4.
    commands.batch.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        batch: {
          operation: "archive",
          items: [
            { threadId: ids[0], status: "applied" },
            { threadId: ids[1], status: "applied" },
            { threadId: ids[2], status: "applied" },
          ],
        },
      },
    });
    router.state.location.href = "/undo-env/t-1";
    router.state.matches[0]!.params = { environmentId: envId, threadId: ids[0] };
    const actions = useThreadActions();
    const fullOutcome = await actions.archiveThreads([
      { environmentId: envId, id: ids[0], title: "会话 1" },
      { environmentId: envId, id: ids[1], title: "会话 2" },
      { environmentId: envId, id: ids[2], title: "会话 3" },
    ]);
    expect([...fullOutcome.archivedKeys]).toEqual([
      `${envId}:${ids[0]}`,
      `${envId}:${ids[1]}`,
      `${envId}:${ids[2]}`,
    ]);
    expect(fullOutcome.failures).toEqual([]);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "已归档 3 个会话",
        actionProps: expect.objectContaining({ children: "撤销" }),
      }),
    );
    expect(router.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: envId, threadId: ids[3] },
    });

    router.navigate.mockClear();
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledTimes(3);
    expect(commands.pin).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: envId, threadId: ids[0] },
    });

    // Partial failure: t-1 & t-3 applied, t-2 running, t-4 already_target.
    add.mockClear();
    commands.unarchive.mockClear();
    commands.batch.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        batch: {
          operation: "archive",
          items: [
            { threadId: ids[0], status: "applied" },
            { threadId: ids[1], status: "running" },
            { threadId: ids[2], status: "applied" },
            { threadId: ids[3], status: "already_target" },
          ],
        },
      },
    });
    const partial = await actions.archiveThreads(
      ids.map((id, index) => ({ environmentId: envId, id, title: `会话 ${index + 1}` })),
    );
    expect([...partial.archivedKeys]).toEqual([`${envId}:${ids[0]}`, `${envId}:${ids[2]}`]);
    expect([...partial.prunedKeys]).toEqual([
      `${envId}:${ids[0]}`,
      `${envId}:${ids[2]}`,
      `${envId}:${ids[3]}`,
    ]);
    expect(partial.failures).toEqual(["会话 2 正在运行，未归档"]);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "已归档 2 个会话" }));
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledTimes(2);
    expect(commands.unarchive).toHaveBeenCalledWith({
      environmentId: envId,
      input: { threadId: ids[0] },
    });
    expect(commands.unarchive).toHaveBeenCalledWith({
      environmentId: envId,
      input: { threadId: ids[2] },
    });

    // Single applied + 1 failed -> singular titled toast.
    add.mockClear();
    commands.unarchive.mockClear();
    commands.batch.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        batch: {
          operation: "archive",
          items: [
            { threadId: ids[0], status: "applied" },
            { threadId: ids[1], status: "rejected" },
          ],
        },
      },
    });
    const oneOk = await actions.archiveThreads([
      { environmentId: envId, id: ids[0], title: "会话 1" },
      { environmentId: envId, id: ids[1], title: "会话 2" },
    ]);
    expect([...oneOk.archivedKeys]).toEqual([`${envId}:${ids[0]}`]);
    expect(oneOk.failures).toEqual(["会话 2 未归档"]);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "已归档「会话 1」" }));
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId: envId,
      input: { threadId: ids[0] },
    });

    // Zero applied -> no undo toast.
    add.mockClear();
    commands.batch.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        batch: {
          operation: "archive",
          items: [{ threadId: ids[1], status: "running" }],
        },
      },
    });
    const zeroOk = await actions.archiveThreads([
      { environmentId: envId, id: ids[1], title: "会话 2" },
    ]);
    expect([...zeroOk.archivedKeys]).toEqual([]);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("archive navigation", () => {
  it.each([
    { destination: "/undo-env/thread", expected: "/draft/project" },
    { destination: "/undo-env/other-thread", expected: "/undo-env/other-thread" },
    { destination: "/settings", expected: "/settings" },
  ])("ends at $expected after opening $destination while archiving", async (route) => {
    router.state.location.href = "/undo-env/thread";
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    let finishArchive!: () => void;
    commands.archive.mockReturnValue(
      new Promise((resolve) => {
        finishArchive = () => resolve({ _tag: "Success", value: undefined });
      }),
    );
    const archived = useThreadActions().archiveThread(target);
    router.state.location.href = route.destination;
    finishArchive();
    expect((await archived)._tag).toBe("Success");
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Archived" });
    expect(router.state.location.href).toBe(route.expected);
  });
});

describe("delete navigation", () => {
  it.each([
    { type: "REPLACE", by: "the app's missing-thread redirect", fallsBack: true },
    { type: "PUSH", by: "the user opening another thread", fallsBack: false },
  ])("falls back: $fallsBack after $by while deleting", async ({ type, fallsBack }) => {
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    commands.delete.mockImplementation(async () => {
      for (const listener of router.history.listeners) listener({ action: { type } });
      return { _tag: "Success", value: undefined };
    });
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(router.navigate).toHaveBeenCalledTimes(fallsBack ? 1 : 0);
    expect(router.history.listeners.size).toBe(0);
  });
});

describe("settle and snooze Undo", () => {
  it("shows a settle undo toast, un-settles from it, and closes it after a manual un-settle", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "update").mockImplementation(() => {});
    const close = vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const actions = useThreadActions();
    await actions.settleThread(target);
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Settled", count: 1 });
    expect(add).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "success",
        title: "已标为完成「会话」",
        actionProps: expect.objectContaining({ children: "撤销" }),
      }),
    );
    const undo = currentUndo();
    await actions.unsettleThread(target);
    expect(close).toHaveBeenCalledWith("toast");
    await undo();
    expect(commands.unsettle).toHaveBeenCalledOnce();
  });

  it("re-pins and re-snoozes a thread that settling had cleared", async () => {
    const snoozedUntil = "2030-01-01T09:00:00.000Z";
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = snoozedUntil;
    const actions = useThreadActions();
    await actions.settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.pin).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil },
    });
  });

  it("stops settle restoration if restoring the pin fails", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = "2030-01-01T09:00:00.000Z";
    commands.pin.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("Pin failed")) });
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.pin).toHaveBeenCalledOnce();
    expect(commands.snooze).not.toHaveBeenCalled();
  });

  it("expires an older unpin Undo when the thread is settled", async () => {
    const actions = useThreadActions();
    await actions.unpinThread(target);
    const staleUnpinUndo = currentUndo();
    await actions.settleThread(target);
    await staleUnpinUndo();
    expect(commands.pin).not.toHaveBeenCalled();
  });

  // regression: #12972 the undo notice must reverse a snooze via the unified toast
  it("wakes the thread from the snooze notice", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "update").mockImplementation(() => {});
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const actions = useThreadActions();
    await actions.snoozeThread(target, "2100-01-01T00:00:00.000Z");
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Snoozed", count: 1 });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "已暂缓「会话」",
        actionProps: expect.objectContaining({ children: "撤销" }),
      }),
    );
    await currentUndo()();
    expect(commands.unsnooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  });

  it("restores the prior snoozedUntil when re-snoozing an already-snoozed thread", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "update").mockImplementation(() => {});
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const previousSnooze = "2098-05-01T09:00:00.000Z";
    threadShell.snoozedUntil = previousSnooze;
    await useThreadActions().snoozeThread(target, "2100-01-01T00:00:00.000Z");
    commands.snooze.mockClear();
    await currentUndo()();
    expect(commands.unsnooze).not.toHaveBeenCalled();
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil: previousSnooze },
    });
  });
});

describe("archive and delete Undo expiry", () => {
  const otherThread = { environmentId: target.environmentId, threadId: ThreadId.make("other") };
  const otherEnvironment = {
    environmentId: EnvironmentId.make("other-env"),
    threadId: target.threadId,
  };
  const failure = { _tag: "Failure", cause: Cause.fail(new Error("Request failed")) };

  describe.each(["archiveThread", "deleteThread"] as const)("%s", (lifecycle) => {
    it.each([
      ["settleThread", "unsettle"],
      ["snoozeThread", "unsnooze"],
      ["unpinThread", "pin"],
    ] as const)(
      "expires an earlier %s Undo for that thread only, across hook instances",
      async (handler, inverse) => {
        const sidebar = useThreadActions();
        const header = useThreadActions();
        for (const ref of [otherThread, otherEnvironment, target]) {
          await (handler === "snoozeThread"
            ? sidebar.snoozeThread(ref, "2099-01-01T09:00:00.000Z")
            : sidebar[handler](ref));
        }
        const staleUndo = currentUndo();
        await header[lifecycle](target);
        await staleUndo();
        expect(commands[inverse]).toHaveBeenCalledTimes(2);
        expect(commands[inverse]).not.toHaveBeenCalledWith(
          expect.objectContaining({
            environmentId: target.environmentId,
            input: expect.objectContaining({ threadId: target.threadId }),
          }),
        );
      },
    );

    it("keeps the earlier Undo when the request fails", async () => {
      const actions = useThreadActions();
      await actions.settleThread(target);
      commands[lifecycle === "archiveThread" ? "archive" : "delete"].mockResolvedValue(failure);
      await actions[lifecycle](target);
      expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Settled" });
      await currentUndo()();
      expect(commands.unsettle).toHaveBeenCalledOnce();
    });
  });

  it.each([true, false])(
    "expires the Archived Undo when deleting with shell loaded: %s",
    async (loaded) => {
      const actions = useThreadActions();
      await actions.archiveThread(target);
      const staleUndo = currentUndo();
      shellLoaded.current = loaded;
      await actions.deleteThread(target);
      expect(useThreadUndoNotice.getState().notice).toBeNull();
      await staleUndo();
      expect(commands.unarchive).not.toHaveBeenCalled();
    },
  );
});
