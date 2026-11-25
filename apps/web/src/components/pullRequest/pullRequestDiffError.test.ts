import {
  PullRequestOperationError,
  PullRequestUnavailableError,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { describePullRequestDiffError } from "./pullRequestDiffError";

describe("describePullRequestDiffError", () => {
  const generic = (error: unknown) => describePullRequestDiffError(error, "GitHub", "pull request");

  it("explains a typed rate limit without reading the error text", () => {
    const result = generic(
      new PullRequestOperationError({
        operation: "diff",
        detail: "requests are paused.",
        reason: "rate-limited",
      }),
    );

    expect(result).toEqual({
      title: "GitHub 已达到速率上限",
      description:
        "GitHub 正在临时限制请求，因此无法加载此差异。请在速率限制重置后重试，或在 GitHub 上查看更改。",
    });
  });

  it("explains a typed not-found failure without treating its text as a rate limit", () => {
    const result = generic(
      new PullRequestOperationError({
        operation: "diff",
        detail: "GitHub API rate limit exceeded.",
        reason: "not-found",
      }),
    );

    expect(result.title).toBe("无法加载更改");
    expect(result.description).toContain("重试");
    expect(result.description).not.toContain("速率上限");
  });

  it("explains a typed unavailable host from its reason", () => {
    const result = generic(
      new PullRequestUnavailableError({
        reason: "cli-missing",
        provider: SourceControlProviderKind.make("github"),
      }),
    );

    expect(result.title).toBe("无法加载更改");
    expect(result.description).toContain("请安装并设置 GitHub 读取 PR 所需的工具");
  });

  it("keeps a connection failure generic when an older failure has no typed reason", () => {
    const result = generic(
      "Failed to fetch remote environment endpoint http://127.0.0.1:49477/api/pull-requests/diff (PullRequestOperationError: Pull request operation diff failed: github requests are paused until the rate limit resets.).",
    );

    expect(result.title).toBe("无法加载更改");
    expect(result.description).not.toContain("127.0.0.1");
    expect(result.description).not.toContain("速率上限");
  });

  it("does not blame a rate limit for an unknown connection failure", () => {
    const result = generic(
      "Failed to fetch remote environment endpoint http://localhost:49477/api/pull-requests/diff (TypeError: Failed to fetch).",
    );

    expect(result.title).toBe("无法加载更改");
    expect(result.description).toContain("重试");
    expect(result.description).not.toContain("localhost");
    expect(result.description).not.toContain("limit");
  });

  it("preserves the operation reason across the JSON transport", () => {
    const codec = Schema.toCodecJson(PullRequestOperationError);
    const sent = Schema.encodeSync(codec)(
      new PullRequestOperationError({
        operation: "diff",
        detail: "requests are paused.",
        reason: "rate-limited",
      }),
    );
    const received = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(sent)));

    expect(describePullRequestDiffError(received, "GitHub", "pull request").title).toBe(
      "GitHub 已达到速率上限",
    );
  });
});
