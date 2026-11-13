import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

export function offHeadPullRequestCheckoutToast(terminology: ChangeRequestTerminology) {
  return {
    type: "warning",
    title: "已检出，但未确认是否为最新提交",
    description: `无法确认此工作副本位于 ${terminology.singular} 的最新提交上，因此代码可能有差异。存在本地提交或未提交的改动时，工作副本会保持原位。`,
  } as const;
}
