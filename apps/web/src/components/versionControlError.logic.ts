import {
  GitManagerServiceError,
  SourceControlRepositoryError,
  SourceControlSignInError,
  VcsError,
  type GitCommandAction,
  type GitCommandFailureReason,
  type SourceControlSignInFailure,
  type TextGenerationFailureReason,
  type VcsProcessExitFailureKind,
  type VcsProcessSpawnFailureReason,
  type VcsSnapshotFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { describeRequestFailure } from "@t3tools/client-runtime/errors";

const VersionControlError = Schema.Union([
  GitManagerServiceError,
  VcsError,
  SourceControlSignInError,
  SourceControlRepositoryError,
]);
export type VersionControlError = typeof VersionControlError.Type;

/** Title, next step, raw detail for disclosure/copy, and whether guidance replaces inline detail. */
export interface VersionControlErrorPresentation {
  readonly title: string;
  readonly nextStep?: string;
  readonly detail: string;
  readonly collapseDetail: boolean;
}
/** The same presentation, plus one string for places that cannot render a disclosure. */
export interface VersionControlErrorToastPresentation extends VersionControlErrorPresentation {
  readonly description: string;
}

export interface VersionControlErrorOptions {
  /** The caller runs several steps as one action, so its own label names the failure. */
  readonly composite?: boolean;
}

const isVersionControlError = Schema.is(VersionControlError);

const GENERIC_NEXT_STEP = "请根据详情中的原因处理，然后重试。";

/** What to try when Git fails without a specific reason, by the action that failed. */
const ACTION_NEXT_STEPS: Readonly<Record<string, string>> = {
  推送: "请确认远端地址正确、你有推送权限，然后重试。",
  拉取: "请先提交或暂存本地改动，并解决冲突，然后重试。",
  切换分支: "请先提交或暂存本地改动，然后重试。",
  提交: "请确认已选择要提交的改动，且没有未解决的冲突，然后重试。",
};

const GIT_REASON_NEXT_STEPS: Record<GitCommandFailureReason, string> = {
  authentication_failed: "请检查托管平台的登录状态和访问权限，然后重试。",
  author_identity_unknown: "请在 Git 里设置用户名和邮箱，然后重试。",
  branch_already_exists: "请换一个分支名称，或选择已有分支。",
  branch_checked_out_in_worktree: "请选择其他分支，或先移除已检出该分支的工作树。",
  config_locked: "请等正在修改 Git 配置的进程结束，然后重试。",
  executable_not_found: "请安装 Git，并确认它在这台电脑上可以运行，然后重试。",
  host_key_unverified: "请先在终端连接此托管平台并确认主机密钥，然后重试。",
  index_locked:
    "请结束正在使用这个仓库的 Git 操作；确认没有操作后，可以删除仓库里的索引锁文件，然后重试。",
  merge_conflict: "请打开差异，解决标出的冲突并完成提交，然后重试。",
  network_unreachable: "请检查网络连接，确认能访问远端仓库所在的主机，然后重试。",
  not_a_repository: "请选择 Git 仓库目录，或先初始化 Git。",
  not_fast_forward: "请先拉取远端改动，再重新推送。",
  path_already_exists: "请选择其他目录，或移走同名文件后重试。",
  push_rejected_by_remote: "请根据详情中的拒绝原因处理，然后重试。",
  push_rejected_non_fast_forward: "请先拉取远端改动，再重新推送。",
  ref_name_conflict: "请换一个不与现有分支或标签冲突的名称。",
  ref_not_found: "请刷新分支列表，确认分支或标签仍然存在。",
  remote_unreachable: "请确认远端仓库地址正确、仓库存在且你有访问权限，然后重试。",
  tag_would_be_clobbered: "请先同步远端标签，或保留本地同名标签后重试。",
  working_tree_dirty: "请先提交、暂存或放弃未提交的改动，然后重试。",
};

const COMMAND_ACTIONS: Record<GitCommandAction, string> = {
  push: "推送",
  pull: "拉取",
  fetch: "获取远端改动",
  commit: "提交",
  switch_branch: "切换分支",
  create_branch: "创建并切换分支",
  delete_branch: "删除分支",
  rename_branch: "重命名分支",
  create_worktree: "创建工作树",
  remove_worktree: "删除工作树",
  checkout_pr: "检出 PR",
  clone: "克隆仓库",
  publish: "发布仓库",
  init: "初始化 Git",
  read_status: "读取 Git 状态",
  read_diff: "加载差异",
  list_branches: "加载分支",
  cleanup: "清理 Git 状态",
  checkpoint: "保存文件快照",
  other: "完成版本控制操作",
};

const SPAWN_REASON_NEXT_STEPS: Record<VcsProcessSpawnFailureReason, string> = {
  executable_not_found: GIT_REASON_NEXT_STEPS.executable_not_found,
  permission_denied: "请允许这台电脑运行此版本控制工具，然后重试。",
};

const TEXT_REASON_NEXT_STEPS: Record<TextGenerationFailureReason, string> = {
  not_installed: "请安装并设置用于生成文字的智能体，然后重试。",
  unauthenticated: "请先登录用于生成文字的智能体，然后重试。",
  rate_limited: "生成文字的用量暂时达到上限，请稍后再试。",
  network: "请检查网络连接，然后重试。",
  timeout: "生成文字超时，请重试。",
  unavailable: "用于生成文字的智能体暂时不可用，请稍后再试。",
};

const VCS_FAILURE_NEXT_STEPS: Record<
  Exclude<VcsProcessExitFailureKind, "command-failed">,
  string
> = {
  authentication: "请检查托管平台的登录状态和访问权限，然后重试。",
  "not-found": "请确认仓库、分支或 PR 仍然存在，然后重试。",
  "rate-limited": "托管平台正在限制请求，请稍后再试。",
};

const SIGN_IN_NEXT_STEPS: Record<SourceControlSignInFailure, string> = {
  unsupported: "当前托管平台不支持此登录方式，请改用访问令牌或托管平台的命令行工具登录。",
  "not-started": "请重新开始登录。",
  cancelled: "请重新开始登录，并完成授权。",
  denied: "请在托管平台允许访问后重试。",
  expired: "请重新开始登录，并在验证码过期前完成授权。",
  failed: "请检查网络连接和登录状态，然后重试。",
};

/**
 * What each server operation is called to the reader. Keys are the whole operation or, for
 * `Service.method[.step]` operations, the method name; an unknown name falls back to the caller.
 */
const OPERATION_ACTIONS: Readonly<Record<string, string>> = {
  generateCommitMessage: "生成提交说明",
  generatePrContent: "生成 PR 内容",
  generateBranchName: "生成分支名称",
  generateThreadTitle: "生成会话标题",
  cloneRepository: "克隆仓库",
  discardClone: "克隆仓库",
  publishRepository: "发布仓库",
  createRepository: "发布仓库",
  lookupRepository: "查询仓库",
  preparePullRequestThread: "检出 PR",
  checkoutChangeRequest: "检出 PR",
  createChangeRequest: "创建 PR",
  getChangeRequest: "加载 PR",
  listChangeRequests: "加载 PR 列表",
  getDefaultBranch: "读取默认分支",
  getRepositoryCloneUrls: "读取仓库地址",
  "review.diffFilePatch": "加载文件差异",
  createWorktree: "创建工作树",
  removeWorktree: "删除工作树",
  pushCurrentBranch: "推送",
  pullCurrentBranch: "拉取",
  commit: "提交",
  switchRef: "切换分支",
  createRef: "创建并切换分支",
  listRefs: "加载分支",
  status: "读取 Git 状态",
  statusDetails: "读取 Git 状态",
  getReviewDiffPreview: "加载差异",
  getReviewDiffFileContents: "加载文件差异",
  getDiffFileContents: "加载文件差异",
  getReviewBranchCommits: "加载分支提交",
  getBranchCommits: "加载分支提交",
};

/** `GitVcsDriver.getReviewDiffPreview.commitStat` is the method `getReviewDiffPreview`. */
export function operationMethodName(operation: string): string {
  const parts = operation.split(".");
  const first = parts[0] ?? operation;
  return parts.length > 1 && /^[A-Z]/u.test(first) ? (parts[1] ?? first) : first;
}

export function operationAction(operation: string): string | undefined {
  return OPERATION_ACTIONS[operation] ?? OPERATION_ACTIONS[operationMethodName(operation)];
}

function detailOf(error: VersionControlError): string {
  if ("detail" in error && error.detail.length > 0) return error.detail;
  return error.message;
}

function assertNever(error: never): never {
  throw new Error(`未处理的版本控制错误：${JSON.stringify(error)}`);
}

function actionNextStep(action: string): string {
  return ACTION_NEXT_STEPS[action] ?? GENERIC_NEXT_STEP;
}

function providerNextStep(action: string): string {
  switch (action) {
    case "克隆仓库":
    case "查询仓库":
      return "请确认仓库地址正确，且账号有访问权限，然后重试。";
    case "发布仓库":
      return "请确认仓库名未被占用，且账号可以创建仓库，然后重试。";
    default:
      return "请检查托管平台的登录状态、访问权限和网络连接，然后重试。";
  }
}

function hasChineseErrorExplanation(error: {
  readonly _tag: string;
  readonly reason?: string | undefined;
}): boolean {
  return (
    (error._tag !== "GitCommandError" && error._tag !== "GitManagerError") ||
    error.reason !== undefined
  );
}

/** Classified guidance replaces raw output; unclassified Git output remains visible. */
export function versionControlErrorDescription(
  error: Pick<VersionControlErrorPresentation, "nextStep" | "detail" | "collapseDetail">,
): string {
  if (error.collapseDetail) return error.nextStep ?? error.detail;
  return error.nextStep === undefined ? error.detail : `${error.nextStep}详情：${error.detail}`;
}

export function versionControlErrorDetailMode(
  error: Pick<VersionControlErrorPresentation, "detail" | "collapseDetail">,
): "disclosure" | "inline" | "hidden" {
  if (error.detail.length === 0) return "hidden";
  return error.collapseDetail ? "disclosure" : "inline";
}

export function describeVersionControlError(
  error: VersionControlError,
  fallbackAction = "完成版本控制操作",
  options: VersionControlErrorOptions = {},
): VersionControlErrorPresentation {
  const typedAction = "action" in error ? error.action : undefined;
  const operationName = "operation" in error ? operationAction(error.operation) : undefined;
  const action = options.composite
    ? fallbackAction
    : typedAction === undefined
      ? (operationName ??
        (error._tag === "GitPullRequestMaterializationError" ? "检出 PR" : fallbackAction))
      : COMMAND_ACTIONS[typedAction];
  const base = {
    title: `无法${action}`,
    detail: detailOf(error),
    collapseDetail: hasChineseErrorExplanation(error),
  } as const;

  switch (error._tag) {
    case "GitCommandError":
      return {
        ...base,
        nextStep:
          (error.reason === undefined ? undefined : GIT_REASON_NEXT_STEPS[error.reason]) ??
          actionNextStep(action),
      };
    case "TextGenerationError":
      return {
        ...base,
        nextStep:
          error.reason === undefined
            ? "请检查智能体的登录状态和可用性，然后重试。"
            : TEXT_REASON_NEXT_STEPS[error.reason],
      };
    case "GitManagerError":
      return {
        ...base,
        nextStep:
          error.reason === "working_tree_dirty"
            ? GIT_REASON_NEXT_STEPS.working_tree_dirty
            : actionNextStep(action),
      };
    case "GitPullRequestMaterializationError":
      return { ...base, nextStep: "请确认分支和工作树目录可用，然后重试。" };
    case "SourceControlProviderError":
      return { ...base, nextStep: providerNextStep(action) };
    case "SourceControlRepositoryError":
      return {
        ...base,
        nextStep:
          error.reason === "path_already_exists"
            ? GIT_REASON_NEXT_STEPS.path_already_exists
            : providerNextStep(action),
      };
    case "VcsProcessSpawnError":
      return {
        ...base,
        nextStep:
          error.reason === undefined
            ? "请确认版本控制工具已安装且可以运行，然后重试。"
            : SPAWN_REASON_NEXT_STEPS[error.reason],
      };
    case "VcsProcessExitError":
      return {
        ...base,
        nextStep:
          error.reason === "index_locked"
            ? GIT_REASON_NEXT_STEPS.index_locked
            : error.failureKind === undefined || error.failureKind === "command-failed"
              ? actionNextStep(action)
              : VCS_FAILURE_NEXT_STEPS[error.failureKind],
      };
    case "VcsProcessTimeoutError":
      return {
        ...base,
        nextStep: `超过 ${Math.max(1, Math.ceil(error.timeoutMs / 1000))} 秒未完成，请检查网络连接和仓库状态，然后重试。`,
      };
    case "VcsProcessStdinWriteError":
    case "VcsProcessOutputReadError":
    case "VcsProcessMissingExitCodeError":
      return {
        ...base,
        nextStep: "请重试；如果仍然失败，请检查版本控制工具是否正常运行。",
      };
    case "VcsProcessOutputLimitError":
      return { ...base, nextStep: "输出内容过大，请在终端里运行此命令。" };
    case "VcsCheckpointStorageError":
      return {
        ...base,
        nextStep: "无法写入检查点对象，请检查仓库的 .git 目录可用且可写，然后重试。",
      };
    case "VcsRepositoryDetectionError":
      return { ...base, nextStep: "请确认目录存在，并且版本控制工具可以读取。" };
    case "VcsUnsupportedOperationError":
      return { ...base, nextStep: "当前版本控制工具不支持此操作。" };
    case "SourceControlSignInError":
      return {
        title: "无法登录托管平台",
        nextStep: SIGN_IN_NEXT_STEPS[error.reason],
        detail: error.detail,
        collapseDetail: true,
      };
    default:
      return assertNever(error);
  }
}

export function presentVersionControlError(
  error: unknown,
  fallbackAction: string,
  options: VersionControlErrorOptions = {},
): VersionControlErrorToastPresentation {
  if (isVersionControlError(error)) {
    const presentation = describeVersionControlError(error, fallbackAction, options);
    return {
      ...presentation,
      description: versionControlErrorDescription(presentation),
    };
  }
  const failure = describeRequestFailure(error);
  const detail =
    typeof failure === "string"
      ? failure
      : failure instanceof Error
        ? failure.message
        : "发生错误。";
  return { title: `无法${fallbackAction}`, detail, collapseDetail: false, description: detail };
}

/** Snapshot reasons are free strings from the server, so only own keys count as known. */
function knownStep(table: Readonly<Record<string, string>>, reason: string | undefined) {
  return reason !== undefined && Object.hasOwn(table, reason) ? table[reason] : undefined;
}

function snapshotNextStep(failure: VcsSnapshotFailure, action: string): string {
  switch (failure._tag) {
    case "GitCommandError":
      return knownStep(GIT_REASON_NEXT_STEPS, failure.reason) ?? actionNextStep(action);
    case "GitManagerError":
      return failure.reason === "working_tree_dirty"
        ? GIT_REASON_NEXT_STEPS.working_tree_dirty
        : actionNextStep(action);
    case "TextGenerationError":
      return (
        knownStep(TEXT_REASON_NEXT_STEPS, failure.reason) ??
        "请检查智能体的登录状态和可用性，然后重试。"
      );
    case "VcsProcessSpawnError":
      return (
        knownStep(SPAWN_REASON_NEXT_STEPS, failure.reason) ??
        "请确认版本控制工具已安装且可以运行，然后重试。"
      );
    case "VcsProcessExitError":
      return failure.reason === "index_locked"
        ? GIT_REASON_NEXT_STEPS.index_locked
        : actionNextStep(action);
    case "SourceControlRepositoryError":
      return failure.reason === "path_already_exists"
        ? GIT_REASON_NEXT_STEPS.path_already_exists
        : providerNextStep(action);
    default:
      return knownStep(GIT_REASON_NEXT_STEPS, failure.reason) ?? actionNextStep(action);
  }
}

export function presentVcsSnapshotFailure(
  failure: VcsSnapshotFailure,
  fallbackAction: string,
): VersionControlErrorToastPresentation {
  const action = failure.action === undefined ? fallbackAction : COMMAND_ACTIONS[failure.action];
  const presentation = {
    title: `无法${action}`,
    nextStep: snapshotNextStep(failure, action),
    detail: failure.detail,
    collapseDetail: hasChineseErrorExplanation(failure),
  };
  return {
    ...presentation,
    description: versionControlErrorDescription(presentation),
  };
}

export function projectCloneFailureDescription(
  failure: VcsSnapshotFailure | undefined,
  legacyError: string | null,
): string {
  return failure === undefined
    ? (legacyError ?? "克隆失败。")
    : presentVcsSnapshotFailure(failure, "克隆仓库").description;
}

export function worktreeSetupFailureDescription(
  failure: VcsSnapshotFailure | undefined,
  legacyError: string | null,
): string | null {
  return failure === undefined
    ? legacyError
    : presentVcsSnapshotFailure(failure, "准备工作树").description;
}

export function newProjectCommitWarningDescription(
  failure: VcsSnapshotFailure | undefined,
  legacyError: string | undefined,
  workspaceRoot: string,
): string {
  const detail =
    failure === undefined
      ? (legacyError ?? "")
      : presentVcsSnapshotFailure(failure, "提交").description;
  return `${detail} 项目位于 ${workspaceRoot}。`;
}
