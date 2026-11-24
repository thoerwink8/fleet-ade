import { PullRequestOperationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isPullRequestOperationError = Schema.is(PullRequestOperationError);

/** Only the provider's typed failure names the limit; error text stays a technical detail. */
function isRateLimitedDiffFailure(failure: unknown): boolean {
  if (!isPullRequestOperationError(failure)) return false;
  const cause = failure.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "PullRequestProviderError" &&
    "reason" in cause &&
    cause.reason === "rate-limited"
  );
}

export function describePullRequestDiffError(
  error: string,
  providerName: string,
  term: string,
  failure?: unknown,
) {
  if (isRateLimitedDiffFailure(failure)) {
    return {
      title: `${providerName} 已达到速率上限`,
      description: `${providerName} 正在临时限制请求，因此无法加载此差异。请在速率限制重置后重试，或在 ${providerName} 上查看更改。`,
    };
  }

  return {
    title: "无法加载更改",
    description: `环境无法加载此 ${term} 的差异。请重试，或在 ${providerName} 上查看更改。`,
  };
}
