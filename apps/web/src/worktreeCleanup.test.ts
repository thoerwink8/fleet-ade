import {
  EnvironmentId,
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { makeThreadFixture } from "./test-fixtures";
import {
  describeWorktreeCleanupFailure,
  getOrphanedWorktreePathForThread,
} from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "会话",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("getOrphanedWorktreePathForThread", () => {
  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it.each([
    ["/tmp/repo/worktrees/feature-a", "/tmp/repo/worktrees/feature-a/"],
    ["/tmp/repo/worktrees/feature-a", "/tmp/repo/worktrees/feature-a//"],
    ["C:\\repo\\worktrees\\feature-a", "c:/repo/worktrees/feature-a/"],
  ])("treats %s and %s as the same worktree", (targetPath, otherPath) => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: targetPath }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: otherPath }),
    ];
    expect(getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"))).toBeNull();
    expect(getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-2"))).toBeNull();
  });

  it("keeps case-sensitive POSIX worktrees apart", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "/tmp/repo/worktrees/Feature" }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/repo/worktrees/feature" }),
    ];
    expect(getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"))).toBe(
      "/tmp/repo/worktrees/Feature",
    );
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-b",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});

describe("describeWorktreeCleanupFailure", () => {
  const error = new GitCommandError({
    operation: "GitVcsDriver.status",
    command: "git status",
    cwd: "/repo",
    detail: "fatal: index file corrupt",
  });

  it("says the worktree was deleted when only the status refresh failed", () => {
    const toast = describeWorktreeCleanupFailure({ removalFailed: false, error });

    expect(toast.title).toBe("工作树已删除，但无法刷新 Git 状态");
    expect(toast.description).toContain("fatal: index file corrupt");
    expect(toast.title).not.toContain("无法读取");
  });

  it("reports the worktree that could not be removed", () => {
    const toast = describeWorktreeCleanupFailure({
      removalFailed: true,
      error: new GitCommandError({
        operation: "GitVcsDriver.removeWorktree",
        command: "git worktree remove",
        cwd: "/repo",
        detail: "fatal: busy",
      }),
      worktreePath: "~/wt",
    });

    expect(toast.title).toBe("无法删除工作树");
    expect(toast.description.startsWith("无法删除 ~/wt。")).toBe(true);
    expect(toast.description).toContain("fatal: busy");
  });
});
