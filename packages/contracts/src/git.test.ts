import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ForwardCompatibleOptional } from "./baseSchemas.ts";
import {
  GitCommandError,
  GitManagerError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
  TextGenerationError,
  VcsSnapshotFailure,
} from "./git.ts";

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const encodeGitCommandError = Schema.encodeSync(Schema.toCodecJson(GitCommandError));
const decodeGitManagerError = Schema.decodeUnknownSync(Schema.toCodecJson(GitManagerError));
const encodeGitManagerError = Schema.encodeSync(Schema.toCodecJson(GitManagerError));
const decodeTextGenerationError = Schema.decodeUnknownSync(Schema.toCodecJson(TextGenerationError));
const encodeTextGenerationError = Schema.encodeSync(Schema.toCodecJson(TextGenerationError));
const decodeVcsSnapshotFailure = Schema.decodeUnknownSync(Schema.toCodecJson(VcsSnapshotFailure));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);

const LegacyGitCommandFailureReason = Schema.Literals([
  "authentication_failed",
  "branch_already_exists",
  "branch_checked_out_in_worktree",
  "config_locked",
  "host_key_unverified",
  "not_a_repository",
  "path_already_exists",
  "push_rejected_by_remote",
  "push_rejected_non_fast_forward",
  "ref_name_conflict",
  "ref_not_found",
  "remote_unreachable",
  "tag_would_be_clobbered",
]);

class LegacyGitCommandError extends Schema.TaggedError<LegacyGitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  stdoutLength: Schema.optional(Schema.Number),
  stderrLength: Schema.optional(Schema.Number),
  outputLength: Schema.optional(Schema.Number),
  reason: ForwardCompatibleOptional(LegacyGitCommandFailureReason),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

class LegacyGitManagerError extends Schema.TaggedError<LegacyGitManagerError>()("GitManagerError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

class LegacyTextGenerationError extends Schema.TaggedError<LegacyTextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const decodeLegacyGitCommandErrorJson = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(LegacyGitCommandError)),
);
const decodeLegacyGitManagerErrorJson = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(LegacyGitManagerError)),
);
const decodeLegacyTextGenerationErrorJson = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(LegacyTextGenerationError)),
);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason and action as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      action: "added_by_a_newer_server",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.action).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });

  it("decodes legacy payloads without action or reason", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.pullCurrentBranch.pull",
      command: "git",
      cwd: "/repo",
      detail: "git pull failed",
    });

    expect(error.action).toBeUndefined();
    expect(error.reason).toBeUndefined();
    expect(error.detail).toBe("git pull failed");
  });

  it("remains decodable by a legacy decoder when new reason and action fields are present", () => {
    const encoded = encodeGitCommandError(
      new GitCommandError({
        operation: "GitVcsDriver.pullCurrentBranch.pull",
        action: "pull",
        command: "git",
        cwd: "/repo",
        reason: "not_fast_forward",
        detail: "git pull failed",
      }),
    );

    const decodedByLegacy = decodeLegacyGitCommandErrorJson(JSON.stringify(encoded));
    expect(decodedByLegacy.reason).toBeUndefined();
    expect(decodedByLegacy.detail).toBe("git pull failed");
    expect((decodedByLegacy as { action?: unknown }).action).toBeUndefined();
  });

  it("round-trips network_unreachable and reads as absent to a legacy decoder", () => {
    const encoded = encodeGitCommandError(
      new GitCommandError({
        operation: "SourceControlRepositoryService.cloneRepository",
        action: "clone",
        command: "git",
        cwd: "/repo",
        reason: "network_unreachable",
        detail: "git clone failed",
      }),
    );

    expect(decodeGitCommandError(encoded).reason).toBe("network_unreachable");
    expect(decodeLegacyGitCommandErrorJson(JSON.stringify(encoded)).reason).toBeUndefined();
  });
});

describe("GitManagerError and TextGenerationError", () => {
  it("decodes legacy errors without reason and newer unknown reasons as absent", () => {
    const legacyManager = decodeGitManagerError({
      _tag: "GitManagerError",
      operation: "preparePullRequestThread",
      cwd: "/repo",
      detail: "Commit or stash your tracked changes before switching branches.",
    });
    expect(legacyManager.reason).toBeUndefined();

    const unknownManager = decodeGitManagerError({
      _tag: "GitManagerError",
      operation: "preparePullRequestThread",
      cwd: "/repo",
      reason: "added_by_a_newer_server",
      detail: "dirty",
    });
    expect(unknownManager.reason).toBeUndefined();

    const encodedManager = encodeGitManagerError(
      new GitManagerError({
        operation: "preparePullRequestThread",
        cwd: "/repo",
        reason: "working_tree_dirty",
        detail: "dirty",
      }),
    );
    expect(decodeLegacyGitManagerErrorJson(JSON.stringify(encodedManager)).detail).toBe("dirty");

    const legacyTextGen = decodeTextGenerationError({
      _tag: "TextGenerationError",
      operation: "generateCommitMessage",
      detail: "Codex CLI request timed out.",
    });
    expect(legacyTextGen.reason).toBeUndefined();

    const unknownTextGen = decodeTextGenerationError({
      _tag: "TextGenerationError",
      operation: "generateCommitMessage",
      reason: "added_by_a_newer_server",
      detail: "failed",
    });
    expect(unknownTextGen.reason).toBeUndefined();

    const encodedTextGen = encodeTextGenerationError(
      new TextGenerationError({
        operation: "generateCommitMessage",
        reason: "rate_limited",
        detail: "rate limited",
      }),
    );
    expect(decodeLegacyTextGenerationErrorJson(JSON.stringify(encodedTextGen)).detail).toBe(
      "rate limited",
    );
  });

  it("decodes VcsSnapshotFailure with unknown actions and legacy-compatible fields", () => {
    const failure = decodeVcsSnapshotFailure({
      _tag: "GitCommandError",
      operation: "ManagedProjectFolders.commit",
      action: "added_by_a_newer_server",
      reason: "author_identity_unknown",
      detail: "Git has no name or email.",
    });
    expect(failure.action).toBeUndefined();
    expect(failure.reason).toBe("author_identity_unknown");
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("GitRunStackedActionInput", () => {
  it("preserves leading and trailing whitespace in file paths", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      filePaths: [" leading.txt", "trailing.txt "],
    });

    expect(parsed.filePaths).toEqual([" leading.txt", "trailing.txt "]);
  });
});
