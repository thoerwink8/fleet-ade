import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ScheduledTaskId, type ScheduledTask } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { toastManager } from "../ui/toast";
import {
  createScheduledTaskDeleteUndo,
  scheduledTaskDeletedNotice,
  type ScheduledTaskDeleteRecord,
  type ScheduledTaskDeleteUndo,
} from "./scheduledTaskDeleteUndo";

const STORAGE_KEY = "t3.scheduledTaskPendingDeletes";
const EMPTY_HIDDEN: ReadonlySet<string> = new Set();

function isRecord(value: unknown): value is ScheduledTaskDeleteRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.environmentId === "string" &&
    typeof record.taskId === "string" &&
    typeof record.title === "string" &&
    typeof record.deleteAt === "number"
  );
}

function browserStorage() {
  return {
    read(): ScheduledTaskDeleteRecord[] {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
      } catch {
        return [];
      }
    },
    write(records: readonly ScheduledTaskDeleteRecord[]) {
      try {
        if (records.length === 0) window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
      } catch {
        // A full disk must not block the notice. The in-memory timer still deletes.
      }
    },
  };
}

let controller: ScheduledTaskDeleteUndo | null = null;
let resumed = false;

function getController(): ScheduledTaskDeleteUndo | null {
  if (typeof window === "undefined") return null;
  if (controller !== null) return controller;
  const created = createScheduledTaskDeleteUndo({
    now: () => Date.now(),
    schedule: (run, ms) => {
      const id = window.setTimeout(run, ms);
      return () => window.clearTimeout(id);
    },
    storage: browserStorage(),
    deleteTask: async (record) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.deleteScheduledTask,
        {
          environmentId: EnvironmentId.make(record.environmentId),
          input: { id: ScheduledTaskId.make(record.taskId) },
        },
        { label: "scheduled task delete", reportFailure: false, reportDefect: false },
      );
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        if (result._tag === "Success") return;
        throw new Error("删除没有完成，任务还在。");
      }
      const failure = squashAtomCommandFailure(result);
      throw new Error(failure instanceof Error ? failure.message : String(failure));
    },
    onUndoNotice: (record, undo) => {
      const id = toastManager.add(scheduledTaskDeletedNotice(record.title, undo));
      return {
        close() {
          if (id != null) toastManager.close(id);
        },
      };
    },
    onDeleteFailed: (record) => {
      toastManager.add({
        type: "error",
        title: "无法删除定时任务",
        description: "没能删除这个任务。重新打开后会再试，也可以先撤销。",
        timeout: 8_000,
        actionProps: {
          children: "撤销",
          onClick: () => {
            created.undo(record.environmentId, record.taskId);
          },
        },
      });
    },
  });
  controller = created;
  return created;
}

/** Finish deletes the previous page stored, and finish again if this page is discarded. */
export function startScheduledTaskDeleteUndo(): void {
  const current = getController();
  if (current === null || resumed) return;
  resumed = true;
  current.resume();
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    current.commitAll();
  });
}

export function requestScheduledTaskDelete(
  environmentId: EnvironmentId,
  task: Pick<ScheduledTask, "id" | "title">,
): void {
  getController()?.request({ environmentId, taskId: task.id, title: task.title });
}

export function useScheduledTaskDeleteHidden(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => getController()?.subscribe(listener) ?? (() => {}),
    () => getController()?.hiddenKeys ?? EMPTY_HIDDEN,
    () => getController()?.hiddenKeys ?? EMPTY_HIDDEN,
  );
}
