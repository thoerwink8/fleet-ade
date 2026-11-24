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

export interface VersionControlErrorPresentation {
  readonly title: string;
  readonly nextStep?: string;
  readonly detail?: string;
}
export interface VersionControlErrorToastPresentation {
  readonly title: string;
  readonly description: string;
}

const isVersionControlError = Schema.is(VersionControlError);

const GIT_REASON_NEXT_STEPS: Record<GitCommandFailureReason, string> = {
  authentication_failed: "请检查托管平台的登录状态和访问权限，然后重试。",
  branch_already_exists: "请换一个分支名称，或选择已有分支。",
  branch_checked_out_in_worktree: "请选择其他分支，或先移除已检出该分支的工作树。",
  config_locked: "请等正在修改 Git 配置的进程结束，然后重试。",
  host_key_unverified: "请先在终端连接此托管平台并确认主机密钥，然后重试。",
  not_a_repository: "请选择 Git 仓库目录，或先初始化 Git。",
  path_already_exists: "请选择其他目录，或移走同名文件后重试。",
  push_rejected_by_remote: "请查看下方 Git 输出中的拒绝原因，处理后重试。",
  push_rejected_non_fast_forward: "请先拉取远端改动，再重新推送。",
  ref_name_conflict: "请换一个不与现有分支或标签冲突的名称。",
  ref_not_found: "请刷新分支列表，确认分支或标签仍然存在。",
  remote_unreachable: "请检查网络连接和远端仓库地址，然后重试。",
  tag_would_be_clobbered: "请先同步远端标签，或保留本地同名标签后重试。",
};

const VCS_FAILURE_NEXT_STEPS: Record<VcsProcessExitFailureKind, string> = {
  authentication: "请检查托管平台的登录状态和访问权限，然后重试。",
  "not-found": "请确认仓库、分支或 PR 仍然存在，然后重试。",
  "rate-limited": "托管平台正在限制请求，请稍后再试。",
  "command-failed": "请查看下方细节，处理后重试。",
};

const SIGN_IN_NEXT_STEPS: Record<SourceControlSignInFailure, string> = {
  unsupported: "当前托管平台不支持登录。",
  "not-started": "请重新开始登录。",
  cancelled: "请重新开始登录，并完成授权。",
  denied: "请在托管平台允许访问后重试。",
  expired: "请重新开始登录，并在验证码过期前完成授权。",
  failed: "请检查网络连接和登录状态，然后重试。",
};

function operationAction(operation: string): string | undefined {
  switch (operation) {
    case "generateCommitMessage":
      return "生成提交说明";
    case "generatePrContent":
      return "生成 PR 内容";
    case "generateBranchName":
      return "生成分支名称";
    case "generateThreadTitle":
      return "生成会话标题";
    case "cloneRepository":
    case "discardClone":
      return "克隆仓库";
    case "publishRepository":
    case "createRepository":
      return "发布仓库";
    case "lookupRepository":
      return "查询仓库";
    case "preparePullRequestThread":
    case "checkoutChangeRequest":
      return "检出 PR";
    case "createChangeRequest":
      return "创建 PR";
    case "getChangeRequest":
      return "加载 PR";
    case "listChangeRequests":
      return "加载 PR 列表";
    case "getDefaultBranch":
      return "读取默认分支";
    case "getRepositoryCloneUrls":
      return "读取仓库地址";
    case "review.diffFilePatch":
      return "加载文件差异";
  }
  if (operation.includes("preparePullRequestThread")) return "检出 PR";

  if (operation.includes("createWorktree")) return "创建工作树";
  if (operation.includes("removeWorktree")) return "删除工作树";
  if (operation.includes("push")) return "推送";
  if (operation.includes("pull")) return "拉取";
  if (operation.includes("commit")) return "提交";
  if (operation.includes("switchRef")) return "切换分支";
  if (operation.includes("createRef")) return "创建并切换分支";
  if (operation.includes("listRefs")) return "加载分支";
  if (operation.includes("status")) return "读取 Git 状态";
  if (operation.includes("Diff") || operation.includes("diff")) return "加载差异";
  return undefined;
}

function detailOf(error: VersionControlError): string {
  if ("detail" in error && error.detail.length > 0) return error.detail;
  return error.message;
}

function assertNever(error: never): never {
  throw new Error(`未处理的版本控制错误：${JSON.stringify(error)}`);
}

export function describeVersionControlError(
  error: VersionControlError,
  fallbackAction = "完成版本控制操作",
): VersionControlErrorPresentation {
  const action =
    "operation" in error
      ? (operationAction(error.operation) ?? fallbackAction)
      : error._tag === "GitPullRequestMaterializationError"
        ? "检出 PR"
        : fallbackAction;
  const base = { title: `无法${action}`, detail: detailOf(error) } as const;

  switch (error._tag) {
    case "GitCommandError":
      return {
        ...base,
        ...(error.reason === undefined
          ? { nextStep: "请查看下方细节，处理后重试。" }
          : { nextStep: GIT_REASON_NEXT_STEPS[error.reason] }),
      };
    case "TextGenerationError":
      return { ...base, nextStep: "请检查智能体的登录状态和可用性，然后重试。" };
    case "GitManagerError":
      return { ...base, nextStep: "请查看下方细节，处理后重试。" };
    case "GitPullRequestMaterializationError":
      return { ...base, nextStep: "请确认分支和工作树目录可用，然后重试。" };
    case "SourceControlProviderError":
    case "SourceControlRepositoryError":
      return {
        ...base,
        nextStep: "请检查托管平台的登录状态、访问权限和网络连接，然后重试。",
      };
    case "VcsProcessSpawnError":
      return { ...base, nextStep: "请确认版本控制工具已安装且可以运行，然后重试。" };
    case "VcsProcessExitError":
      return {
        ...base,
        nextStep:
          error.failureKind === undefined
            ? "请查看下方细节，处理后重试。"
            : VCS_FAILURE_NEXT_STEPS[error.failureKind],
      };
    case "VcsProcessTimeoutError":
      return { ...base, nextStep: "请检查网络连接和仓库状态，然后重试。" };
    case "VcsProcessStdinWriteError":
    case "VcsProcessOutputReadError":
    case "VcsProcessMissingExitCodeError":
      return {
        ...base,
        nextStep: "请重试；如果仍然失败，请检查版本控制工具是否正常运行。",
      };
    case "VcsProcessOutputLimitError":
      return { ...base, nextStep: "请缩小操作范围后重试。" };
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
): VersionControlErrorToastPresentation {
  if (isVersionControlError(error)) {
    const presentation = describeVersionControlError(error, fallbackAction);
    return {
      title: presentation.title,
      description: [presentation.nextStep, presentation.detail].filter(Boolean).join("\n\n"),
    };
  }
  return {
    title: `无法${fallbackAction}`,
    description:
      typeof error === "string" ? error : error instanceof Error ? error.message : "发生错误。",
  };
}
