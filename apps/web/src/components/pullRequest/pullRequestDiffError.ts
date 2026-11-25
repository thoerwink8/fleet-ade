/**
 * Diff failures currently include transport wrappers, so recognize the reason inside them.
 * This has to read the text: the server does not yet send a typed rate-limit reason, and the
 * provider's `reason` is lost when the failure is encoded for HTTP.
 */
export function describePullRequestDiffError(error: string, providerName: string, term: string) {
  if (/\brate limit\b|\brate[-_]limited\b|\btoo many requests\b/i.test(error)) {
    return {
      title: `${providerName} 已达到速率上限`,
      description: `${providerName} 正在临时限制请求，因此无法加载此差异。请在速率限制重置后重试，或在 ${providerName} 上查看更改。`,
    };
  }

  return {
    title: "无法加载更改",
    description: `这台电脑无法加载此 ${term} 的差异。请重试，或在 ${providerName} 上查看更改。`,
  };
}
