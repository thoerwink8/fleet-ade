import {
  GitCommandError,
  GitManagerError,
  GitPullRequestMaterializationError,
  SourceControlProviderError,
  SourceControlRepositoryError,
  SourceControlSignInError,
  TextGenerationError,
  VcsProcessExitError,
  VcsProcessMissingExitCodeError,
  VcsProcessOutputLimitError,
  VcsProcessOutputReadError,
  VcsProcessSpawnError,
  VcsProcessStdinWriteError,
  VcsProcessTimeoutError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeVersionControlError,
  presentVersionControlError,
  type VersionControlError,
} from "./versionControlError.logic";

interface ErrorCase {
  readonly error: VersionControlError;
  readonly title: string;
  readonly nextStep?: string;
  readonly fallbackAction?: string;
}

const provider = "github" as SourceControlProviderKind;
const processContext = {
  operation: "GitVcsDriver.pushCurrentBranch",
  command: "git",
  cwd: "/repo",
};
const rawDetail = "fatal: raw git output\nerror: keep this verbatim";

const cases: ReadonlyArray<ErrorCase> = [
  {
    error: new GitCommandError({
      ...processContext,
      detail: rawDetail,
      reason: "push_rejected_non_fast_forward",
    }),
    title: "无法推送",
    nextStep: "请先拉取远端改动，再重新推送。",
  },
  {
    error: new TextGenerationError({ operation: "generateCommitMessage", detail: rawDetail }),
    title: "无法生成提交说明",
  },
  {
    error: new GitManagerError({ operation: "runStackedAction", cwd: "/repo", detail: rawDetail }),
    title: "无法提交",
    fallbackAction: "提交",
  },
  {
    error: new GitPullRequestMaterializationError({
      cwd: "/repo",
      pullRequestNumber: 42,
      headRepository: "owner/repo",
      headBranch: "feature",
      localBranch: "pr-42",
      cause: new Error(rawDetail),
    }),
    title: "无法检出 PR",
  },
  {
    error: new SourceControlProviderError({
      provider,
      operation: "createChangeRequest",
      cwd: "/repo",
      detail: rawDetail,
    }),
    title: "无法创建 PR",
  },
  {
    error: new VcsProcessSpawnError({ ...processContext, cause: new Error("spawn git ENOENT") }),
    title: "无法推送",
  },
  {
    error: new VcsProcessExitError({
      ...processContext,
      exitCode: 1,
      detail: rawDetail,
      failureKind: "rate-limited",
    }),
    title: "无法推送",
    nextStep: "托管平台正在限制请求，请稍后再试。",
  },
  {
    error: new VcsProcessTimeoutError({ ...processContext, timeoutMs: 1000 }),
    title: "无法推送",
  },
  {
    error: new VcsProcessStdinWriteError({
      ...processContext,
      stdinBytes: 10,
      cause: new Error(rawDetail),
    }),
    title: "无法推送",
  },
  {
    error: new VcsProcessOutputReadError({
      ...processContext,
      stream: "stderr",
      cause: new Error(rawDetail),
    }),
    title: "无法推送",
  },
  {
    error: new VcsProcessOutputLimitError({
      ...processContext,
      stream: "stdout",
      maxBytes: 100,
      observedBytes: 101,
    }),
    title: "无法推送",
  },
  {
    error: new VcsProcessMissingExitCodeError(processContext),
    title: "无法推送",
  },
  {
    error: new VcsRepositoryDetectionError({
      operation: "status",
      cwd: "/repo",
      detail: rawDetail,
    }),
    title: "无法读取 Git 状态",
  },
  {
    error: new VcsUnsupportedOperationError({
      operation: "review.diffFilePatch",
      kind: "git",
      detail: rawDetail,
    }),
    title: "无法加载文件差异",
  },
  {
    error: new SourceControlSignInError({
      provider,
      host: "github.com",
      reason: "expired",
      detail: rawDetail,
    }),
    title: "无法登录托管平台",
    nextStep: "请重新开始登录，并在验证码过期前完成授权。",
  },
  {
    error: new SourceControlRepositoryError({
      provider,
      operation: "cloneRepository",
      detail: rawDetail,
    }),
    title: "无法克隆仓库",
  },
];

describe("describeVersionControlError", () => {
  it.each(cases)(
    "presents $error._tag in Chinese without dropping diagnostics",
    ({ error, title, nextStep, fallbackAction }) => {
      const result = describeVersionControlError(error, fallbackAction);

      expect(result.title).toBe(title);
      expect(result.title).toMatch(/[\u4e00-\u9fff]/u);
      expect(result.title).not.toContain(error._tag);
      expect(result.title).not.toBe(error.message);
      expect(result.detail).toBe(
        "detail" in error && error.detail.length > 0 ? error.detail : error.message,
      );
      if (nextStep !== undefined) expect(result.nextStep).toBe(nextStep);
    },
  );

  it("uses every structured Git reason without reading the diagnostic text", () => {
    const error = new GitCommandError({
      operation: "cloneRepository",
      command: "git",
      cwd: "/repo",
      detail: "unrelated diagnostic words",
      reason: "not_a_repository",
    });

    expect(describeVersionControlError(error)).toEqual({
      title: "无法克隆仓库",
      nextStep: "请选择 Git 仓库目录，或先初始化 Git。",
      detail: "unrelated diagnostic words",
    });
  });

  it("keeps unrelated failures on the caller's existing fallback", () => {
    expect(presentVersionControlError(new Error("unrelated"), "打开文件")).toEqual({
      title: "无法打开文件",
      description: "unrelated",
    });
  });
});
