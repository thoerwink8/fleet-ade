import { describe, expect, it } from "vite-plus/test";

import { runEveryTask, type TaskRun } from "./run-every-task.ts";

/** Runs two tasks at a time and stops the batch at the first failure, like `vp run`. */
function fakeRunner(broken: ReadonlyArray<string>) {
  const calls: Array<ReadonlyArray<string>> = [];
  const run = (tasks: ReadonlyArray<string>): TaskRun => {
    calls.push(tasks);
    const outcomes = new Map<string, "passed" | "failed">();
    for (let index = 0; index < tasks.length; index += 2) {
      const batch = tasks.slice(index, index + 2);
      if (batch.some((task) => broken.includes(task))) {
        for (const task of batch) outcomes.set(task, "failed");
        return { status: 1, outcomes };
      }
      for (const task of batch) outcomes.set(task, "passed");
    }
    return { status: 0, outcomes };
  };
  return { calls, run };
}

describe("runEveryTask", () => {
  it.each([
    {
      name: "runs once when everything passes",
      broken: [],
      status: 0,
      failed: [],
      calls: [["a", "b", "c", "d", "e"]],
    },
    {
      name: "clears a task that was only stopped mid-flight and keeps going",
      broken: ["a", "e"],
      status: 1,
      failed: ["a", "e"],
      calls: [["a", "b", "c", "d", "e"], ["a"], ["b"], ["c", "d", "e"]],
    },
    {
      name: "reports both tasks of a batch that really failed",
      broken: ["c", "d"],
      status: 1,
      failed: ["c", "d"],
      calls: [["a", "b", "c", "d", "e"], ["c"], ["d"], ["e"]],
    },
  ])("$name", ({ broken, status, failed, calls }) => {
    const runner = fakeRunner(broken);
    expect(runEveryTask(["a", "b", "c", "d", "e"], runner.run)).toEqual({ status, failed });
    expect(runner.calls).toEqual(calls);
  });

  it("stops when the runner fails without naming a task", () => {
    let calls = 0;
    const result = runEveryTask(["a", "b"], () => {
      calls += 1;
      return { status: 2, outcomes: new Map() };
    });
    expect(result).toEqual({ status: 2, failed: [] });
    expect(calls).toBe(1);
  });
});
