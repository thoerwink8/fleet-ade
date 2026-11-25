import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  type PullRequestUnavailableReason,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isPullRequestOperationError = Schema.is(PullRequestOperationError);
const isPullRequestUnavailableError = Schema.is(PullRequestUnavailableError);

const UNAVAILABLE_NEXT_STEPS: Record<
  PullRequestUnavailableReason,
  (providerName: string) => string
> = {
  "cli-missing": (providerName) => `请安装并设置 ${providerName} 读取 PR 所需的工具，然后重试`,
  "cli-unauthenticated": (providerName) => `请先登录 ${providerName}，然后重试`,
  "provider-unsupported": () => "当前托管平台暂不支持查看此差异",
};

export function describePullRequestDiffError(error: unknown, providerName: string, term: string) {
  if (isPullRequestOperationError(error) && error.reason === "rate-limited") {
    return {
      title: `${providerName} 已达到速率上限`,
      description: `${providerName} 正在临时限制请求，因此无法加载此差异。请在速率限制重置后重试，或在 ${providerName} 上查看更改。`,
    };
  }

  const unavailableStep = isPullRequestUnavailableError(error)
    ? UNAVAILABLE_NEXT_STEPS[error.reason](providerName)
    : undefined;
  return {
    title: "无法加载更改",
    description:
      unavailableStep === undefined
        ? `这台电脑无法加载此 ${term} 的差异。请重试，或在 ${providerName} 上查看更改。`
        : `${unavailableStep}，或在 ${providerName} 上查看更改。`,
  };
}

export function pullRequestDiffErrorDetail(error: unknown): string {
  if (isPullRequestOperationError(error)) return error.detail;
  if (isPullRequestUnavailableError(error)) return error.message;
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "发生错误。";
}
