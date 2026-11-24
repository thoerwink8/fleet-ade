import { describe, expect, it, vi } from "vite-plus/test";

import {
  SCHEDULED_TASK_UNDO_MS,
  createScheduledTaskDeleteUndo,
  scheduledTaskDeletedNotice,
  withoutPendingScheduledTaskDeletes,
  type ScheduledTaskDeleteRecord,
} from "./scheduledTaskDeleteUndo";

const task = {
  id: "nightly",
  title: "检查问题",
  schedule: { type: "interval", everyMs: 60_000 },
  prompt: "看一看",
  enabled: true,
  threadId: "thread-1",
};

function harness() {
  let now = 1_000;
  const records: ScheduledTaskDeleteRecord[] = [];
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const deleteTask = vi.fn((_record: ScheduledTaskDeleteRecord) => Promise.resolve());
  const onDeleteFailed = vi.fn();
  const notices: Array<{ title: string; undo: () => void; closed: boolean }> = [];
  const storage = {
    read: () => records.slice(),
    write: (next: readonly ScheduledTaskDeleteRecord[]) => {
      records.splice(0, records.length, ...next);
    },
  };
  const controller = createScheduledTaskDeleteUndo({
    now: () => now,
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    storage,
    deleteTask,
    onDeleteFailed,
    onUndoNotice: (record, undo) => {
      const notice = {
        title: scheduledTaskDeletedNotice(record.title, undo).title,
        undo,
        closed: false,
      };
      notices.push(notice);
      return {
        close: () => {
          notice.closed = true;
        },
      };
    },
  });
  const expire = () => {
    for (const timer of timers) {
      if (!timer.cancelled) timer.run();
    }
  };
  return {
    controller,
    deleteTask,
    notices,
    records,
    timers,
    expire,
    onDeleteFailed,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("scheduled task delete undo", () => {
  it("undo restores the same task and does not delete it", () => {
    const { controller, deleteTask, notices, records } = harness();
    controller.request({ environmentId: "laptop", taskId: task.id, title: task.title });
    expect(notices[0]?.title).toBe("已删除定时任务「检查问题」");
    expect(scheduledTaskDeletedNotice(task.title, notices[0]!.undo).actionProps.children).toBe(
      "撤销",
    );
    expect(scheduledTaskDeletedNotice(task.title, notices[0]!.undo).timeout).toBe(
      SCHEDULED_TASK_UNDO_MS,
    );
    const hidden = withoutPendingScheduledTaskDeletes([task], controller.hiddenKeys, "laptop");
    expect(hidden).toEqual([]);

    expect(notices[0]?.undo()).toBeUndefined();
    expect(controller.undo("laptop", task.id)).toBe(false);
    expect(deleteTask).not.toHaveBeenCalled();
    expect(records).toEqual([]);
    expect(withoutPendingScheduledTaskDeletes([task], controller.hiddenKeys, "laptop")).toEqual([
      task,
    ]);
    expect(notices[0]?.closed).toBe(true);
  });

  it("expiry deletes the task once, and a dropped caller does not cancel it", async () => {
    const { controller, deleteTask, timers, expire, records } = harness();
    controller.request({ environmentId: "laptop", taskId: task.id, title: task.title });
    expect(timers.map((timer) => timer.ms)).toEqual([SCHEDULED_TASK_UNDO_MS]);
    expect(records).toEqual([
      {
        environmentId: "laptop",
        taskId: task.id,
        title: task.title,
        deleteAt: 1_000 + SCHEDULED_TASK_UNDO_MS,
      },
    ]);
    const orphaned = controller;
    expire();
    expect(deleteTask).toHaveBeenCalledOnce();
    expect(deleteTask).toHaveBeenCalledWith(records[0]);
    await deleteTask.mock.results[0]?.value;
    expect(orphaned.hiddenKeys.has("laptop\0nightly")).toBe(true);
    expect(records).toEqual([]);
    expire();
    expect(deleteTask).toHaveBeenCalledOnce();
  });

  it("a later page finishes a delete that was still waiting", async () => {
    const first = harness();
    first.controller.request({ environmentId: "laptop", taskId: task.id, title: task.title });
    expect(first.deleteTask).not.toHaveBeenCalled();
    const stored = first.records.slice();
    const second = harness();
    second.records.splice(0, 0, ...stored);
    second.controller.resume();
    expect(second.deleteTask).toHaveBeenCalledOnce();
    expect(second.deleteTask).toHaveBeenCalledWith(stored[0]);
    await second.deleteTask.mock.results[0]?.value;
    expect(second.records).toEqual([]);
    expect(second.controller.hiddenKeys.has("laptop\0nightly")).toBe(true);
  });

  it("undo then a later page leaves the task in place", () => {
    const first = harness();
    first.controller.request({ environmentId: "laptop", taskId: task.id, title: task.title });
    first.controller.undo("laptop", task.id);
    const second = harness();
    second.records.splice(0, 0, ...first.records);
    second.controller.resume();
    expect(second.deleteTask).not.toHaveBeenCalled();
    expect(second.controller.hiddenKeys.size).toBe(0);
  });

  it("a failed delete stays hidden so the next page can finish it, and undo still restores it", async () => {
    const { controller, deleteTask, expire, onDeleteFailed, records } = harness();
    deleteTask.mockRejectedValueOnce(new Error("offline"));
    controller.request({ environmentId: "laptop", taskId: task.id, title: task.title });
    expire();
    await deleteTask.mock.results[0]?.value.catch(() => undefined);
    expect(onDeleteFailed).toHaveBeenCalledOnce();
    expect(controller.hiddenKeys.has("laptop\0nightly")).toBe(true);
    expect(records).toHaveLength(1);
    expect(controller.undo("laptop", task.id)).toBe(true);
    expect(records).toEqual([]);
    expect(withoutPendingScheduledTaskDeletes([task], controller.hiddenKeys, "laptop")).toEqual([
      task,
    ]);
  });
});
