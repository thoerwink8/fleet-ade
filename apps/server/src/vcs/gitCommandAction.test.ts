import type { GitCommandAction } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  GIT_COMMAND_OPERATION_ACTIONS,
  GIT_COMMAND_OPERATION_LIST,
  inferGitCommandAction,
  resolveGitCommandAction,
  type KnownGitCommandOperation,
} from "./gitCommandAction.ts";

const EXPECTED_ACTION_OVERRIDES: ReadonlyArray<
  readonly [KnownGitCommandOperation, GitCommandAction]
> = [
  ["GitVcsDriver.getReviewDiffPreview.commitStat", "read_diff"],
  ["GitVcsDriver.getReviewDiffPreview.commitPatch", "read_diff"],
  ["GitVcsDriver.readReviewCommitMessage", "read_diff"],
  ["GitVcsDriver.pushCurrentBranch.push", "push"],
  ["GitVcsDriver.pullCurrentBranch.pull", "pull"],
  ["GitVcsDriver.switchRef.checkout", "switch_branch"],
  ["GitVcsDriver.createBranch", "create_branch"],
  ["GitVcsDriver.createWorktree", "create_worktree"],
  ["GitVcsDriver.removeWorktree", "remove_worktree"],
  ["GitVcsDriver.commit.commit", "commit"],
  ["GitHubSourceControlProvider.checkoutPullRequest.sync", "checkout_pr"],
  ["SourceControlRepositoryService.cloneRepository", "clone"],
  ["SourceControlRepositoryService.publishRepository.switchToHttps", "publish"],
  ["GitVcsDriver.initRepo", "init"],
  ["GitVcsDriver.statusDetails.indexPath", "read_status"],
  ["GitVcsDriver.listRefs.snapshotRefs", "list_branches"],
  ["StorageCleanup.cleanupGit", "cleanup"],
  ["GitVcsDriver.checkpoints.captureCheckpoint", "checkpoint"],
  ["GitVcsDriver.writeConfigValue", "other"],
];

describe("gitCommandAction", () => {
  it.each(GIT_COMMAND_OPERATION_LIST.map((operation) => [operation] as const))(
    "maps %s to a fixed GitCommandAction without substring guessing",
    (operation) => {
      const action = resolveGitCommandAction(operation);
      expect(action).toBe(GIT_COMMAND_OPERATION_ACTIONS[operation]);
      expect(inferGitCommandAction(operation)).toBe(action);
    },
  );

  it.each(EXPECTED_ACTION_OVERRIDES)("classifies %s as %s", (operation, expectedAction) => {
    expect(resolveGitCommandAction(operation)).toBe(expectedAction);
  });

  it("returns undefined for unrecognized or synthetic test operations", () => {
    expect(inferGitCommandAction("test.commitSomething")).toBeUndefined();
    expect(inferGitCommandAction("GitVcsDriver.unknownOperation")).toBeUndefined();
  });
});
