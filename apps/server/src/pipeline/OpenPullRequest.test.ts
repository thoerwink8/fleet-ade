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
  layer,
  layerOpener,
  layerReader,
  pullRequestBody,
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
});

const tickLayer = (input: {
  readonly enabled?: boolean;
  readonly issues: ReadonlyArray<PipelineIssue>;
  readonly opened: Ref.Ref<ReadonlyArray<PullRequestDraft>>;
  readonly reads: Ref.Ref<ReadonlyArray<string>>;
  readonly open?: PullRequestOpener["Service"]["open"];
  readonly read?: CiCheckReader["Service"]["read"];
  readonly additions?: PullRequestAdditions["Service"]["read"];
  readonly usage?: Effect.Effect<ReadonlyArray<UsageRecord>, PipelineUsageUnreadable>;
  readonly worktrees?: ReadonlyArray<{ readonly threadId: string; readonly worktreePath: string }>;
}) => {
  const settings = ServerSettings.layerTest({ pipelineEnabled: input.enabled ?? true });
  const runs = runsLayer.pipe(
    Layer.provide(
      Layer.succeed(PipelineGitHubIssues, {
        listEligible: () => Effect.succeed(input.issues),
        read: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(Layer.succeed(PipelineUsage, { read: () => input.usage ?? Effect.succeed([]) })),
    Layer.provide(settings),
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
    Layer.provideMerge(runs),
  );
};

const count = (shas: ReadonlyArray<string>, sha: string) =>
  shas.filter((item) => item === sha).length;

describe("OpenPullRequest", () => {
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
        assert.strictEqual(drafts[0]?.body, pullRequestBody(6, "fix tests"));
        assert.strictEqual(drafts[0]?.body.includes("Closes"), false);
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

const openerLayer = (input: {
  readonly listed: Effect.Effect<ReadonlyArray<ChangeRequest>>;
  readonly onCreate: (bodyFile: string) => Effect.Effect<void>;
  readonly actions: Ref.Ref<ReadonlyArray<string>>;
  readonly created: Ref.Ref<ReadonlyArray<string>>;
  readonly pushed?: GitRunStackedActionResult;
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
          body: pullRequestBody(6, "fix tests"),
          headSha: SHA,
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
                assert.strictEqual(body, pullRequestBody(6, "fix tests"));
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
        const opened = yield* opener.open({
          cwd: "/wt/6",
          branch: BRANCH,
          title: "fix tests",
          body: pullRequestBody(6, "fix tests"),
          headSha: SHA,
        });
        assert.strictEqual(opened.number, 21);
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
            body: pullRequestBody(6, "fix tests"),
            headSha: SHA,
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
      assert.deepStrictEqual(yield* reader.read({ headSha: SHA }), { kind: "success" });
      assert.deepStrictEqual(yield* reader.read({ headSha: "pending" }), { kind: "pending" });
      assert.deepStrictEqual(yield* reader.read({ headSha: "missing" }), { kind: "missing" });
      assert.deepStrictEqual(yield* reader.read({ headSha: "red" }), { kind: "failure" });
    }).pipe(
      Effect.provide(
        layerReader.pipe(
          Layer.provide(
            restLayer((path) => {
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
      const cutOff = yield* reader.read({ headSha: "cutoff" }).pipe(Effect.exit);
      const failed = yield* reader.read({ headSha: "down" }).pipe(Effect.exit);
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
