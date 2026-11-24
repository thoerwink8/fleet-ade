import { PullRequestOperationError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describePullRequestDiffError } from "./pullRequestDiffError";

const providerCause = (reason: string) => ({
  _tag: "PullRequestProviderError",
  provider: "github",
  operation: "diff",
  reason,
  detail: "the host answered 429",
});

const diffFailure = (reason?: string) =>
  new PullRequestOperationError({
    operation: "diff",
    detail: "Pull request diff failed.",
    ...(reason === undefined ? {} : { cause: providerCause(reason) }),
  });

describe("describePullRequestDiffError", () => {
  // regression: #19945 the rate limit is read from the typed provider failure, not its prose
  it("explains a typed rate limit without exposing the endpoint", () => {
    const result = describePullRequestDiffError(
      "Failed to fetch remote environment endpoint http://127.0.0.1:49477/api/pull-requests/diff (PullRequestOperationError: Pull request operation diff failed: github requests to github.com are paused until the rate limit resets.).",
      "GitHub",
      "pull request",
      diffFailure("rate-limited"),
    );

    expect(result.title).toBe("GitHub 已达到速率上限");
    expect(result.description).toContain("速率限制重置后重试");
    expect(result.description).not.toContain("127.0.0.1");
    expect(result.description).not.toContain("PullRequestOperationError");
  });

  it("does not blame a rate limit for prose without the typed provider failure", () => {
    for (const failure of [
      diffFailure("unauthenticated"),
      diffFailure(),
      undefined,
      "Pull request operation diff failed: github rate limit exceeded.",
      "GitHub API rate limit exceeded.",
    ]) {
      const result = describePullRequestDiffError(
        "Failed to fetch (PullRequestOperationError: diff failed: rate limit exceeded).",
        "GitHub",
        "pull request",
        failure,
      );

      expect(result.title).toBe("无法加载更改");
      expect(result.description).toContain("重试");
      expect(result.description).not.toContain("速率限制");
      expect(result.description).not.toContain("PullRequestOperationError");
      expect(result.description).not.toContain("rate limit");
    }
  });

  it("does not blame a rate limit for an unknown connection failure", () => {
    const result = describePullRequestDiffError(
      "Failed to fetch remote environment endpoint http://localhost:49477/api/pull-requests/diff (TypeError: Failed to fetch).",
      "GitHub",
      "pull request",
    );

    expect(result.title).toBe("无法加载更改");
    expect(result.description).toContain("重试");
    expect(result.description).not.toContain("localhost");
    expect(result.description).not.toContain("limit");
  });
});
