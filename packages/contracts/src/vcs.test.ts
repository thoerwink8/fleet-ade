import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectCloneSnapshot } from "./projectClone.ts";
import { SourceControlProviderKind, SourceControlRepositoryError } from "./sourceControl.ts";
import { VcsProcessExitError, VcsProcessExitFailureKind, VcsProcessSpawnError } from "./vcs.ts";
import { WorktreeSetupSnapshot } from "./worktreeSetup.ts";

const decodeVcsProcessExitError = Schema.decodeUnknownSync(Schema.toCodecJson(VcsProcessExitError));
const encodeVcsProcessExitError = Schema.encodeSync(Schema.toCodecJson(VcsProcessExitError));
const decodeVcsProcessSpawnError = Schema.decodeUnknownSync(
  Schema.toCodecJson(VcsProcessSpawnError),
);
const encodeVcsProcessSpawnError = Schema.encodeSync(Schema.toCodecJson(VcsProcessSpawnError));
const decodeSourceControlRepositoryError = Schema.decodeUnknownSync(
  Schema.toCodecJson(SourceControlRepositoryError),
);
const decodeProjectCloneSnapshot = Schema.decodeUnknownSync(
  Schema.toCodecJson(ProjectCloneSnapshot),
);
const decodeWorktreeSetupSnapshot = Schema.decodeUnknownSync(
  Schema.toCodecJson(WorktreeSetupSnapshot),
);

class LegacyVcsProcessExitError extends Schema.TaggedError<LegacyVcsProcessExitError>()(
  "VcsProcessExitError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(Schema.Number),
    exitCode: Schema.Number,
    detail: Schema.String,
    failureKind: Schema.optional(VcsProcessExitFailureKind),
    retryable: Schema.optional(Schema.Boolean),
    stderrLength: Schema.optional(Schema.Number),
    stderrTruncated: Schema.optional(Schema.Boolean),
  },
) {}

class LegacyVcsProcessSpawnError extends Schema.TaggedError<LegacyVcsProcessSpawnError>()(
  "VcsProcessSpawnError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {}

const decodeLegacyVcsProcessExitErrorJson = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(LegacyVcsProcessExitError)),
);
const decodeLegacyVcsProcessSpawnErrorJson = Schema.decodeSync(
  Schema.fromJsonString(Schema.toCodecJson(LegacyVcsProcessSpawnError)),
);

describe("VcsProcess errors", () => {
  it("decodes legacy payloads without reason and unknown newer reasons as absent", () => {
    const legacyExit = decodeVcsProcessExitError({
      _tag: "VcsProcessExitError",
      operation: "checkpoint.capture",
      command: "git",
      cwd: "/repo",
      exitCode: 128,
      detail: "Git index is locked.",
      failureKind: "command-failed",
    });
    expect(legacyExit.reason).toBeUndefined();

    const newerExit = decodeVcsProcessExitError({
      _tag: "VcsProcessExitError",
      operation: "checkpoint.capture",
      command: "git",
      cwd: "/repo",
      exitCode: 128,
      detail: "Git index is locked.",
      failureKind: "command-failed",
      reason: "added_by_a_newer_server",
    });
    expect(newerExit.reason).toBeUndefined();

    const legacySpawn = decodeVcsProcessSpawnError({
      _tag: "VcsProcessSpawnError",
      operation: "checkpoint.capture",
      command: "git",
      cwd: "/repo",
      cause: { message: "ENOENT" },
    });
    expect(legacySpawn.reason).toBeUndefined();

    const newerSpawn = decodeVcsProcessSpawnError({
      _tag: "VcsProcessSpawnError",
      operation: "checkpoint.capture",
      command: "git",
      cwd: "/repo",
      reason: "added_by_a_newer_server",
      cause: { message: "ENOENT" },
    });
    expect(newerSpawn.reason).toBeUndefined();
  });

  it("allows legacy VcsProcessExitError and VcsProcessSpawnError decoders to ignore reason", () => {
    const encodedExit = encodeVcsProcessExitError(
      new VcsProcessExitError({
        operation: "checkpoint.capture",
        command: "git",
        cwd: "/repo",
        exitCode: 128,
        detail: "Git index is locked.",
        failureKind: "command-failed",
        reason: "index_locked",
      }),
    );
    const decodedLegacyExit = decodeLegacyVcsProcessExitErrorJson(JSON.stringify(encodedExit));
    expect(decodedLegacyExit.failureKind).toBe("command-failed");

    const encodedSpawn = encodeVcsProcessSpawnError(
      VcsProcessSpawnError.fromProcessSpawnError(
        { operation: "checkpoint.capture", command: "git", cwd: "/repo" },
        { cause: new Error("ENOENT") },
        "executable_not_found",
      ),
    );
    const decodedLegacySpawn = decodeLegacyVcsProcessSpawnErrorJson(JSON.stringify(encodedSpawn));
    expect(decodedLegacySpawn.command).toBe("git");
  });
});

describe("SourceControlRepositoryError and snapshot schemas", () => {
  it("decodes legacy and forward-compatible snapshot failures", () => {
    const repoError = decodeSourceControlRepositoryError({
      _tag: "SourceControlRepositoryError",
      provider: SourceControlProviderKind.make("github"),
      operation: "cloneRepository",
      reason: "added_by_a_newer_server",
      detail: "exists",
    });
    expect(repoError.reason).toBeUndefined();

    const legacyClone = decodeProjectCloneSnapshot({
      projectId: "project-1",
      remoteUrl: "https://example.com/repo.git",
      destinationPath: "/workspace/repo",
      repository: null,
      phase: "failed",
      stage: "connecting",
      percent: null,
      detail: null,
      error: "Git failed.",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:05.000Z",
      sequence: 1,
    });
    expect(legacyClone.failure).toBeUndefined();

    const withFailureClone = decodeProjectCloneSnapshot({
      projectId: "project-1",
      remoteUrl: "https://example.com/repo.git",
      destinationPath: "/workspace/repo",
      repository: null,
      phase: "failed",
      stage: "connecting",
      percent: null,
      detail: null,
      error: "Git failed.",
      failure: {
        _tag: "GitCommandError",
        operation: "SourceControlRepositoryService.cloneRepository",
        action: "clone",
        reason: "authentication_failed",
        detail: "Git failed.",
      },
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:05.000Z",
      sequence: 2,
    });
    expect(withFailureClone.failure?.reason).toBe("authentication_failed");

    const legacySetup = decodeWorktreeSetupSnapshot({
      threadId: "thread-1",
      phase: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:05.000Z",
      branch: "feature",
      baseRef: "main",
      worktreePath: "/workspace/wt",
      setupScript: null,
      stages: [],
      error: "git worktree add failed",
      sequence: 1,
    });
    expect(legacySetup.failure).toBeUndefined();
  });
});
