import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";

import type { ColdVerifyOutcome } from "./coldVerifyVerdict.ts";

/** 合并闸读的那个上下文，固定不变。 */
export const COLD_VERIFY_CONTEXT = "cold-verify";

/** GitHub 提交状态 description 上限，按字符数。 */
const DESCRIPTION_MAX = 140;

const SHA = /^[0-9a-f]{40}$/;

export const CommitStatusState = Schema.Literals(["success", "failure", "error", "pending"]);
export type CommitStatusState = typeof CommitStatusState.Type;

/** 写上之后回执对得上的结果。没写上是 CommitStatusWriteError，不靠「没有状态」冒充已验。 */
export type CommitStatusWrite = {
  readonly kind: "written";
  readonly sha: string;
  readonly state: CommitStatusState;
  readonly description: string;
};

export class CommitStatusWriteError extends Schema.TaggedError<CommitStatusWriteError>()(
  "CommitStatusWriteError",
  {
    host: Schema.String,
    repository: Schema.String,
    sha: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `没把 cold-verify 写到 ${this.sha.slice(0, 7)}（${this.repository}）：${this.reason}`;
  }
}

export interface CommitStatusTarget {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly sha: string;
}

/** GitHub「创建提交状态」的回包字段。它不返回 sha，提交挂在 url 末段（…/statuses/<sha>）。 */
const StatusReceipt = Schema.Struct({
  url: Schema.String,
  state: CommitStatusState,
  context: Schema.String,
  description: Schema.NullOr(Schema.String),
});

const decodeReceipt = Schema.decodeUnknownOption(Schema.fromJsonString(StatusReceipt));

const receiptSha = (url: string): string | undefined => {
  const segment = url.split("/").at(-1);
  return segment !== undefined && SHA.test(segment) ? segment : undefined;
};

function fit(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > DESCRIPTION_MAX
    ? `${chars.slice(0, DESCRIPTION_MAX - 1).join("")}…`
    : chars.join("");
}

/** 裁决翻成提交状态。没验成、交人都不是 success：没写上或写成通过都会冒充已验。 */
function statusFor(outcome: ColdVerifyOutcome): {
  readonly state: CommitStatusState;
  readonly description: string;
} {
  switch (outcome.kind) {
    case "pass":
      return {
        state: "success",
        description: fit(
          outcome.suggestions.length > 0
            ? `验收通过（${outcome.suggestions.length} 条建议，不挡）`
            : "验收通过",
        ),
      };
    case "block":
      return {
        state: "failure",
        description: fit(`验收没过：${outcome.problems[0] ?? "有能挡的问题"}`),
      };
    case "unverified":
      return { state: "error", description: fit("没验成：这一轮一条结论都没写") };
    case "handover":
      return {
        state: "error",
        description: fit(`交人：要 diff 外面的证据才判得了（${outcome.handovers.length} 条）`),
      };
  }
}

function repositoryOf(owner: string, repo: string): string | undefined {
  if (owner === "" || repo === "" || owner.includes("/") || repo.includes("/")) return undefined;
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export class GitHubCommitStatus extends Context.Service<
  GitHubCommitStatus,
  {
    /**
     * 把裁决写成调用方给的那个 sha 上的 `cold-verify` 提交状态。
     * 登录走现成 GitHubRest（它用 GitHubCredentials）。HTTP 失败是失败：留下未写上，不改已经算出的裁决。
     */
    readonly writeColdVerify: (
      target: CommitStatusTarget,
      outcome: ColdVerifyOutcome,
    ) => Effect.Effect<CommitStatusWrite, CommitStatusWriteError>;
  }
>()("t3/pipeline/GitHubCommitStatus") {}

const make = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;

  const writeColdVerify: GitHubCommitStatus["Service"]["writeColdVerify"] = Effect.fn(
    "GitHubCommitStatus.writeColdVerify",
  )(function* (target, outcome) {
    const planned = statusFor(outcome);
    const repository = `${target.owner}/${target.repo}`;
    const fail = (reason: string) =>
      new CommitStatusWriteError({
        host: target.host,
        repository,
        sha: target.sha,
        reason,
      });

    if (!GitHubCredentials.isGitHubHost(target.host)) {
      return yield* fail(`主机名不是 GitHub 主机：${target.host}`);
    }
    if (!SHA.test(target.sha)) {
      return yield* fail("sha 不是 40 位小写十六进制，拒绝写到别的提交上");
    }
    const slug = repositoryOf(target.owner, target.repo);
    if (slug === undefined) {
      return yield* fail("仓库名不是 owner/repo");
    }

    const response = yield* rest
      .rest({
        host: target.host,
        operation: "writeColdVerifyStatus",
        method: "POST",
        path: `repos/${slug}/statuses/${target.sha}`,
        body: {
          state: planned.state,
          context: COLD_VERIFY_CONTEXT,
          description: planned.description,
        },
      })
      .pipe(Effect.mapError((error) => fail(error.message)));

    if (response.status < 200 || response.status >= 300) {
      return yield* fail(`GitHub 回了 HTTP ${response.status}`);
    }
    const receipt = decodeReceipt(response.body);
    if (
      Option.isNone(receipt) ||
      receipt.value.context !== COLD_VERIFY_CONTEXT ||
      receipt.value.state !== planned.state ||
      receiptSha(receipt.value.url) !== target.sha
    ) {
      return yield* fail("回执对不上这次要写的 sha、上下文或状态");
    }
    return {
      kind: "written" as const,
      sha: target.sha,
      state: planned.state,
      description: planned.description,
    };
  });

  return GitHubCommitStatus.of({ writeColdVerify });
});

export const layer = Layer.effect(GitHubCommitStatus, make);
