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
  type GitCommandAction,
  type GitCommandFailureReason,
  type SourceControlProviderKind,
  type SourceControlSignInFailure,
  type TextGenerationFailureReason,
  type VcsProcessExitFailureKind,
  type VcsSnapshotFailure,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeVersionControlError,
  versionControlErrorDescription,
  newProjectCommitWarningDescription,
  operationAction,
  operationMethodName,
  presentVcsSnapshotFailure,
  presentVersionControlError,
  projectCloneFailureDescription,
  worktreeSetupFailureDescription,
  type VersionControlError,
  versionControlErrorDetailMode,
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
  readonly collapseDetail?: boolean;
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
    collapseDetail: false,
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
  it.each(cases)(
    "presents $name",
    ({ error, fallbackAction, title, nextStep, detail, collapseDetail = true }) => {
      expect(describeVersionControlError(error, fallbackAction)).toEqual({
        title,
        nextStep,
        detail,
        collapseDetail,
      });
    },
  );

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
    ["network_unreachable", "请检查网络连接，确认能访问远端仓库所在的主机，然后重试。"],
    ["remote_unreachable", "请确认远端仓库地址正确、仓库存在且你有访问权限，然后重试。"],
    ["tag_would_be_clobbered", "请先同步远端标签，或保留本地同名标签后重试。"],
  ];

  const newGitReasons: ReadonlyArray<readonly [GitCommandFailureReason, string]> = [
    ["author_identity_unknown", "请在 Git 里设置用户名和邮箱，然后重试。"],
    ["executable_not_found", "请安装 Git，并确认它在这台电脑上可以运行，然后重试。"],
    [
      "index_locked",
      "请结束正在使用这个仓库的 Git 操作；确认没有操作后，可以删除仓库里的索引锁文件，然后重试。",
    ],
    ["merge_conflict", "请打开差异，解决标出的冲突并完成提交，然后重试。"],
    ["not_fast_forward", "请先拉取远端改动，再重新推送。"],
    ["working_tree_dirty", "请先提交、暂存或放弃未提交的改动，然后重试。"],
  ];

  it.each(newGitReasons)("gives the new Git reason %s its own next step", (reason, nextStep) => {
    expect(describeVersionControlError(gitError("GitVcsDriver.commit", reason))).toEqual({
      title: "无法提交",
      nextStep,
      detail: rawDetail,
      collapseDetail: true,
    });
  });

  const commandActions: ReadonlyArray<readonly [GitCommandAction, string]> = [
    ["push", "推送"],
    ["pull", "拉取"],
    ["fetch", "获取远端改动"],
    ["commit", "提交"],
    ["switch_branch", "切换分支"],
    ["create_branch", "创建并切换分支"],
    ["delete_branch", "删除分支"],
    ["rename_branch", "重命名分支"],
    ["create_worktree", "创建工作树"],
    ["remove_worktree", "删除工作树"],
    ["checkout_pr", "检出 PR"],
    ["clone", "克隆仓库"],
    ["publish", "发布仓库"],
    ["init", "初始化 Git"],
    ["read_status", "读取 Git 状态"],
    ["read_diff", "加载差异"],
    ["list_branches", "加载分支"],
    ["cleanup", "清理 Git 状态"],
    ["checkpoint", "保存文件快照"],
    ["other", "完成版本控制操作"],
  ];

  it.each(commandActions)("uses the typed action %s instead of the operation", (action, label) => {
    const error = new GitCommandError({
      ...processContext("GitVcsDriver.getReviewDiffPreview.commitStat"),
      action,
      detail: rawDetail,
    });

    expect(describeVersionControlError(error, "加载差异").title).toBe(`无法${label}`);
  });

  it("keeps deriving the action from the operation when an older server sends none", () => {
    expect(describeVersionControlError(gitError("GitVcsDriver.pushCurrentBranch")).title).toBe(
      "无法推送",
    );
  });

  it("names a missing Git executable when the process cannot start", () => {
    const error = new VcsProcessSpawnError({
      ...processContext("GitVcsDriver.commit"),
      reason: "executable_not_found",
      cause: new Error("spawn git ENOENT"),
    });

    expect(describeVersionControlError(error)).toEqual({
      title: "无法提交",
      nextStep: "请安装 Git，并确认它在这台电脑上可以运行，然后重试。",
      detail: error.message,
      collapseDetail: true,
    });
  });

  it("explains a denied executable separately from a missing one", () => {
    const error = new VcsProcessSpawnError({
      ...processContext("GitVcsDriver.commit"),
      reason: "permission_denied",
      cause: new Error("spawn git EACCES"),
    });

    expect(describeVersionControlError(error).nextStep).toBe(
      "请允许这台电脑运行此版本控制工具，然后重试。",
    );
  });

  it("keeps the generic startup guidance when an older server sends no spawn reason", () => {
    const error = new VcsProcessSpawnError({
      ...processContext("GitVcsDriver.commit"),
      cause: new Error("spawn git ENOENT"),
    });

    expect(describeVersionControlError(error).nextStep).toBe(
      "请确认版本控制工具已安装且可以运行，然后重试。",
    );
  });

  it("tells the user how to clear an index lock reported by a VCS process", () => {
    const error = new VcsProcessExitError({
      ...processContext("GitVcsDriver.commit"),
      exitCode: 1,
      detail: rawDetail,
      failureKind: "command-failed",
      reason: "index_locked",
    });

    expect(describeVersionControlError(error).nextStep).toBe(
      "请结束正在使用这个仓库的 Git 操作；确认没有操作后，可以删除仓库里的索引锁文件，然后重试。",
    );
  });

  it("asks the user to commit or set aside changes before a dirty-tree operation", () => {
    const error = new GitManagerError({
      operation: "runStackedAction",
      cwd: "/repo",
      reason: "working_tree_dirty",
      detail: rawDetail,
    });

    expect(describeVersionControlError(error, "提交")).toEqual({
      title: "无法提交",
      nextStep: "请先提交、暂存或放弃未提交的改动，然后重试。",
      detail: rawDetail,
      collapseDetail: true,
    });
  });

  it("points to another directory when the repository path already exists", () => {
    const error = new SourceControlRepositoryError({
      provider,
      operation: "cloneRepository",
      reason: "path_already_exists",
      detail: rawDetail,
    });

    expect(describeVersionControlError(error).nextStep).toBe(
      "请选择其他目录，或移走同名文件后重试。",
    );
  });

  const textReasons: ReadonlyArray<readonly [TextGenerationFailureReason, string]> = [
    ["not_installed", "请安装并设置用于生成文字的智能体，然后重试。"],
    ["unauthenticated", "请先登录用于生成文字的智能体，然后重试。"],
    ["rate_limited", "生成文字的用量暂时达到上限，请稍后再试。"],
    ["network", "请检查网络连接，然后重试。"],
    ["timeout", "生成文字超时，请重试。"],
    ["unavailable", "用于生成文字的智能体暂时不可用，请稍后再试。"],
  ];

  it.each(textReasons)("gives text generation reason %s its own next step", (reason, nextStep) => {
    const error = new TextGenerationError({
      operation: "generateCommitMessage",
      reason,
      detail: rawDetail,
    });

    expect(describeVersionControlError(error)).toEqual({
      title: "无法生成提交说明",
      nextStep,
      detail: rawDetail,
      collapseDetail: true,
    });
  });

  it("keeps the generic text guidance when an older server sends no reason", () => {
    const error = new TextGenerationError({
      operation: "generateCommitMessage",
      detail: rawDetail,
    });

    expect(describeVersionControlError(error).nextStep).toBe(
      "请检查智能体的登录状态和可用性，然后重试。",
    );
  });

  const snapshotFailure = (overrides: Partial<VcsSnapshotFailure> = {}): VcsSnapshotFailure => ({
    _tag: "GitCommandError",
    operation: "SourceControlRepositoryService.cloneRepository",
    action: "clone",
    reason: "authentication_failed",
    detail: rawDetail,
    ...overrides,
  });

  it("presents a structured snapshot failure through its action and reason", () => {
    expect(presentVcsSnapshotFailure(snapshotFailure(), "克隆仓库")).toEqual({
      title: "无法克隆仓库",
      nextStep: AUTH,
      detail: rawDetail,
      collapseDetail: true,
      description: "请检查托管平台的登录状态和访问权限，然后重试。",
    });
  });

  it.each(["not_a_known_reason", "toString", "constructor"])(
    "falls back to the action guidance for the unknown snapshot reason %s",
    (reason) => {
      for (const _tag of ["GitCommandError", "TextGenerationError", "VcsProcessSpawnError"]) {
        const result = presentVcsSnapshotFailure(snapshotFailure({ _tag, reason }), "克隆仓库");
        expect(typeof result.nextStep).toBe("string");
        expect(result.nextStep).not.toBe("");
        expect(result.detail).toBe(rawDetail);
        expect(result.description).not.toContain(rawDetail);
      }
    },
  );

  it("keeps the caller's action when an older snapshot has no typed action", () => {
    expect(
      presentVcsSnapshotFailure(snapshotFailure({ action: undefined }), "克隆仓库").title,
    ).toBe("无法克隆仓库");
  });

  it("uses the structured clone failure instead of the legacy error string", () => {
    expect(projectCloneFailureDescription(snapshotFailure(), "旧的英文错误")).toBe(
      "请检查托管平台的登录状态和访问权限，然后重试。",
    );
  });

  it("keeps the legacy clone error when an older snapshot has no failure", () => {
    expect(projectCloneFailureDescription(undefined, "旧的英文错误")).toBe("旧的英文错误");
  });

  it("uses a generic clone failure when neither structured nor legacy text exists", () => {
    expect(projectCloneFailureDescription(undefined, null)).toBe("克隆失败。");
  });

  it("uses the structured worktree failure instead of the legacy error string", () => {
    expect(
      worktreeSetupFailureDescription(
        snapshotFailure({ action: "create_worktree", reason: "path_already_exists" }),
        "旧的英文错误",
      ),
    ).toBe("请选择其他目录，或移走同名文件后重试。");
  });

  it("shows only the Chinese next step for a reasoned failure and keeps the detail for the disclosure", () => {
    const detail =
      "Git could not reach the remote. Check the server's network connection and remote host, then retry.";
    const presentation = presentVcsSnapshotFailure(
      snapshotFailure({ action: "create_worktree", reason: "network_unreachable", detail }),
      "准备工作树",
    );

    expect(presentation.description).toBe(
      "请检查网络连接，确认能访问远端仓库所在的主机，然后重试。",
    );
    expect(presentation.description).not.toContain(detail);
    expect(presentation.collapseDetail).toBe(true);
    expect(presentation.detail).toBe(detail);
  });

  it("keeps the raw detail visible for a worktree failure without a reason code", () => {
    const { reason: _reason, ...unreasoned } = snapshotFailure({ action: "create_worktree" });
    const presentation = presentVcsSnapshotFailure(unreasoned, "准备工作树");

    expect(presentation.collapseDetail).toBe(false);
    expect(presentation.description).toContain(rawDetail);
  });

  it("keeps the legacy worktree error when an older snapshot has no failure", () => {
    expect(worktreeSetupFailureDescription(undefined, "旧的英文错误")).toBe("旧的英文错误");
  });

  it("puts the structured commit failure before the project location", () => {
    expect(
      newProjectCommitWarningDescription(
        snapshotFailure({ action: "commit", reason: "author_identity_unknown" }),
        "Git has no name or email.",
        "/workspace/new",
      ),
    ).toBe("请在 Git 里设置用户名和邮箱，然后重试。 项目位于 /workspace/new。");
  });

  it("keeps the legacy commit warning when an older result has no failure", () => {
    expect(
      newProjectCommitWarningDescription(undefined, "Git has no name or email.", "/workspace/new"),
    ).toBe("Git has no name or email. 项目位于 /workspace/new。");
  });

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
      collapseDetail: true,
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
      collapseDetail: true,
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
  it("shows Chinese guidance by default and keeps raw detail separate", () => {
    const presentation = presentVersionControlError(
      gitError("GitVcsDriver.pushCurrentBranch", "push_rejected_non_fast_forward"),
      "推送",
    );

    expect(presentation).toEqual({
      title: "无法推送",
      nextStep: "请先拉取远端改动，再重新推送。",
      detail: rawDetail,
      collapseDetail: true,
      description: "请先拉取远端改动，再重新推送。",
    });
  });

  it("falls back to the error's own message when the error carries no detail", () => {
    const error = new VcsProcessMissingExitCodeError(processContext("GitVcsDriver.commit"));

    expect(presentVersionControlError(error, "提交").detail).toBe(error.message);
  });

  it("keeps internal call sites out of the default description", () => {
    const error = new VcsProcessSpawnError({
      ...processContext("GitVcsDriver.initRepository"),
      cause: new Error("spawn git ENOENT"),
    });

    const presentation = presentVersionControlError(error, "初始化 Git");

    expect(presentation.description).toBe("请确认版本控制工具已安装且可以运行，然后重试。");
    expect(presentation.description).not.toContain("GitVcsDriver.initRepository");
  });

  it("preserves the complete raw detail for copying", () => {
    const cliOutput = "Codex CLI output\n".repeat(40) + "fatal: authentication failed";
    const presentation = presentVersionControlError(
      new TextGenerationError({ operation: "generateCommitMessage", detail: cliOutput }),
      "生成提交说明",
    );

    expect(presentation.detail).toBe(cliOutput);
    expect(presentation.description).not.toContain(cliOutput);
  });

  it("keeps unrelated failures on the caller's existing fallback", () => {
    expect(presentVersionControlError(new Error("unrelated"), "打开文件")).toEqual({
      title: "无法打开文件",
      detail: "unrelated",
      collapseDetail: false,
      description: "unrelated",
    });
  });

  it("keeps the original text when the failure is not a typed version control error", () => {
    expect(presentVersionControlError("Defect: index out of range", "加载差异")).toEqual({
      title: "无法加载差异",
      detail: "Defect: index out of range",
      collapseDetail: false,
      description: "Defect: index out of range",
    });
    expect(presentVersionControlError(null, "加载差异")).toEqual({
      title: "无法加载差异",
      detail: "发生错误。",
      collapseDetail: false,
      description: "发生错误。",
    });
  });
  it("keeps raw output visible when an older server sends no reason code", () => {
    const presentation = presentVersionControlError(gitError("GitVcsDriver.commit"), "提交");

    expect(presentation.collapseDetail).toBe(false);
    expect(presentation.description).toBe(
      `请确认已选择要提交的改动，且没有未解决的冲突，然后重试。详情：${rawDetail}`,
    );
  });
});

describe("versionControlErrorDescription", () => {
  it("returns only the detail when there is no next step", () => {
    expect(versionControlErrorDescription({ detail: "raw", collapseDetail: false })).toBe("raw");
  });

  it("omits technical detail when classified guidance exists", () => {
    expect(
      versionControlErrorDescription({ nextStep: "请重试。", detail: "raw", collapseDetail: true }),
    ).toBe("请重试。");
  });
  it("keeps raw output visible when the error has no classification", () => {
    expect(
      versionControlErrorDescription({
        nextStep: "请重试。",
        detail: "raw",
        collapseDetail: false,
      }),
    ).toBe("请重试。详情：raw");
  });
});

describe("versionControlErrorDetailMode", () => {
  it("collapses classified detail behind a disclosure", () => {
    expect(versionControlErrorDetailMode({ detail: rawDetail, collapseDetail: true })).toBe(
      "disclosure",
    );
  });

  it("keeps an unclassified error's raw text visible", () => {
    const presentation = presentVersionControlError("fatal: repository not found", "克隆仓库");

    expect(versionControlErrorDetailMode(presentation)).toBe("inline");
    expect(presentation.description).toBe("fatal: repository not found");
  });

  it("renders nothing for an empty detail", () => {
    expect(versionControlErrorDetailMode({ detail: "", collapseDetail: true })).toBe("hidden");
  });
});
