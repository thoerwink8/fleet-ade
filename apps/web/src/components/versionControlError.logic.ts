import {
  GitManagerServiceError,
  SourceControlRepositoryError,
  SourceControlSignInError,
  VcsError,
  type GitCommandFailureReason,
  type SourceControlSignInFailure,
  type VcsProcessExitFailureKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const VersionControlError = Schema.Union([
  GitManagerServiceError,
  VcsError,
  SourceControlSignInError,
  SourceControlRepositoryError,
]);
export type VersionControlError = typeof VersionControlError.Type;

/** Title, what to do next, and the raw detail, kept apart so each place can lay them out. */
export interface VersionControlErrorPresentation {
  readonly title: string;
  readonly nextStep?: string;
  readonly detail: string;
}

/** The same three parts, plus one sentence for places that can only show a single string. */
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

const GIT_REASON_NEXT_STEPS: Partial<Record<GitCommandFailureReason, string>> = {
  authentication_failed: "请检查托管平台的登录状态和访问权限，然后重试。",
  branch_already_exists: "请换一个分支名称，或选择已有分支。",
  branch_checked_out_in_worktree: "请选择其他分支，或先移除已检出该分支的工作树。",
  config_locked: "请等正在修改 Git 配置的进程结束，然后重试。",
  host_key_unverified: "请先在终端连接此托管平台并确认主机密钥，然后重试。",
  not_a_repository: "请选择 Git 仓库目录，或先初始化 Git。",
  path_already_exists: "请选择其他目录，或移走同名文件后重试。",
  push_rejected_by_remote: "请根据详情中的拒绝原因处理，然后重试。",
  push_rejected_non_fast_forward: "请先拉取远端改动，再重新推送。",
  ref_name_conflict: "请换一个不与现有分支或标签冲突的名称。",
  ref_not_found: "请刷新分支列表，确认分支或标签仍然存在。",
  remote_unreachable: "请检查网络连接和远端仓库地址，然后重试。",
  tag_would_be_clobbered: "请先同步远端标签，或保留本地同名标签后重试。",
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

/** One sentence for a single string, such as a toast description: next step, then the detail. */
export function joinNextStepAndDetail(nextStep: string | undefined, detail: string): string {
  return nextStep === undefined ? detail : `${nextStep}详情：${detail}`;
}

export function describeVersionControlError(
  error: VersionControlError,
  fallbackAction = "完成版本控制操作",
  options: VersionControlErrorOptions = {},
): VersionControlErrorPresentation {
  const operationName = "operation" in error ? operationAction(error.operation) : undefined;
  const action = options.composite
    ? fallbackAction
    : (operationName ??
      (error._tag === "GitPullRequestMaterializationError" ? "检出 PR" : fallbackAction));
  const base = { title: `无法${action}`, detail: detailOf(error) } as const;

  switch (error._tag) {
    case "GitCommandError":
      return {
        ...base,
        nextStep:
          (error.reason === undefined ? undefined : GIT_REASON_NEXT_STEPS[error.reason]) ??
          actionNextStep(action),
      };
    case "TextGenerationError":
      return { ...base, nextStep: "请检查智能体的登录状态和可用性，然后重试。" };
    case "GitManagerError":
      return { ...base, nextStep: actionNextStep(action) };
    case "GitPullRequestMaterializationError":
      return { ...base, nextStep: "请确认分支和工作树目录可用，然后重试。" };
    case "SourceControlProviderError":
    case "SourceControlRepositoryError":
      return { ...base, nextStep: providerNextStep(action) };
    case "VcsProcessSpawnError":
      return { ...base, nextStep: "请确认版本控制工具已安装且可以运行，然后重试。" };
    case "VcsProcessExitError":
      return {
        ...base,
        nextStep:
          error.failureKind === undefined || error.failureKind === "command-failed"
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
    case "VcsRepositoryDetectionError":
      return { ...base, nextStep: "请确认目录存在，并且版本控制工具可以读取。" };
    case "VcsUnsupportedOperationError":
      return { ...base, nextStep: "当前版本控制工具不支持此操作。" };
    case "SourceControlSignInError":
      return {
        title: "无法登录托管平台",
        nextStep: SIGN_IN_NEXT_STEPS[error.reason],
        detail: error.detail,
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
      description: joinNextStepAndDetail(presentation.nextStep, presentation.detail),
    };
  }
  const detail =
    typeof error === "string" ? error : error instanceof Error ? error.message : "发生错误。";
  return { title: `无法${fallbackAction}`, detail, description: detail };
}
