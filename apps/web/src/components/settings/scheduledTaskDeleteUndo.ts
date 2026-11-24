export const SCHEDULED_TASK_UNDO_MS = 8_000;
/** A delete that cannot reach the server (still connecting, or offline) is tried again. */
export const SCHEDULED_TASK_DELETE_RETRY_MS = 4_000;
export const SCHEDULED_TASK_DELETE_ATTEMPTS = 5;

export type ScheduledTaskDeleteRecord = {
  readonly environmentId: string;
  readonly taskId: string;
  readonly title: string;
  readonly deleteAt: number;
};

function scheduledTaskDeleteKey(environmentId: string, taskId: string): string {
  return `${environmentId}\0${taskId}`;
}

function isScheduledTaskDeleteHidden(
  hidden: ReadonlySet<string>,
  environmentId: string,
  taskId: string,
): boolean {
  return hidden.has(scheduledTaskDeleteKey(environmentId, taskId));
}

function sameRecord(a: ScheduledTaskDeleteRecord, b: ScheduledTaskDeleteRecord): boolean {
  return a.environmentId === b.environmentId && a.taskId === b.taskId;
}

export function withoutPendingScheduledTaskDeletes<T extends { readonly id: string }>(
  tasks: readonly T[],
  hidden: ReadonlySet<string>,
  environmentId: string,
): readonly T[] {
  return tasks.filter((task) => !isScheduledTaskDeleteHidden(hidden, environmentId, task.id));
}

export function scheduledTaskDeletedNotice(title: string, undo: () => void) {
  return {
    type: "success" as const,
    title: `已删除定时任务「${title}」`,
    timeout: SCHEDULED_TASK_UNDO_MS,
    actionProps: { children: "撤销" as const, onClick: undo },
  };
}

export type ScheduledTaskDeleteUndo = {
  readonly hiddenKeys: ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
  request(input: { environmentId: string; taskId: string; title: string }): void;
  undo(environmentId: string, taskId: string): boolean;
  /** Finish every delete another page left behind, once its window has passed. */
  resume(): void;
  /** Finish now. Used when the page is going away and the notice cannot stay. */
  commitAll(): void;
};

/**
 * The server delete drops the webhook secret and run history, so undo keeps the row
 * until the notice ends. The record is stored before the timer, and a later page finishes it.
 */
export function createScheduledTaskDeleteUndo(deps: {
  readonly now: () => number;
  readonly schedule: (run: () => void, ms: number) => () => void;
  readonly storage: {
    read(): readonly ScheduledTaskDeleteRecord[];
    write(records: readonly ScheduledTaskDeleteRecord[]): void;
  };
  readonly deleteTask: (record: ScheduledTaskDeleteRecord) => Promise<void>;
  readonly onUndoNotice?: (
    record: ScheduledTaskDeleteRecord,
    undo: () => void,
  ) => { close(): void };
  readonly onDeleteFailed?: (record: ScheduledTaskDeleteRecord) => void;
}): ScheduledTaskDeleteUndo {
  const pending = new Map<string, ScheduledTaskDeleteRecord>();
  const committed = new Set<string>();
  const committing = new Set<string>();
  const attempts = new Map<string, number>();
  const timers = new Map<string, () => void>();
  const notices = new Map<string, { close(): void }>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlySet<string> = new Set();

  const persist = () => {
    deps.storage.write([...pending.values()]);
  };

  const publish = () => {
    snapshot = new Set([...pending.keys(), ...committed]);
    for (const listener of listeners) listener();
  };

  const cancelTimer = (key: string) => {
    timers.get(key)?.();
    timers.delete(key);
  };

  const closeNotice = (key: string) => {
    notices.get(key)?.close();
    notices.delete(key);
  };

  const commit = (record: ScheduledTaskDeleteRecord) => {
    const key = scheduledTaskDeleteKey(record.environmentId, record.taskId);
    if (committing.has(key) || !pending.has(key)) return;
    committing.add(key);
    cancelTimer(key);
    closeNotice(key);
    void deps.deleteTask(record).then(
      () => {
        committing.delete(key);
        attempts.delete(key);
        if (!pending.has(key)) return;
        pending.delete(key);
        committed.add(key);
        persist();
        publish();
      },
      () => {
        committing.delete(key);
        // Keep the stored delete. A dropped connection must not bring the task back on reload.
        if (!pending.has(key)) return;
        const tried = (attempts.get(key) ?? 0) + 1;
        if (tried < SCHEDULED_TASK_DELETE_ATTEMPTS) {
          attempts.set(key, tried);
          timers.set(
            key,
            deps.schedule(() => commit(record), SCHEDULED_TASK_DELETE_RETRY_MS),
          );
          return;
        }
        attempts.delete(key);
        deps.onDeleteFailed?.(record);
      },
    );
  };

  const arm = (record: ScheduledTaskDeleteRecord, fromStorage: boolean) => {
    const key = scheduledTaskDeleteKey(record.environmentId, record.taskId);
    cancelTimer(key);
    const cancel = deps.schedule(
      () => {
        // Another page owns a record this page only found in storage. If that page took the
        // delete back, the record is gone and the task stays.
        if (fromStorage && !deps.storage.read().some((stored) => sameRecord(stored, record))) {
          pending.delete(key);
          publish();
          return;
        }
        commit(record);
      },
      Math.max(0, record.deleteAt - deps.now()),
    );
    timers.set(key, cancel);
  };

  const api: ScheduledTaskDeleteUndo = {
    get hiddenKeys() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request(input) {
      const key = scheduledTaskDeleteKey(input.environmentId, input.taskId);
      if (committing.has(key) || committed.has(key)) return;
      const record: ScheduledTaskDeleteRecord = {
        ...input,
        deleteAt: deps.now() + SCHEDULED_TASK_UNDO_MS,
      };
      pending.set(key, record);
      persist();
      publish();
      closeNotice(key);
      const notice = deps.onUndoNotice?.(record, () => {
        api.undo(input.environmentId, input.taskId);
      });
      if (notice) notices.set(key, notice);
      arm(record, false);
    },
    undo(environmentId, taskId) {
      const key = scheduledTaskDeleteKey(environmentId, taskId);
      if (committing.has(key) || !pending.has(key)) return false;
      pending.delete(key);
      attempts.delete(key);
      cancelTimer(key);
      closeNotice(key);
      persist();
      publish();
      return true;
    },
    resume() {
      for (const record of deps.storage.read()) {
        const key = scheduledTaskDeleteKey(record.environmentId, record.taskId);
        if (pending.has(key) || committed.has(key) || committing.has(key)) continue;
        pending.set(key, record);
        publish();
        // A record still inside its window belongs to a page that may be open. Wait for it.
        arm(record, true);
      }
    },
    commitAll() {
      for (const record of pending.values()) commit(record);
    },
  };

  return api;
}
