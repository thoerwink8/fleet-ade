export interface TaskRun {
  readonly status: number;
  /** Tasks the runner started. A task it never reached is absent. */
  readonly outcomes: ReadonlyMap<string, "passed" | "failed">;
}

/**
 * `vp run` stops at the first failed task and reports the tasks it killed mid-flight as failed too.
 * Reruns each stopped task alone to tell the two apart, then runs whatever was never reached.
 */
export function runEveryTask(
  tasks: ReadonlyArray<string>,
  run: (tasks: ReadonlyArray<string>, alone: boolean) => TaskRun,
): { readonly status: number; readonly failed: ReadonlyArray<string> } {
  const failed: Array<string> = [];
  let status = 0;
  let pending = [...tasks];
  while (pending.length > 0) {
    const result = run(pending, false);
    if (result.status === 0) break;
    status ||= result.status;
    const stopped = pending.filter((task) => result.outcomes.get(task) === "failed");
    if (stopped.length === 0) break;
    for (const task of stopped) {
      if (stopped.length === 1 || run([task], true).status !== 0) failed.push(task);
    }
    pending = pending.filter((task) => !result.outcomes.has(task));
  }
  return { status, failed };
}
