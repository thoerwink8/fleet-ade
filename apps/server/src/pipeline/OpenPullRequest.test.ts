import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type ChangeRequest, type GitRunStackedActionResult } from "@t3tools/contracts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { PullRequestAdditions, layer as budgetLayer } from "./budget.ts";
import {
  CiCheckReadError,
  CiCheckReader,
  OpenPullRequest,
  PullRequestOpener,
  acceptanceItems,
  layer,
  layerOpener,
  layerReader,
  pullRequestBody,
  recordedChecks,
  type CiCheckOutcome,
  type PullRequestDraft,
} from "./OpenPullRequest.ts";
import { PipelineGitHubIssues, type PipelineIssue } from "./GitHubIssues.ts";
import {
  PipelineRuns,
  PipelineUsage,
  PipelineUsageUnreadable,
  layer as runsLayer,
  type UsageRecord,
} from "./PipelineRuns.ts";
import * as ClaimLease from "./claimLease.ts";
import { layerPortsDefault } from "./intakeGates.ts";

const ENDED_AT = "1970-01-01T01:00:00.000Z";
const SHA = "abc123";
const BRANCH = "pipeline/6-fix-tests";
const SUCCESS = "1111111";
const RED = "2222222";
const MISSING = "3333333";
const UNREAD = "4444444";

const issue = (number: number, title = "fix tests"): PipelineIssue => ({
  number,
  title,
  body: "## 怎么算做完\n- 跑通测试\n",
  labels: ["交给 ADE"],
  author: { login: "thoerwink8", id: 1, type: "User" },
});

const tickLayer = (input: {
  readonly enabled?: boolean;
  readonly repos?: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<PipelineIssue>;
  readonly opened: Ref.Ref<ReadonlyArray<PullRequestDraft>>;
  readonly reads: Ref.Ref<ReadonlyArray<string>>;
  readonly open?: PullRequestOpener["Service"]["open"];
  readonly read?: CiCheckReader["Service"]["read"];
  readonly additions?: PullRequestAdditions["Service"]["read"];
  readonly usage?: Effect.Effect<ReadonlyArray<UsageRecord>, PipelineUsageUnreadable>;
  readonly worktrees?: ReadonlyArray<{ readonly threadId: string; readonly worktreePath: string }>;
}) => {
  const settings = ServerSettings.layerTest({
    pipelineEnabled: input.enabled ?? true,
    ...(input.repos === undefined ? {} : { pipelineRepos: input.repos }),
  });
  const issues = Layer.succeed(PipelineGitHubIssues, {
    addLabel: () => Effect.void,
    listEligible: () => Effect.succeed(input.issues),
    read: (number: number, repo?: { readonly owner: string; readonly name: string }) => {
      const found = input.issues.find((item) => item.number === number);
      if (input.repos !== undefined) {
        assert.strictEqual(repo?.owner, "acme");
        assert.strictEqual(repo?.name, "widgets");
      }
      return found === undefined ? Effect.die("missing issue") : Effect.succeed(found);
    },
  });
  const runs = runsLayer.pipe(
    Layer.provide(issues),
    Layer.provide(Layer.succeed(PipelineUsage, { read: () => input.usage ?? Effect.succeed([]) })),
    Layer.provide(settings),
    Layer.provide(layerPortsDefault),
    Layer.provide(ClaimLease.layerPort()),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const opener = Layer.succeed(PullRequestOpener, {
    open:
      input.open ??
      ((draft) =>
        Ref.update(input.opened, (drafts) => [...drafts, draft]).pipe(Effect.as({ number: 7 }))),
  });
  const reader = Layer.succeed(CiCheckReader, {
    read:
      input.read ??
      ((entry) =>
        Ref.update(input.reads, (shas) => [...shas, entry.headSha]).pipe(
          Effect.as({ kind: "pending" as const }),
        )),
  });
  const projections = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
    getThreadWorktreePaths: () =>
      Effect.succeed(
        (input.worktrees ?? []).map((entry) => ({
          threadId: ThreadId.make(entry.threadId),
          worktreePath: entry.worktreePath,
        })),
      ),
  } as unknown as ProjectionStore.ProjectionStoreV2["Service"]);
  return layer.pipe(
    Layer.provide(budgetLayer),
    Layer.provide(
      Layer.succeed(PullRequestAdditions, {
        read: input.additions ?? (() => Effect.succeed(0)),
      }),
    ),
    Layer.provide(opener),
    Layer.provide(reader),
    Layer.provide(projections),
    Layer.provide(settings),
    Layer.provide(issues),
    Layer.provideMerge(runs),
  );
};

const count = (shas: ReadonlyArray<string>, sha: string) =>
  shas.filter((item) => item === sha).length;

describe("OpenPullRequest", () => {
  it.effect("跨仓同号开自己的 local PR 并读取自己的 CI", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<PullRequestDraft>>([]);
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      const targets: Array<unknown> = [];
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        yield* runs.tick;
        yield* runs.note(
          6,
          {
            status: "session",
            threadId: "thread:acme",
            sessionEndedAt: ENDED_AT,
            headSha: SHA,
          },
          "acme/widgets",
        );
        yield* (yield* OpenPullRequest).tick;
        const listed = (yield* runs.list).runs;
        assert.strictEqual(
          listed.find((row) => row.repository === "acme/widgets")?.status,
          "verify",
        );
        assert.strictEqual(
          listed.find((row) => row.repository === "thoerwink8/fleet-ade")?.status,
          "claimed",
        );
        const drafts = yield* Ref.get(opened);
        assert.strictEqual(drafts[0]?.branch, "local/6-fix-tests");
        assert.strictEqual(drafts[0]?.cwd, "/wt/acme");
        assert.deepStrictEqual(targets, [{ headSha: SHA, repository: "acme/widgets" }]);
      }).pipe(
        Effect.provide(
          tickLayer({
            repos: ["thoerwink8/fleet-ade", "acme/widgets"],
            issues: [issue(6)],
            opened,
            reads,
            worktrees: [{ threadId: "thread:acme", worktreePath: "/wt/acme" }],
            read: (input) => {
              targets.push(input);
              return Effect.succeed({ kind: "success" });
            },
          }),
        ),
      );
    }),
  );

  it.effect("全局开关关闭时只给有控制线程的运行开 PR", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<PullRequestDraft>>([]);
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const sql = yield* SqlClient.SqlClient;
        const started = yield* runs.startSupervised({
          issueNumber: 7,
          repository: "thoerwink8/fleet-ade",
          controllerThreadId: "thread:controller",
        });
        assert.strictEqual(started.status, "started");
        yield* runs.note(
          7,
          {
            status: "session",
            threadId: "thread:supervised",
            sessionEndedAt: ENDED_AT,
            headSha: SHA,
          },
          "thoerwink8/fleet-ade",
        );
        yield* sql`
          INSERT INTO pipeline_runs (
            repository, issue_number, title, status, thread_id, head_sha, session_ended_at, updated_at
          ) VALUES (
            'thoerwink8/fleet-ade', 6, 'fix tests', 'session', 'thread:plain', ${SHA}, ${ENDED_AT}, ${ENDED_AT}
          )
        `;
        yield* (yield* OpenPullRequest).tick;
        const listed = (yield* runs.list).runs;
        const plain = listed.find((run) => run.issueNumber === 6);
        const supervised = listed.find((run) => run.issueNumber === 7);
        assert.strictEqual(plain?.status, "session");
        assert.strictEqual(plain?.prNumber, null);
        const drafts = yield* Ref.get(opened);
        assert.strictEqual(drafts.length, 1);
        assert.strictEqual(drafts[0]?.cwd, "/wt/supervised");
        assert.strictEqual(supervised?.prNumber, 7);
        assert.strictEqual(supervised?.status, "verify");
      }).pipe(
        Effect.provide(
          tickLayer({
            issues: [issue(6), issue(7)],
            enabled: false,
            opened,
            reads,
            worktrees: [{ threadId: "thread:supervised", worktreePath: "/wt/supervised" }],
            read: () => Effect.succeed({ kind: "success" }),
          }),
        ),
      );
    }),
  );
  it.effect("does not open a pull request when the head is unknown", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<PullRequestDraft>>([]);
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const opening = yield* OpenPullRequest;
        yield* runs.tick;
        yield* runs.note(6, {
          status: "session",
          threadId: "thread-6",
          sessionEndedAt: ENDED_AT,
        });
        yield* opening.tick;
        const run = (yield* runs.list).runs.find((item) => item.issueNumber === 6);
        assert.strictEqual(run?.status, "session");
        assert.strictEqual(run?.prNumber, null);
        assert.strictEqual(run?.detail, "没查成");
        assert.strictEqual((yield* Ref.get(opened)).length, 0);
      }).pipe(
        Effect.provide(
          tickLayer({
            issues: [issue(6)],
            opened,
            reads,
            worktrees: [{ threadId: "thread-6", worktreePath: "/wt/6" }],
          }),
        ),
      );
    }),
  );

  it.effect("opens one pull request and does not open another on the next tick", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<PullRequestDraft>>([]);
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const opening = yield* OpenPullRequest;
        yield* runs.tick;
        yield* runs.note(6, {
          status: "session",
          threadId: "thread-6",
          sessionEndedAt: ENDED_AT,
          headSha: SHA,
        });
        yield* opening.tick;
        const first = (yield* runs.list).runs.find((item) => item.issueNumber === 6);
        const drafts = yield* Ref.get(opened);
        assert.strictEqual(first?.status, "checks");
        assert.strictEqual(first?.prNumber, 7);
        assert.strictEqual(first?.headSha, SHA);
        assert.strictEqual(drafts.length, 1);
        assert.strictEqual(drafts[0]?.branch, BRANCH);
        assert.strictEqual(drafts[0]?.cwd, "/wt/6");
        assert.strictEqual(drafts[0]?.issueBody, issue(6).body);
        assert.strictEqual(drafts[0]?.issueBody.includes("Closes"), false);
        yield* opening.tick;
        const second = (yield* runs.list).runs.find((item) => item.issueNumber === 6);
        assert.strictEqual(second?.prNumber, 7);
        assert.strictEqual(second?.headSha, SHA);
        assert.strictEqual((yield* Ref.get(opened)).length, 1);
        assert.deepStrictEqual(yield* Ref.get(reads), [SHA, SHA]);
      }).pipe(
        Effect.provide(
          tickLayer({
            issues: [issue(6)],
            opened,
            reads,
            worktrees: [{ threadId: "thread-6", worktreePath: "/wt/6" }],
          }),
        ),
      );
    }),
  );

  it.effect("keeps an existing pull request and the recorded head", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<PullRequestDraft>>([]);
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const opening = yield* OpenPullRequest;
        yield* runs.tick;
        yield* runs.note(6, { status: "pr-open", prNumber: 9, headSha: SHA });
        yield* opening.tick;
        const run = (yield* runs.list).runs.find((item) => item.issueNumber === 6);
        assert.strictEqual(run?.status, "checks");
        assert.strictEqual(run?.prNumber, 9);
        assert.strictEqual(run?.headSha, SHA);
        assert.strictEqual((yield* Ref.get(opened)).length, 0);
        assert.deepStrictEqual(yield* Ref.get(reads), [SHA]);
      }).pipe(Effect.provide(tickLayer({ issues: [issue(6)], opened, reads })));
    }),
  );

  it.effect("separates CI success, failure, a missing check, and a failed read", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<PullRequestDraft>>([]);
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      const read = (entry: { readonly headSha: string }) =>
        Ref.update(reads, (shas) => [...shas, entry.headSha]).pipe(
          Effect.flatMap(() => {
            const outcome: CiCheckOutcome | undefined =
              entry.headSha === SUCCESS
                ? { kind: "success" }
                : entry.headSha === RED
                  ? { kind: "failure" }
                  : entry.headSha === MISSING
                    ? { kind: "missing" }
                    : undefined;
            return outcome === undefined
              ? Effect.fail(new CiCheckReadError())
              : Effect.succeed(outcome);
          }),
        );
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const opening = yield* OpenPullRequest;
        yield* runs.tick;
        yield* runs.note(1, { status: "checks", prNumber: 11, headSha: SUCCESS });
        yield* runs.note(2, { status: "checks", prNumber: 12, headSha: RED });
        yield* runs.note(3, { status: "checks", prNumber: 13, headSha: MISSING });
        yield* runs.note(4, { status: "checks", prNumber: 14, headSha: UNREAD });
        yield* opening.tick;
        yield* opening.tick;
        const listed = (yield* runs.list).runs;
        const success = listed.find((item) => item.issueNumber === 1);
        const red = listed.find((item) => item.issueNumber === 2);
        const missing = listed.find((item) => item.issueNumber === 3);
        const unread = listed.find((item) => item.issueNumber === 4);
        assert.strictEqual(success?.status, "verify");
        assert.strictEqual(success?.detail, "CI 已绿、未验");
        assert.strictEqual(success?.stuckReason, null);
        assert.strictEqual(red?.status, "claimed");
        assert.strictEqual(red?.stuckReason, null);
        assert.strictEqual(red?.detail, "已续一次");
        assert.strictEqual(red?.renewedOnce, true);
        assert.strictEqual(red?.threadId, null);
        assert.strictEqual(missing?.status, "checks");
        assert.strictEqual(missing?.detail, "没有检查");
        assert.strictEqual(missing?.stuckReason, null);
        assert.strictEqual(unread?.status, "checks");
        assert.strictEqual(unread?.detail, "没查成");
        assert.strictEqual(unread?.stuckReason, null);
        const shas = yield* Ref.get(reads);
        assert.strictEqual(count(shas, SUCCESS), 1);
        assert.strictEqual(count(shas, RED), 1);
        assert.strictEqual(count(shas, MISSING), 2);
        assert.strictEqual(count(shas, UNREAD), 2);
        assert.strictEqual((yield* Ref.get(opened)).length, 0);
      }).pipe(
        Effect.provide(
          tickLayer({
            issues: [issue(1), issue(2), issue(3), issue(4)],
            opened,
            reads,
            read,
          }),
        ),
      );
    }),
  );

  it.effect("CI 已绿的检查进入待验，作者线程和用量还在", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<PullRequestDraft>>([]);
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      const read = (entry: { readonly headSha: string }) =>
        Ref.update(reads, (shas) => [...shas, entry.headSha]).pipe(
          Effect.as({ kind: "success" as const }),
        );
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const opening = yield* OpenPullRequest;
        yield* runs.tick;
        yield* runs.note(6, {
          status: "checks",
          prNumber: 32,
          headSha: SHA,
          threadId: "author-thread",
          sessionStartedAt: "2026-01-01T00:10:00.000Z",
          sessionEndedAt: "2026-01-01T00:20:00.000Z",
          detail: "CI 已绿、未验",
        });
        yield* opening.tick;
        const run = (yield* runs.list).runs.find((item) => item.issueNumber === 6);
        assert.strictEqual(run?.status, "verify");
        assert.strictEqual(run?.detail, "CI 已绿、未验");
        assert.strictEqual(run?.stuckReason, null);
        assert.strictEqual(run?.threadId, "author-thread");
        assert.strictEqual(run?.headSha, SHA);
        assert.strictEqual(run?.prNumber, 32);
        assert.strictEqual(run?.modelAccount, "author");
        assert.strictEqual(run?.inputTokens, 40);
        assert.strictEqual(run?.outputTokens, 2);
        assert.strictEqual(run?.usageNote, null);
        yield* opening.tick;
        const again = (yield* runs.list).runs.find((item) => item.issueNumber === 6);
        assert.strictEqual(again?.status, "verify");
        assert.strictEqual(again?.threadId, "author-thread");
        assert.strictEqual(again?.inputTokens, 40);
        assert.strictEqual(count(yield* Ref.get(reads), SHA), 1);
      }).pipe(
        Effect.provide(
          tickLayer({
            issues: [issue(6)],
            opened,
            reads,
            read,
            usage: Effect.succeed([
              {
                at: "2026-01-01T00:15:00.000Z",
                account: "author",
                inputTokens: 40,
                outputTokens: 2,
                cacheTokens: 0,
                convertedCost: 1,
              },
            ]),
          }),
        ),
      );
    }),
  );

  it.effect("读不到用量不开放行，也不标超预算", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<PullRequestDraft>>([]);
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const opening = yield* OpenPullRequest;
        yield* runs.tick;
        yield* runs.note(6, {
          status: "session",
          threadId: "thread-6",
          sessionStartedAt: ENDED_AT,
          sessionEndedAt: ENDED_AT,
          headSha: SHA,
        });
        yield* opening.tick;
        const run = (yield* runs.list).runs.find((item) => item.issueNumber === 6);
        assert.strictEqual(run?.status, "session");
        assert.strictEqual(run?.stuckReason, null);
        assert.strictEqual(run?.detail, "没查成");
        assert.strictEqual(run?.prNumber, null);
        assert.strictEqual(run?.usageNote, "读不到");
        assert.strictEqual((yield* Ref.get(opened)).length, 0);
      }).pipe(
        Effect.provide(
          tickLayer({
            issues: [issue(6)],
            opened,
            reads,
            usage: Effect.fail(new PipelineUsageUnreadable()),
            worktrees: [{ threadId: "thread-6", worktreePath: "/wt/6" }],
          }),
        ),
      );
    }),
  );

  it.effect("does nothing while the pipeline switch is off", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<ReadonlyArray<PullRequestDraft>>([]);
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* PipelineRuns;
        const opening = yield* OpenPullRequest;
        yield* sql`
          INSERT INTO pipeline_runs (
            repository,
            issue_number,
            title,
            status,
            thread_id,
            head_sha,
            session_ended_at,
            updated_at
          )
          VALUES (
            'thoerwink8/fleet-ade',
            6,
            'fix tests',
            'session',
            'thread-6',
            ${SHA},
            ${ENDED_AT},
            ${ENDED_AT}
          )
        `;
        yield* opening.tick;
        const run = (yield* runs.list).runs.find((item) => item.issueNumber === 6);
        assert.strictEqual(run?.status, "session");
        assert.strictEqual(run?.prNumber, null);
        assert.strictEqual((yield* Ref.get(opened)).length, 0);
        assert.strictEqual((yield* Ref.get(reads)).length, 0);
      }).pipe(
        Effect.provide(
          tickLayer({
            enabled: false,
            issues: [],
            opened,
            reads,
            worktrees: [{ threadId: "thread-6", worktreePath: "/wt/6" }],
          }),
        ),
      );
    }),
  );
});

const changeRequest = (number: number, headSha: string): ChangeRequest =>
  ({
    provider: "github",
    number,
    title: "fix tests",
    url: "pull/" + number,
    baseRefName: "main",
    headRefName: BRANCH,
    headSha,
    state: "open",
    updatedAt: Option.none(),
  }) as ChangeRequest;

const claimKey = { repo: "acme/widgets", issue: 6, taskId: "root" };
const openerLayer = (input: {
  readonly listed: Effect.Effect<ReadonlyArray<ChangeRequest>>;
  readonly onCreate: (bodyFile: string) => Effect.Effect<void>;
  readonly actions: Ref.Ref<ReadonlyArray<string>>;
  readonly created: Ref.Ref<ReadonlyArray<string>>;
  readonly pushed?: GitRunStackedActionResult;
  readonly subjects?: string;
  readonly lsRemote?: string;
  readonly ancestor?: number;
  readonly execute?: (entry: { readonly args: ReadonlyArray<string> }) => Effect.Effect<{
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
  }>;
  readonly pushTarget?: { readonly remoteName: string; readonly branchName: string } | null;
  readonly calls?: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>;
}) =>
  layerOpener.pipe(
    Layer.provide(
      Layer.succeed(GitWorkflowService.GitWorkflowService, {
        runStackedAction: (action: { readonly action: string }) =>
          Ref.update(input.actions, (items) => [...items, action.action]).pipe(
            Effect.as(
              input.pushed ??
                ({ action: "push", push: { status: "pushed" } } as GitRunStackedActionResult),
            ),
          ),
      } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(GitVcsDriver.GitVcsDriver, {
        resolvePushTarget: (
          _cwd: string,
          current: { readonly branch: string; readonly hasUpstream: boolean },
        ) =>
          Effect.succeed(
            input.pushTarget === undefined
              ? { remoteName: "origin", branchName: current.branch }
              : input.pushTarget,
          ),
        execute:
          input.execute ??
          ((entry: { readonly args: ReadonlyArray<string> }) => {
            const args = entry.args;
            const record =
              input.calls === undefined
                ? Effect.void
                : Ref.update(input.calls, (items) => [...items, args]);
            const respond = (result: {
              readonly exitCode: number | null;
              readonly stdout: string;
            }) =>
              record.pipe(
                Effect.as({
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stderr: "",
                  ...result,
                }),
              );
            if (args[0] === "ls-remote") {
              return respond({ exitCode: 0, stdout: input.lsRemote ?? "" });
            }
            if (args[0] === "merge-base") {
              return respond({ exitCode: input.ancestor ?? 0, stdout: "" });
            }
            if (args[0] === "rev-parse") {
              return respond({ exitCode: 0, stdout: `origin/${BRANCH}` });
            }
            if (args[0] === "config") {
              return respond({ exitCode: 1, stdout: "" });
            }
            return respond({ exitCode: 0, stdout: input.subjects ?? "" });
          }),
      } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
    ),
    Layer.provide(
      Layer.succeed(SourceControlProviderRegistry.SourceControlProviderRegistry, {
        resolve: () =>
          Effect.succeed({
            listChangeRequests: () => input.listed,
            createChangeRequest: (entry: {
              readonly bodyFile: string;
              readonly baseRefName: string;
              readonly headSelector: string;
            }) =>
              input
                .onCreate(entry.bodyFile)
                .pipe(
                  Effect.flatMap(() =>
                    Ref.update(input.created, (items) => [
                      ...items,
                      entry.baseRefName + " " + entry.headSelector,
                    ]),
                  ),
                ),
          } as unknown as SourceControlProvider.SourceControlProvider["Service"]),
      } as unknown as SourceControlProviderRegistry.SourceControlProviderRegistry["Service"]),
    ),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  );

describe("PullRequestOpener", () => {
  it.effect("pushes the branch and creates one pull request from the body file", () =>
    Effect.gen(function* () {
      const actions = yield* Ref.make<ReadonlyArray<string>>([]);
      const created = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const opener = yield* PullRequestOpener;
        const opened = yield* opener.open({
          cwd: "/wt/6",
          branch: BRANCH,
          title: "fix tests",
          issueBody: issue(6).body,
          headSha: SHA,
          claimKey,
        });
        assert.strictEqual(opened.number, 21);
        assert.strictEqual(opened.headSha, SHA);
        assert.deepStrictEqual(yield* Ref.get(actions), ["push"]);
        assert.deepStrictEqual(yield* Ref.get(created), ["main " + BRANCH]);
      }).pipe(
        Effect.provide(
          openerLayer({
            actions,
            created,
            listed: Ref.get(created).pipe(
              Effect.map((items) => (items.length === 0 ? [] : [changeRequest(21, SHA)])),
            ),
            onCreate: (bodyFile) =>
              Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const body = yield* fs.readFileString(bodyFile).pipe(Effect.orDie);
                assert.strictEqual(
                  body,
                  pullRequestBody({ changes: acceptanceItems(issue(6).body), verification: [] }),
                );
              }).pipe(Effect.provide(NodeFileSystem.layer)),
          }),
        ),
      );
    }),
  );

  it.effect("reuses an open pull request for the branch", () =>
    Effect.gen(function* () {
      const actions = yield* Ref.make<ReadonlyArray<string>>([]);
      const created = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const opener = yield* PullRequestOpener;
        const draft = {
          cwd: "/wt/6",
          branch: BRANCH,
          title: "fix tests",
          issueBody: issue(6).body,
          headSha: SHA,
          claimKey,
        };
        const first = yield* opener.open(draft);
        const second = yield* opener.open(draft);
        assert.strictEqual(first.number, 21);
        assert.strictEqual(second.number, first.number);
        assert.deepStrictEqual(yield* Ref.get(created), []);
      }).pipe(
        Effect.provide(
          openerLayer({
            actions,
            created,
            listed: Effect.succeed([changeRequest(21, SHA)]),
            onCreate: () => Effect.die("should not create"),
          }),
        ),
      );
    }),
  );

  it.effect("refuses the push when the remote branch is not an ancestor", () =>
    Effect.gen(function* () {
      const actions = yield* Ref.make<ReadonlyArray<string>>([]);
      const created = yield* Ref.make<ReadonlyArray<string>>([]);
      const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      yield* Effect.gen(function* () {
        const opener = yield* PullRequestOpener;
        const error = yield* opener
          .open({
            cwd: "/wt/6",
            branch: BRANCH,
            title: "fix tests",
            issueBody: issue(6).body,
            headSha: SHA,
            claimKey,
          })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "PullRequestOpenError");
        assert.match(error.detail, /fast-forward/i);
        assert.deepStrictEqual(yield* Ref.get(actions), []);
        assert.deepStrictEqual(yield* Ref.get(created), []);
        const mergeBase = (yield* Ref.get(calls)).find((args) => args[0] === "merge-base");
        assert.deepStrictEqual(mergeBase, [
          "merge-base",
          "--is-ancestor",
          "dddddddddddddddddddddddddddddddddddddddd",
          "HEAD",
        ]);
      }).pipe(
        Effect.provide(
          openerLayer({
            actions,
            created,
            calls,
            lsRemote: `dddddddddddddddddddddddddddddddddddddddd\trefs/heads/${BRANCH}\n`,
            ancestor: 1,
            listed: Effect.succeed([changeRequest(21, SHA)]),
            onCreate: () => Effect.die("should not create"),
          }),
        ),
      );
    }),
  );

  it.effect("checks the push target the push resolution reports, not branch config", () =>
    Effect.gen(function* () {
      const actions = yield* Ref.make<ReadonlyArray<string>>([]);
      const created = yield* Ref.make<ReadonlyArray<string>>([]);
      const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      yield* Effect.gen(function* () {
        const opener = yield* PullRequestOpener;
        const error = yield* opener
          .open({
            cwd: "/wt/6",
            branch: BRANCH,
            title: "fix tests",
            issueBody: issue(6).body,
            headSha: SHA,
            claimKey,
          })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "PullRequestOpenError");
        const lsRemote = (yield* Ref.get(calls)).find((args) => args[0] === "ls-remote");
        assert.deepStrictEqual(lsRemote, ["ls-remote", "upstream", `refs/heads/${BRANCH}`]);
      }).pipe(
        Effect.provide(
          openerLayer({
            actions,
            created,
            calls,
            pushTarget: { remoteName: "upstream", branchName: BRANCH },
            lsRemote: `dddddddddddddddddddddddddddddddddddddddd\trefs/heads/${BRANCH}\n`,
            ancestor: 1,
            listed: Effect.succeed([changeRequest(21, SHA)]),
            onCreate: () => Effect.die("should not create"),
          }),
        ),
      );
    }),
  );

  it.effect("pushes when the remote head is an ancestor of the local head", () =>
    Effect.gen(function* () {
      const actions = yield* Ref.make<ReadonlyArray<string>>([]);
      const created = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const opener = yield* PullRequestOpener;
        const opened = yield* opener.open({
          cwd: "/wt/6",
          branch: BRANCH,
          title: "fix tests",
          issueBody: issue(6).body,
          headSha: SHA,
          claimKey,
        });
        assert.strictEqual(opened.number, 21);
        assert.deepStrictEqual(yield* Ref.get(actions), ["push"]);
      }).pipe(
        Effect.provide(
          openerLayer({
            actions,
            created,
            lsRemote: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/${BRANCH}\n`,
            ancestor: 0,
            listed: Effect.succeed([changeRequest(21, SHA)]),
            onCreate: () => Effect.die("should not create"),
          }),
        ),
      );
    }),
  );

  it.effect("does not create a pull request when the push did not land", () =>
    Effect.gen(function* () {
      const actions = yield* Ref.make<ReadonlyArray<string>>([]);
      const created = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const opener = yield* PullRequestOpener;
        const error = yield* opener
          .open({
            cwd: "/wt/6",
            branch: BRANCH,
            title: "fix tests",
            issueBody: issue(6).body,
            headSha: SHA,
            claimKey,
          })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "PullRequestOpenError");
        assert.deepStrictEqual(yield* Ref.get(created), []);
      }).pipe(
        Effect.provide(
          openerLayer({
            actions,
            created,
            listed: Effect.succeed([]),
            onCreate: () => Effect.die("should not create"),
            pushed: {
              action: "push",
              push: { status: "skipped_not_requested" },
            } as GitRunStackedActionResult,
          }),
        ),
      );
    }),
  );
  it.effect("writes the issue changes and recorded checks, not who opened it", () =>
    Effect.gen(function* () {
      const actions = yield* Ref.make<ReadonlyArray<string>>([]);
      const created = yield* Ref.make<ReadonlyArray<string>>([]);
      const issueBody = [
        "## 怎么算做完",
        "- README 标题改成一行",
        "## 别的",
        "- 流水线开的",
        "",
      ].join("\n");
      const subjects = [
        "fix(readme): retitle\nvp test run apps/server/src/pipeline/OpenPullRequest.test.ts\u0000",
        "流水线开的\u0000",
      ].join("");
      yield* Effect.gen(function* () {
        const opener = yield* PullRequestOpener;
        yield* opener.open({
          cwd: "/wt/6",
          branch: BRANCH,
          title: "fix tests",
          issueBody,
          headSha: SHA,
          claimKey,
        });
      }).pipe(
        Effect.provide(
          openerLayer({
            actions,
            created,
            subjects,
            listed: Ref.get(created).pipe(
              Effect.map((items) => (items.length === 0 ? [] : [changeRequest(21, SHA)])),
            ),
            onCreate: (bodyFile) =>
              Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const body = yield* fs.readFileString(bodyFile).pipe(Effect.orDie);
                assert.strictEqual(
                  body,
                  pullRequestBody({
                    changes: acceptanceItems(issueBody),
                    verification: recordedChecks(subjects.split("\u0000")),
                  }),
                );
                assert.strictEqual(body.includes("流水线开的"), false);
                assert.strictEqual(body.includes("README 标题改成一行"), true);
                assert.strictEqual(
                  body.includes("vp test run apps/server/src/pipeline/OpenPullRequest.test.ts"),
                  true,
                );
              }).pipe(Effect.provide(NodeFileSystem.layer)),
          }),
        ),
      );
    }),
  );
});

describe("CiCheckReader", () => {
  const restLayer = (
    respond: (path: string) => { readonly status: number; readonly body: string },
  ) =>
    Layer.succeed(GitHubRest.GitHubRest, {
      rest: (entry: { readonly path: string }) =>
        Effect.sync(() => {
          const page = respond(entry.path);
          return { status: page.status, body: page.body, truncated: false };
        }),
      graphql: () => Effect.die("graphql is unused"),
    } as unknown as GitHubRest.GitHubRest["Service"]);

  const runs = (rows: ReadonlyArray<Record<string, unknown>>, total = rows.length) =>
    JSON.stringify({ total_count: total, workflow_runs: rows });

  it.effect("treats only the workflow named CI as the check", () =>
    Effect.gen(function* () {
      const reader = yield* CiCheckReader;
      assert.deepStrictEqual(yield* reader.read({ headSha: SHA, repository: "acme/widgets" }), {
        kind: "success",
      });
      assert.deepStrictEqual(
        yield* reader.read({ headSha: "pending", repository: "acme/widgets" }),
        { kind: "pending" },
      );
      assert.deepStrictEqual(
        yield* reader.read({ headSha: "missing", repository: "acme/widgets" }),
        { kind: "missing" },
      );
      assert.deepStrictEqual(yield* reader.read({ headSha: "red", repository: "acme/widgets" }), {
        kind: "failure",
      });
    }).pipe(
      Effect.provide(
        layerReader.pipe(
          Layer.provide(
            restLayer((path) => {
              assert.ok(path.startsWith("repos/acme/widgets/actions/runs?"));
              if (path.includes("head_sha=" + SHA)) {
                return {
                  status: 200,
                  body: runs([
                    { id: 1, name: "lint", status: "completed", conclusion: "success" },
                    { id: 2, name: "CI", status: "completed", conclusion: "failure" },
                    { id: 8, name: "CI", status: "completed", conclusion: "success" },
                  ]),
                };
              }
              if (path.includes("head_sha=pending")) {
                return {
                  status: 200,
                  body: runs([{ id: 3, name: "CI", status: "in_progress", conclusion: null }]),
                };
              }
              if (path.includes("head_sha=red")) {
                return {
                  status: 200,
                  body: runs([{ id: 5, name: "CI", status: "completed", conclusion: "failure" }]),
                };
              }
              return {
                status: 200,
                body: runs([{ id: 6, name: "lint", status: "completed", conclusion: "success" }]),
              };
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("does not treat a cut-off page or a failed read as a missing check", () =>
    Effect.gen(function* () {
      const reader = yield* CiCheckReader;
      const cutOff = yield* reader
        .read({ headSha: "cutoff", repository: "thoerwink8/fleet-ade" })
        .pipe(Effect.exit);
      const failed = yield* reader
        .read({ headSha: "down", repository: "thoerwink8/fleet-ade" })
        .pipe(Effect.exit);
      assert.strictEqual(cutOff._tag, "Failure");
      assert.strictEqual(failed._tag, "Failure");
    }).pipe(
      Effect.provide(
        layerReader.pipe(
          Layer.provide(
            restLayer((path) => {
              if (path.includes("head_sha=down")) return { status: 500, body: "" };
              return {
                status: 200,
                body: runs(
                  Array.from({ length: 100 }, (_, index) => ({
                    id: index + 1,
                    name: "lint",
                    status: "completed",
                    conclusion: "success",
                  })),
                  140,
                ),
              };
            }),
          ),
        ),
      ),
    ),
  );
});
