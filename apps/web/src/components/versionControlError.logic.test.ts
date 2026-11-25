import {
  GitCommandError,
  GitManagerError,
  GitPullRequestMaterializationError,
  SourceControlProviderError,
  SourceControlRepositoryError,
  SourceControlSignInError,
  TextGenerationError,
  VcsProcessExitError,
  VcsProcessMissingExitCodeError,
  VcsProcessOutputLimitError,
  VcsProcessOutputReadError,
  VcsProcessSpawnError,
  VcsProcessStdinWriteError,
  VcsProcessTimeoutError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type GitCommandFailureReason,
  type SourceControlProviderKind,
  type SourceControlSignInFailure,
  type VcsProcessExitFailureKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeVersionControlError,
  joinNextStepAndDetail,
  operationAction,
  operationMethodName,
  presentVersionControlError,
  type VersionControlError,
} from "./versionControlError.logic";

const provider = "github" as SourceControlProviderKind;
const rawDetail = "fatal: raw git output\nerror: keep this verbatim";
const GENERIC = "请根据详情中的原因处理，然后重试。";
const AUTH = "请检查托管平台的登录状态和访问权限，然后重试。";

const processContext = (operation: string) => ({ operation, command: "git", cwd: "/repo" });
const gitError = (operation: string, reason?: GitCommandFailureReason) =>
  new GitCommandError({ ...processContext(operation), detail: rawDetail, reason });

interface ErrorCase {
  readonly name: string;
  readonly error: VersionControlError;
  readonly fallbackAction?: string;
  readonly title: string;
  readonly nextStep: string;
  readonly detail: string;
}

const cases: ReadonlyArray<ErrorCase> = [
  {
    name: "GitCommandError with a reason",
    error: gitError("GitVcsDriver.pushCurrentBranch", "push_rejected_non_fast_forward"),
    title: "无法推送",
    nextStep: "请先拉取远端改动，再重新推送。",
    detail: rawDetail,
  },
  {
    name: "TextGenerationError",
    error: new TextGenerationError({ operation: "generateCommitMessage", detail: rawDetail }),
    title: "无法生成提交说明",
    nextStep: "请检查智能体的登录状态和可用性，然后重试。",
    detail: rawDetail,
  },
  {
    name: "GitManagerError on an unknown operation",
    error: new GitManagerError({ operation: "runStackedAction", cwd: "/repo", detail: rawDetail }),
    fallbackAction: "提交",
    title: "无法提交",
    nextStep: "请确认已选择要提交的改动，且没有未解决的冲突，然后重试。",
    detail: rawDetail,
  },
  {
    name: "GitPullRequestMaterializationError",
    error: new GitPullRequestMaterializationError({
      cwd: "/repo",
      pullRequestNumber: 42,
      headRepository: "owner/repo",
      headBranch: "feature",
      localBranch: "pr-42",
      cause: new Error(rawDetail),
    }),
    title: "无法检出 PR",
    nextStep: "请确认分支和工作树目录可用，然后重试。",
    detail: "Failed to materialize pull request #42 branch feature as pr-42.",
  },
  {
    name: "SourceControlProviderError creating a PR",
    error: new SourceControlProviderError({
      provider,
      operation: "createChangeRequest",
      cwd: "/repo",
      detail: rawDetail,
    }),
    title: "无法创建 PR",
    nextStep: "请检查托管平台的登录状态、访问权限和网络连接，然后重试。",
    detail: rawDetail,
  },
  {
    name: "SourceControlRepositoryError cloning",
    error: new SourceControlRepositoryError({
      provider,
      operation: "cloneRepository",
      detail: rawDetail,
    }),
    title: "无法克隆仓库",
    nextStep: "请确认仓库地址正确，且账号有访问权限，然后重试。",
    detail: rawDetail,
  },
  {
    name: "SourceControlRepositoryError looking up",
    error: new SourceControlRepositoryError({
      provider,
      operation: "lookupRepository",
      detail: rawDetail,
    }),
    title: "无法查询仓库",
    nextStep: "请确认仓库地址正确，且账号有访问权限，然后重试。",
    detail: rawDetail,
  },
  {
    name: "SourceControlRepositoryError publishing",
    error: new SourceControlRepositoryError({
      provider,
      operation: "publishRepository",
      detail: rawDetail,
    }),
    title: "无法发布仓库",
    nextStep: "请确认仓库名未被占用，且账号可以创建仓库，然后重试。",
    detail: rawDetail,
  },
  {
    name: "VcsProcessSpawnError",
    error: new VcsProcessSpawnError({
      ...processContext("GitVcsDriver.pushCurrentBranch"),
      cause: new Error("spawn git ENOENT"),
    }),
    title: "无法推送",
    nextStep: "请确认版本控制工具已安装且可以运行，然后重试。",
    detail: "VCS process failed to spawn in GitVcsDriver.pushCurrentBranch: git (/repo)",
  },
  {
    name: "VcsProcessExitError rate limited",
    error: new VcsProcessExitError({
      ...processContext("GitVcsDriver.pushCurrentBranch"),
      exitCode: 1,
      detail: rawDetail,
      failureKind: "rate-limited",
    }),
    title: "无法推送",
    nextStep: "托管平台正在限制请求，请稍后再试。",
    detail: rawDetail,
  },
  {
    name: "VcsProcessTimeoutError",
    error: new VcsProcessTimeoutError({
      ...processContext("GitVcsDriver.pushCurrentBranch"),
      timeoutMs: 45_000,
    }),
    title: "无法推送",
    nextStep: "超过 45 秒未完成，请检查网络连接和仓库状态，然后重试。",
    detail: "VCS process timed out in GitVcsDriver.pushCurrentBranch: git (/repo) after 45000ms",
  },
  {
    name: "VcsProcessOutputLimitError",
    error: new VcsProcessOutputLimitError({
      ...processContext("GitVcsDriver.pushCurrentBranch"),
      stream: "stdout",
      maxBytes: 100,
      observedBytes: 101,
    }),
    title: "无法推送",
    nextStep: "输出内容过大，请在终端里运行此命令。",
    detail:
      "VCS process stdout produced 101 bytes in GitVcsDriver.pushCurrentBranch: git (/repo), exceeding the 100 byte limit",
  },
  {
    name: "VcsProcessStdinWriteError",
    error: new VcsProcessStdinWriteError({
      ...processContext("GitVcsDriver.commit"),
      stdinBytes: 10,
      cause: new Error(rawDetail),
    }),
    title: "无法提交",
    nextStep: "请重试；如果仍然失败，请检查版本控制工具是否正常运行。",
    detail: "VCS process failed to write 10 bytes to stdin in GitVcsDriver.commit: git (/repo)",
  },
  {
    name: "VcsProcessOutputReadError",
    error: new VcsProcessOutputReadError({
      ...processContext("GitVcsDriver.commit"),
      stream: "stderr",
      cause: new Error(rawDetail),
    }),
    title: "无法提交",
    nextStep: "请重试；如果仍然失败，请检查版本控制工具是否正常运行。",
    detail: "VCS process failed to read stderr in GitVcsDriver.commit: git (/repo)",
  },
  {
    name: "VcsProcessMissingExitCodeError",
    error: new VcsProcessMissingExitCodeError(processContext("GitVcsDriver.commit")),
    title: "无法提交",
    nextStep: "请重试；如果仍然失败，请检查版本控制工具是否正常运行。",
    detail: "VCS process completed without an exit code in GitVcsDriver.commit: git (/repo)",
  },
  {
    name: "VcsRepositoryDetectionError",
    error: new VcsRepositoryDetectionError({
      operation: "status",
      cwd: "/repo",
      detail: rawDetail,
    }),
    title: "无法读取 Git 状态",
    nextStep: "请确认目录存在，并且版本控制工具可以读取。",
    detail: rawDetail,
  },
  {
    name: "VcsUnsupportedOperationError",
    error: new VcsUnsupportedOperationError({
      operation: "review.diffFilePatch",
      kind: "git",
      detail: rawDetail,
    }),
    title: "无法加载文件差异",
    nextStep: "当前版本控制工具不支持此操作。",
    detail: rawDetail,
  },
  {
    name: "SourceControlSignInError",
    error: new SourceControlSignInError({
      provider,
      host: "github.com",
      reason: "expired",
      detail: rawDetail,
    }),
    title: "无法登录托管平台",
    nextStep: "请重新开始登录，并在验证码过期前完成授权。",
    detail: rawDetail,
  },
];

describe("describeVersionControlError", () => {
  it.each(cases)("presents $name", ({ error, fallbackAction, title, nextStep, detail }) => {
    expect(describeVersionControlError(error, fallbackAction)).toEqual({
      title,
      nextStep,
      detail,
    });
  });

  const gitReasons: ReadonlyArray<readonly [GitCommandFailureReason, string]> = [
    ["authentication_failed", AUTH],
    ["branch_already_exists", "请换一个分支名称，或选择已有分支。"],
    ["branch_checked_out_in_worktree", "请选择其他分支，或先移除已检出该分支的工作树。"],
    ["config_locked", "请等正在修改 Git 配置的进程结束，然后重试。"],
    ["host_key_unverified", "请先在终端连接此托管平台并确认主机密钥，然后重试。"],
    ["not_a_repository", "请选择 Git 仓库目录，或先初始化 Git。"],
    ["path_already_exists", "请选择其他目录，或移走同名文件后重试。"],
    ["push_rejected_by_remote", "请根据详情中的拒绝原因处理，然后重试。"],
    ["push_rejected_non_fast_forward", "请先拉取远端改动，再重新推送。"],
    ["ref_name_conflict", "请换一个不与现有分支或标签冲突的名称。"],
    ["ref_not_found", "请刷新分支列表，确认分支或标签仍然存在。"],
    ["remote_unreachable", "请检查网络连接和远端仓库地址，然后重试。"],
    ["tag_would_be_clobbered", "请先同步远端标签，或保留本地同名标签后重试。"],
  ];

  it.each(gitReasons)("gives Git reason %s its own next step", (reason, nextStep) => {
    const error = new GitCommandError({
      ...processContext("GitVcsDriver.pushCurrentBranch"),
      detail: "unrelated diagnostic words",
      reason,
    });

    expect(describeVersionControlError(error)).toEqual({
      title: "无法推送",
      nextStep,
      detail: "unrelated diagnostic words",
    });
  });

  const failureKinds: ReadonlyArray<readonly [VcsProcessExitFailureKind | undefined, string]> = [
    ["authentication", AUTH],
    ["not-found", "请确认仓库、分支或 PR 仍然存在，然后重试。"],
    ["rate-limited", "托管平台正在限制请求，请稍后再试。"],
    ["command-failed", "请确认远端地址正确、你有推送权限，然后重试。"],
    [undefined, "请确认远端地址正确、你有推送权限，然后重试。"],
  ];

  it.each(failureKinds)(
    "gives process failure kind %s its own next step",
    (failureKind, nextStep) => {
      const error = new VcsProcessExitError({
        ...processContext("GitVcsDriver.pushCurrentBranch"),
        exitCode: 1,
        detail: rawDetail,
        ...(failureKind === undefined ? {} : { failureKind }),
      });

      expect(describeVersionControlError(error).nextStep).toBe(nextStep);
    },
  );

  const signInReasons: ReadonlyArray<readonly [SourceControlSignInFailure, string]> = [
    ["unsupported", "当前托管平台不支持此登录方式，请改用访问令牌或托管平台的命令行工具登录。"],
    ["not-started", "请重新开始登录。"],
    ["cancelled", "请重新开始登录，并完成授权。"],
    ["denied", "请在托管平台允许访问后重试。"],
    ["expired", "请重新开始登录，并在验证码过期前完成授权。"],
    ["failed", "请检查网络连接和登录状态，然后重试。"],
  ];

  it.each(signInReasons)("gives sign-in reason %s its own next step", (reason, nextStep) => {
    const error = new SourceControlSignInError({
      provider,
      host: "github.com",
      reason,
      detail: rawDetail,
    });

    expect(describeVersionControlError(error)).toEqual({
      title: "无法登录托管平台",
      nextStep,
      detail: rawDetail,
    });
  });

  describe("a Git command that fails without a reason", () => {
    const actions: ReadonlyArray<readonly [string, string, string]> = [
      [
        "GitVcsDriver.pushCurrentBranch",
        "无法推送",
        "请确认远端地址正确、你有推送权限，然后重试。",
      ],
      [
        "GitVcsDriver.pullCurrentBranch",
        "无法拉取",
        "请先提交或暂存本地改动，并解决冲突，然后重试。",
      ],
      ["GitVcsDriver.switchRef", "无法切换分支", "请先提交或暂存本地改动，然后重试。"],
      [
        "GitVcsDriver.commit",
        "无法提交",
        "请确认已选择要提交的改动，且没有未解决的冲突，然后重试。",
      ],
      ["GitVcsDriver.createWorktree", "无法创建工作树", GENERIC],
    ];

    it.each(actions)("%s suggests something the user can do", (operation, title, nextStep) => {
      const result = describeVersionControlError(gitError(operation));

      expect(result.title).toBe(title);
      expect(result.nextStep).toBe(nextStep);
      expect(result.nextStep).not.toContain("下方");
    });
  });

  describe("naming the action", () => {
    const operations: ReadonlyArray<readonly [string, string | undefined]> = [
      ["GitVcsDriver.getReviewDiffPreview.commitStat", "加载差异"],
      ["GitVcsDriver.getReviewDiffPreview.commitPatch", "加载差异"],
      ["GitVcsDriver.getReviewDiffPreview.stat", "加载差异"],
      ["GitVcsDriver.getReviewDiffFileContents.workingTree.read", "加载文件差异"],
      ["GitVcsDriver.getReviewBranchCommits.head", "加载分支提交"],
      ["GitVcsDriver.commit.addAll", "提交"],
      ["GitVcsDriver.statusDetails.numstat", "读取 Git 状态"],
      ["GitManager.pushCurrentBranch", "推送"],
      ["GitManager.preparePullRequestThread.localBranches", "检出 PR"],
      ["SourceControlRepositoryService.publishRepository.headCheck", "发布仓库"],
      ["review.diffFilePatch", "加载文件差异"],
      ["status", "读取 Git 状态"],
      ["GitVcsDriver.somethingNew", undefined],
      ["runStackedAction", undefined],
      ["pushWithPullAndCommit", undefined],
    ];

    it.each(operations)("%s is %s", (operation, action) => {
      expect(operationAction(operation)).toBe(action);
    });

    it.each([
      ["GitVcsDriver.getReviewDiffPreview.commitStat", "getReviewDiffPreview"],
      ["GitVcsDriver.pushCurrentBranch", "pushCurrentBranch"],
      ["generateCommitMessage", "generateCommitMessage"],
      ["review.diffFilePatch", "review"],
    ])("reads the method of %s as %s", (operation, method) => {
      expect(operationMethodName(operation)).toBe(method);
    });

    it("titles a failed commit diff as a diff, not a commit", () => {
      const error = gitError("GitVcsDriver.getReviewDiffPreview.commitStat");

      expect(describeVersionControlError(error, "加载差异").title).toBe("无法加载差异");
    });

    it("keeps the caller's action for an unknown operation", () => {
      expect(describeVersionControlError(gitError("GitVcsDriver.somethingNew"), "拉取").title).toBe(
        "无法拉取",
      );
    });

    it("keeps the caller's label for a combined action whatever step failed", () => {
      const error = gitError("GitVcsDriver.getReviewDiffPreview.commitStat");

      expect(describeVersionControlError(error, "创建 PR", { composite: true }).title).toBe(
        "无法创建 PR",
      );
      expect(describeVersionControlError(error, "创建 PR", { composite: false }).title).toBe(
        "无法加载差异",
      );
    });
  });
});

describe("presentVersionControlError", () => {
  it("joins the next step and the detail into one sentence without pointing below", () => {
    const presentation = presentVersionControlError(
      gitError("GitVcsDriver.pushCurrentBranch", "push_rejected_non_fast_forward"),
      "推送",
    );

    expect(presentation).toEqual({
      title: "无法推送",
      nextStep: "请先拉取远端改动，再重新推送。",
      detail: rawDetail,
      description: `请先拉取远端改动，再重新推送。详情：${rawDetail}`,
    });
  });

  it("falls back to the error's own message when the error carries no detail", () => {
    const error = new VcsProcessMissingExitCodeError(processContext("GitVcsDriver.commit"));

    expect(presentVersionControlError(error, "提交").detail).toBe(error.message);
  });

  it("keeps unrelated failures on the caller's existing fallback", () => {
    expect(presentVersionControlError(new Error("unrelated"), "打开文件")).toEqual({
      title: "无法打开文件",
      detail: "unrelated",
      description: "unrelated",
    });
  });

  it("keeps the original text when the failure is not a typed version control error", () => {
    expect(presentVersionControlError("Defect: index out of range", "加载差异")).toEqual({
      title: "无法加载差异",
      detail: "Defect: index out of range",
      description: "Defect: index out of range",
    });
    expect(presentVersionControlError(null, "加载差异")).toEqual({
      title: "无法加载差异",
      detail: "发生错误。",
      description: "发生错误。",
    });
  });
});

describe("joinNextStepAndDetail", () => {
  it("returns only the detail when there is no next step", () => {
    expect(joinNextStepAndDetail(undefined, "raw")).toBe("raw");
  });

  it("puts the next step before the detail", () => {
    expect(joinNextStepAndDetail("请重试。", "raw")).toBe("请重试。详情：raw");
  });
});
