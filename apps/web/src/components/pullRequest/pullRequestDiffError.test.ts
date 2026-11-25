import { PullRequestOperationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { describePullRequestDiffError } from "./pullRequestDiffError";

describe("describePullRequestDiffError", () => {
  it("explains the rate limit inside an HTTP transport error without exposing the endpoint", () => {
    const error =
      "Failed to fetch remote environment endpoint http://127.0.0.1:49477/api/pull-requests/diff (PullRequestOperationError: Pull request operation diff failed: github requests to github.com are paused until the rate limit resets.).";
    const result = describePullRequestDiffError(error, "GitHub", "pull request");

    expect(result.title).toBe("GitHub 已达到速率上限");
    expect(result.description).toContain("速率限制重置后重试");
    expect(result.description).not.toContain("127.0.0.1");
    expect(result.description).not.toContain("PullRequestOperationError");
  });

  // regression: #19945 diff load failures from a provider quota showed a generic error
  it("recognizes a provider's API quota error", () => {
    expect(
      describePullRequestDiffError("GitHub API rate limit exceeded.", "GitHub", "pull request")
        .title,
    ).toBe("GitHub 已达到速率上限");
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

  // Why the check above reads text: a typed `reason` on the provider failure does not survive
  // the JSON transport, so there is nothing typed left to read on the client.
  it("loses the provider's typed reason when the failure is encoded for transport", () => {
    class ProviderFailure extends Schema.TaggedError<ProviderFailure>()(
      "PullRequestProviderError",
      { reason: Schema.String, detail: Schema.String },
    ) {
      override get message() {
        return `github failed in diff: ${this.detail}`;
      }
    }
    const codec = Schema.toCodecJson(PullRequestOperationError);
    const sent = Schema.encodeSync(codec)(
      new PullRequestOperationError({
        operation: "diff",
        detail: "github requests are paused until the rate limit resets.",
        cause: new ProviderFailure({ reason: "rate-limited", detail: "429" }),
      }),
    );
    const received = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(sent)));

    expect(received.cause).not.toHaveProperty("reason");
    expect(received.cause).not.toHaveProperty("_tag");
    expect(received.detail).toContain("rate limit");
  });
});
