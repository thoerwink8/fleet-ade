import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type Project,
  type VcsCreateWorktreeInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as MigrationError from "effect/sql/Migrator";
import * as SqlError from "effect/sql/SqlError";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PullRequestAdditions, layer as budgetLayer } from "./budget.ts";
import * as DispatchSession from "./DispatchSession.ts";
import { PipelineGitHubIssues, type PipelineIssue } from "./GitHubIssues.ts";
import * as ClaimLease from "./claimLease.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
import { layerPortsDefault } from "./intakeGates.ts";
import { SessionEndInbox, layer as inboxLayer, type SessionEndStatus } from "./SessionEndInbox.ts";
import { EnvironmentId } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as FleetClaims from "../ledger/FleetClaims.ts";
import * as FleetSummaryReporter from "../ledger/FleetSummaryReporter.ts";
import * as CoordinatorTerm from "../ledger/coordinatorTerm.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

const MODEL: ModelSelection = { instanceId: ProviderInstanceId.make("test-model"), model: "test" };
const NOW = "2026-11-16T00:00:00.000Z";
const ENDED_AT = "1970-01-01T01:00:00.000Z";
const acceptance = `## 怎么算做完
- 跑通测试
`;

const PROJECT: Project = {
  id: ProjectId.make("project:pipeline"),
  title: "fleet-ade",
  workspaceRoot: "/repo",
  repositoryIdentity: {
    canonicalKey: "github.com/thoerwink8/fleet-ade",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/thoerwink8/fleet-ade.git",
    },
    owner: "thoerwink8",
    name: "fleet-ade",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const issue = (number: number, title = "fix tests"): PipelineIssue => ({
  number,
  title,
  body: `单 ${number}\n${acceptance}`,
  labels: ["交给 ADE"],
  author: { login: "thoerwink8", id: 1, type: "User" },
});

interface PipelinePatch {
  readonly pipelineEnabled: boolean;
  readonly pipelineAuthorModel: ReadonlyArray<ModelSelection>;
  readonly pipelineSessionTimeoutMinutes?: number;
}

interface FakeGit {
  readonly branches: Set<string>;
  /** branch → checkout; prunable means the directory is gone but the registration remains. */
  readonly checkouts: Map<string, { readonly path: string; readonly prunable: boolean }>;
}

class FakeWorktreeError extends Schema.TaggedError<FakeWorktreeError>()("FakeWorktreeError", {
  detail: Schema.String,
}) {}

interface Handles {
  readonly opened: Ref.Ref<ReadonlyArray<DispatchSession.DispatchedSession>>;
  readonly created: Ref.Ref<ReadonlyArray<string>>;
  readonly visible: Ref.Ref<ReadonlyArray<PipelineIssue>>;
  readonly git: FakeGit;
}

const sessionLayer = (
  patch: PipelinePatch,
  visible: Ref.Ref<ReadonlyArray<PipelineIssue>>,
  opened: Ref.Ref<ReadonlyArray<DispatchSession.DispatchedSession>>,
  created: Ref.Ref<ReadonlyArray<string>>,
  fake: FakeGit,
  options?: {
    readonly claims?: Layer.Layer<
      ClaimLease.ClaimLeasePort | CoordinatorTerm.CoordinatorTerm | FleetClaims.FleetClaims,
      | CoordinatorTerm.CoordinatorTermStorageError
      | MigrationError.MigrationError
      | SqlError.SqlError,
      SqlClient.SqlClient
    >;
    readonly reporter?: Layer.Layer<FleetSummaryReporter.FleetSummaryReporter>;
  },
) => {
  const memory = SqlitePersistence.layerMemory;
  const issues = Layer.succeed(
    PipelineGitHubIssues,
    PipelineGitHubIssues.of({
      addLabel: () => Effect.die("unexpected label write"),
      listEligible: () => Ref.get(visible),
      read: (number) =>
        Ref.get(visible).pipe(
          Effect.flatMap((listed) => {
            const found = listed.find((candidate) => candidate.number === number);
            return found === undefined
              ? Effect.die(`missing issue ${number}`)
              : Effect.succeed(found);
          }),
        ),
    }),
  );
  const usage = Layer.succeed(
    PipelineUsage,
    PipelineUsage.of({
      read: () => Effect.succeed([]),
    }),
  );
  const settings = ServerSettings.layerTest(patch);
  const opener = Layer.succeed(
    DispatchSession.SessionOpener,
    DispatchSession.SessionOpener.of({
      open: (session) => Ref.update(opened, (current) => [...current, session]),
    }),
  );
  const git = Layer.succeed(GitWorkflowService.GitWorkflowService, {
    fetchWorktreeBaseCommit: () =>
      Effect.succeed({ commitSha: "base", remoteRefName: "origin/main" }),
    createWorktree: (input: VcsCreateWorktreeInput) => {
      const branch = input.newRefName ?? input.refName;
      const path = `/worktrees/${branch}`;
      if (input.newRefName !== undefined && fake.branches.has(input.newRefName)) {
        return Effect.fail(
          new FakeWorktreeError({
            detail: `fatal: a branch named '${input.newRefName}' already exists`,
          }),
        );
      }
      const checkedOut = fake.checkouts.get(branch);
      if (checkedOut !== undefined) {
        return Effect.fail(
          new FakeWorktreeError({
            detail: `fatal: '${branch}' is already used by worktree at '${checkedOut.path}'`,
          }),
        );
      }
      fake.branches.add(branch);
      fake.checkouts.set(branch, { path, prunable: false });
      return Ref.update(created, (current) => [...current, branch]).pipe(
        Effect.as({ worktree: { path, refName: branch } }),
      );
    },
    listLocalBranchNames: () => Effect.succeed([...fake.branches]),
  } as unknown as GitWorkflowService.GitWorkflowService["Service"]);
  const vcs = Layer.succeed(GitVcsDriver.GitVcsDriver, {
    execute: (entry: { readonly args: ReadonlyArray<string> }) => {
      const args = entry.args;
      if (args[0] === "worktree" && args[1] === "list") {
        const records = [...fake.checkouts.entries()]
          .map(
            ([branch, checkout]) =>
              `worktree ${checkout.path}\0head 0000000000000000000000000000000000000000\0branch refs/heads/${branch}\0` +
              (checkout.prunable ? "prunable gitdir file points to non-existent location\0" : ""),
          )
          .join("\0");
        return Effect.succeed({
          exitCode: 0,
          stdout: `${records}\0`,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        const target = args[args.length - 1];
        for (const [branch, checkout] of fake.checkouts) {
          if (checkout.path === target) fake.checkouts.delete(branch);
        }
        return Effect.succeed({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      }
      return Effect.succeed({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
  } as unknown as GitVcsDriver.GitVcsDriver["Service"]);
  const projects = Layer.succeed(ProjectService.ProjectService, {
    listPage: () => Effect.succeed({ projects: [PROJECT], nextCursor: null }),
  } as unknown as ProjectService.ProjectService["Service"]);
  const shared = Layer.mergeAll(runsLayer, inboxLayer).pipe(
    Layer.provide(issues),
    Layer.provide(usage),
    Layer.provide(settings),
    Layer.provide(layerPortsDefault),
    Layer.provide(options?.claims ?? ClaimLease.layerPort()),
    Layer.provideMerge(memory),
  );
  const base = DispatchSession.layer.pipe(
    Layer.provide(budgetLayer),
    Layer.provide(
      Layer.succeed(PullRequestAdditions, {
        read: () => Effect.succeed(0),
      }),
    ),
    Layer.provide(opener),
    Layer.provide(git),
    Layer.provide(vcs),
    Layer.provide(projects),
    Layer.provide(issues),
    Layer.provideMerge(settings),
    Layer.provideMerge(shared),
  );
  return base.pipe(
    Layer.provide(options?.reporter ?? Layer.mock(FleetSummaryReporter.FleetSummaryReporter)({})),
  );
};

const run = <E, R>(
  patch: PipelinePatch,
  issues: ReadonlyArray<PipelineIssue>,
  body: (handles: Handles) => Effect.Effect<void, E, R>,
  options?: Parameters<typeof sessionLayer>[5],
) =>
  Effect.gen(function* () {
    const opened = yield* Ref.make<ReadonlyArray<DispatchSession.DispatchedSession>>([]);
    const created = yield* Ref.make<ReadonlyArray<string>>([]);
    const visible = yield* Ref.make(issues);
    const git: FakeGit = { branches: new Set(), checkouts: new Map() };
    yield* body({ opened, created, visible, git }).pipe(
      Effect.provide(sessionLayer(patch, visible, opened, created, git, options)),
    );
  });

const enabled = {
  pipelineEnabled: true,
  pipelineAuthorModel: [MODEL],
} as const;

const openClaimed = Effect.gen(function* () {
  const runs = yield* PipelineRuns;
  yield* runs.tick;
  yield* (yield* DispatchSession.DispatchSession).tick;
  const run = (yield* runs.list).runs.find((item) => item.status === "session");
  if (run === undefined || run.threadId === null) {
    return yield* Effect.die("expected one open session");
  }
  return run;
});

const recordEnd = (
  threadId: string,
  status: SessionEndStatus,
  headLookup: "found" | "unavailable",
  headSha?: string,
) =>
  Effect.gen(function* () {
    yield* (yield* SessionEndInbox).record({
      threadId: ThreadId.make(threadId),
      runId: RunId.make(`${status}:${threadId}`),
      status,
      endedAt: ENDED_AT,
      headLookup,
      ...(headSha === undefined ? {} : { headSha }),
    });
    yield* (yield* DispatchSession.DispatchSession).tick;
  });

describe("fleet lease binding", () => {
  it.effect("领取机群租约的运行派发后向自身摘要登记为任务行", () => {
    const tracked = {
      value: [] as Array<{
        threadId: string;
        claim: Parameters<FleetSummaryReporter.FleetSummaryReporter["Service"]["trackTask"]>[1];
      }>,
    };
    const claimsLayer = ClaimLease.fleetPortLayer.pipe(
      Layer.provideMerge(FleetClaims.layerShared),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("pipeline-env")),
        }),
      ),
    );
    const reporterLayer = Layer.succeed(FleetSummaryReporter.FleetSummaryReporter, {
      trackTask: (
        threadId: ThreadId,
        claim: Parameters<FleetSummaryReporter.FleetSummaryReporter["Service"]["trackTask"]>[1],
      ) => Effect.sync(() => tracked.value.push({ threadId, claim })),
      trackAdhoc: () => Effect.void,
      untrack: () => Effect.void,
      handle: () => Effect.void,
      start: () => Effect.void,
    });
    return run(
      enabled,
      [issue(7)],
      () =>
        Effect.gen(function* () {
          const opened = yield* openClaimed;
          const bindings = tracked.value;
          assert.strictEqual(bindings.length, 1);
          assert.strictEqual(bindings[0]?.threadId, opened.threadId);
          assert.strictEqual(bindings[0]?.claim.repo, "thoerwink8/fleet-ade");
          assert.strictEqual(bindings[0]?.claim.attempt, 1);
        }),
      { claims: claimsLayer, reporter: reporterLayer },
    );
  });
});

describe("DispatchSession", () => {
  it.effect("移出允许列表后仍接收已运行会话的结束事件，不派发新认领", () =>
    run(enabled, [issue(7), issue(8)], ({ opened }) =>
      Effect.gen(function* () {
        const active = yield* openClaimed;
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({ pipelineRepos: [] });
        if (active.threadId === null) return yield* Effect.die("expected a thread");
        yield* recordEnd(active.threadId, "completed", "found", "completed-head");
        const persisted = (yield* (yield* PipelineRuns).list).runs;
        assert.equal(persisted.find((item) => item.id === active.id)?.sessionEndedAt, ENDED_AT);
        assert.equal(persisted.find((item) => item.id === active.id)?.headSha, "completed-head");
        assert.equal(persisted.find((item) => item.id !== active.id)?.status, "claimed");
        assert.equal((yield* Ref.get(opened)).length, 1);
      }),
    ),
  );

  it.effect("开关关着不建树不开会话", () =>
    run(
      { pipelineEnabled: false, pipelineAuthorModel: [MODEL] },
      [issue(5)],
      ({ opened, created }) =>
        Effect.gen(function* () {
          yield* (yield* PipelineRuns).tick;
          yield* (yield* DispatchSession.DispatchSession).tick;
          assert.deepEqual(yield* Ref.get(opened), []);
          assert.deepEqual(yield* Ref.get(created), []);
          assert.strictEqual((yield* (yield* PipelineRuns).list).runs.length, 0);
        }),
    ),
  );

  it.effect("开关关着只派发可信受监督运行", () =>
    run(
      { pipelineEnabled: false, pipelineAuthorModel: [MODEL] },
      [issue(5)],
      ({ opened, created }) =>
        Effect.gen(function* () {
          const runs = yield* PipelineRuns;
          const started = yield* runs.startSupervised({
            issueNumber: 5,
            repository: "thoerwink8/fleet-ade",
            controllerThreadId: "thread:controller",
          });
          assert.strictEqual(started.status, "started");
          yield* (yield* DispatchSession.DispatchSession).tick;
          assert.strictEqual((yield* Ref.get(opened)).length, 1);
          assert.strictEqual((yield* Ref.get(created)).length, 1);
          const dispatched = (yield* runs.list).runs[0];
          assert.strictEqual(dispatched?.status, "session");
          assert.strictEqual(dispatched?.controllerThreadId, "thread:controller");
        }),
    ),
  );

  it.effect("开关关闭后不派发既有普通认领", () =>
    run(enabled, [issue(5)], ({ opened, created }) =>
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        yield* runs.tick;
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          pipelineEnabled: false,
        });
        yield* (yield* DispatchSession.DispatchSession).tick;
        assert.deepEqual(yield* Ref.get(opened), []);
        assert.deepEqual(yield* Ref.get(created), []);
        assert.strictEqual((yield* runs.list).runs[0]?.status, "claimed");
        assert.strictEqual((yield* runs.list).runs[0]?.controllerThreadId, null);
      }),
    ),
  );

  it.effect("没配模型卡住且没有树", () =>
    run({ pipelineEnabled: true, pipelineAuthorModel: [] }, [issue(5)], ({ created }) =>
      Effect.gen(function* () {
        yield* (yield* PipelineRuns).tick;
        yield* (yield* DispatchSession.DispatchSession).tick;
        const listed = (yield* (yield* PipelineRuns).list).runs;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.status, "stuck");
        assert.strictEqual(listed[0]?.stuckReason, "没配模型");
        assert.strictEqual(listed[0]?.threadId, null);
        assert.deepEqual(yield* Ref.get(created), []);
      }),
    ),
  );

  it.effect("一条认领只开一个会话再 tick 不开第二个", () =>
    run(enabled, [issue(5)], ({ opened, created }) =>
      Effect.gen(function* () {
        const first = yield* openClaimed;
        const branch = DispatchSession.sessionBranch(5, "fix tests");
        assert.deepEqual(yield* Ref.get(created), [branch]);
        const sessions = yield* Ref.get(opened);
        assert.strictEqual(sessions.length, 1);
        assert.strictEqual(sessions[0]?.threadId, first.threadId);
        assert.strictEqual(sessions[0]?.branch, branch);
        assert.strictEqual(sessions[0]?.worktreePath, `/worktrees/${branch}`);
        assert.deepEqual(sessions[0]?.modelSelection, MODEL);
        assert.strictEqual(sessions[0]?.text, issue(5).body);
        assert.strictEqual(first.threadId, `pipeline:5:${first.id}`);
        assert.strictEqual(first.prNumber, null);
        yield* (yield* DispatchSession.DispatchSession).tick;
        assert.strictEqual((yield* Ref.get(created)).length, 1);
        assert.strictEqual((yield* Ref.get(opened)).length, 1);
        assert.strictEqual((yield* (yield* PipelineRuns).list).runs.length, 1);
      }),
    ),
  );

  it.effect("完成且有 head 留在会话做完", () =>
    run(enabled, [issue(5)], () =>
      Effect.gen(function* () {
        const opened = yield* openClaimed;
        yield* recordEnd(opened.threadId!, "completed", "found", "abc123");
        const listed = (yield* (yield* PipelineRuns).list).runs;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.status, "session");
        assert.strictEqual(listed[0]?.headSha, "abc123");
        assert.strictEqual(listed[0]?.sessionEndedAt, ENDED_AT);
        assert.strictEqual(listed[0]?.detail, null);
        assert.strictEqual(listed[0]?.stuckReason, null);
        assert.strictEqual(listed[0]?.prNumber, null);
        const runs = yield* PipelineRuns;
        yield* runs.note(5, { detail: "读不到" });
        yield* (yield* DispatchSession.DispatchSession).tick;
        assert.strictEqual((yield* runs.list).runs[0]?.detail, "读不到");
      }),
    ),
  );

  it.effect("完成但查不到 head 停住并写明原因", () =>
    run(enabled, [issue(5)], () =>
      Effect.gen(function* () {
        const opened = yield* openClaimed;
        yield* recordEnd(opened.threadId!, "completed", "unavailable");
        const listed = (yield* (yield* PipelineRuns).list).runs[0];
        assert.strictEqual(listed?.status, "session");
        assert.strictEqual(listed?.headSha, null);
        assert.strictEqual(listed?.sessionEndedAt, ENDED_AT);
        assert.strictEqual(listed?.prNumber, null);
        assert.notStrictEqual(listed?.detail ?? "", "");
        assert.strictEqual(listed?.detail, "会话结束但查不到 head");
      }),
    ),
  );

  it.effect("失败先续一次，第二次才卡住并带上原终态", () =>
    run(enabled, [issue(5)], ({ opened, created }) =>
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const first = yield* openClaimed;
        const firstThread = first.threadId;
        yield* recordEnd(firstThread!, "failed", "unavailable");
        const renewed = (yield* runs.list).runs;
        assert.strictEqual(renewed.length, 1);
        assert.strictEqual(renewed[0]?.status, "claimed");
        assert.strictEqual(renewed[0]?.stuckReason, null);
        assert.strictEqual(renewed[0]?.detail, "已续一次");
        assert.strictEqual(renewed[0]?.renewedOnce, true);
        assert.strictEqual(renewed[0]?.threadId, null);
        yield* (yield* DispatchSession.DispatchSession).tick;
        const retried = (yield* runs.list).runs[0];
        assert.strictEqual(retried?.status, "session");
        assert.notStrictEqual(retried?.threadId, firstThread);
        const sessions = yield* Ref.get(opened);
        assert.strictEqual(sessions.length, 2);
        // 重派沿用原分支和原工作树，不新建。
        assert.strictEqual(sessions[0]?.branch, sessions[1]?.branch);
        assert.strictEqual(sessions[0]?.worktreePath, sessions[1]?.worktreePath);
        assert.strictEqual((yield* Ref.get(created)).length, 1);
        yield* recordEnd(retried?.threadId ?? "", "failed", "unavailable");
        const listed = (yield* runs.list).runs;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.id, renewed[0]?.id);
        assert.strictEqual(listed[0]?.status, "stuck");
        assert.strictEqual(listed[0]?.stuckReason, "会话失败");
        assert.strictEqual(listed[0]?.detail, "原终态 failed");
        assert.strictEqual(listed[0]?.renewedOnce, true);
      }),
    ),
  );

  it.effect("分支已存在但没人占着时沿用这条分支而不新建", () =>
    run(enabled, [issue(5)], ({ created, opened, git }) =>
      Effect.gen(function* () {
        const branch = DispatchSession.sessionBranch(5, "fix tests");
        git.branches.add(branch);
        yield* (yield* PipelineRuns).tick;
        yield* (yield* DispatchSession.DispatchSession).tick;
        const session = (yield* Ref.get(opened))[0];
        assert.strictEqual(session?.branch, branch);
        assert.strictEqual(session?.worktreePath, `/worktrees/${branch}`);
        assert.deepEqual(yield* Ref.get(created), [branch]);
      }),
    ),
  );

  it.effect("认领后改掉单标题，派发仍用原标题的分支", () =>
    run(enabled, [issue(5)], ({ opened, visible }) =>
      Effect.gen(function* () {
        yield* (yield* PipelineRuns).tick;
        // The issue title can be edited after the run was claimed; the branch must not move.
        yield* Ref.set(visible, [issue(5, "renamed title")]);
        yield* (yield* DispatchSession.DispatchSession).tick;
        const branch = DispatchSession.sessionBranch(5, "fix tests");
        const session = (yield* Ref.get(opened))[0];
        assert.strictEqual(session?.branch, branch);
        const runRow = (yield* (yield* PipelineRuns).list).runs[0];
        assert.strictEqual(DispatchSession.sessionBranch(5, runRow?.title ?? ""), branch);
      }),
    ),
  );

  it.effect("登记还在目录已删的工作树不复用，清掉登记后重新建树", () =>
    run(enabled, [issue(5)], ({ created, opened, git }) =>
      Effect.gen(function* () {
        const branch = DispatchSession.sessionBranch(5, "fix tests");
        git.branches.add(branch);
        git.checkouts.set(branch, { path: `/worktrees/${branch}`, prunable: true });
        yield* (yield* PipelineRuns).tick;
        yield* (yield* DispatchSession.DispatchSession).tick;
        const session = (yield* Ref.get(opened))[0];
        assert.strictEqual(session?.branch, branch);
        assert.deepEqual(yield* Ref.get(created), [branch]);
        assert.strictEqual(git.checkouts.get(branch)?.prunable, false);
      }),
    ),
  );

  it.effect("中断先续一次", () =>
    run(enabled, [issue(5)], () =>
      Effect.gen(function* () {
        const opened = yield* openClaimed;
        yield* recordEnd(opened.threadId!, "interrupted", "unavailable");
        const listed = (yield* (yield* PipelineRuns).list).runs;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.status, "claimed");
        assert.strictEqual(listed[0]?.detail, "已续一次");
        assert.strictEqual(listed[0]?.renewedOnce, true);
        assert.strictEqual(listed[0]?.threadId, null);
      }),
    ),
  );

  it.effect("取消变成卡住且不自动续", () =>
    run(enabled, [issue(5)], ({ created, opened }) =>
      Effect.gen(function* () {
        const started = yield* openClaimed;
        yield* recordEnd(started.threadId!, "cancelled", "unavailable");
        yield* (yield* DispatchSession.DispatchSession).tick;
        yield* (yield* DispatchSession.DispatchSession).tick;
        const listed = (yield* (yield* PipelineRuns).list).runs;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.status, "stuck");
        assert.strictEqual(listed[0]?.stuckReason, "取消");
        assert.strictEqual(listed[0]?.detail, "原终态 取消");
        assert.strictEqual((yield* Ref.get(created)).length, 1);
        assert.strictEqual((yield* Ref.get(opened)).length, 1);
      }),
    ),
  );

  it.effect("超过设置的分钟数变成超时", () =>
    run({ ...enabled, pipelineSessionTimeoutMinutes: 1 }, [issue(5)], ({ created }) =>
      Effect.gen(function* () {
        const started = yield* openClaimed;
        assert.notStrictEqual(started.sessionStartedAt, null);
        yield* TestClock.adjust(Duration.minutes(2));
        yield* (yield* DispatchSession.DispatchSession).tick;
        const listed = (yield* (yield* PipelineRuns).list).runs;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.status, "claimed");
        assert.strictEqual(listed[0]?.detail, "已续一次");
        assert.strictEqual(listed[0]?.renewedOnce, true);
        assert.strictEqual(listed[0]?.threadId, null);
        assert.strictEqual((yield* Ref.get(created)).length, 1);
        yield* (yield* DispatchSession.DispatchSession).tick;
        yield* TestClock.adjust(Duration.minutes(2));
        yield* (yield* DispatchSession.DispatchSession).tick;
        const again = (yield* (yield* PipelineRuns).list).runs;
        assert.strictEqual(again.length, 1);
        assert.strictEqual(again[0]?.status, "stuck");
        assert.strictEqual(again[0]?.stuckReason, "超时");
        assert.strictEqual(again[0]?.detail, "超时");
        assert.strictEqual(again[0]?.renewedOnce, true);
      }),
    ),
  );

  it.effect("记下一条运行不会改掉另一条", () =>
    run(enabled, [issue(5)], ({ visible }) =>
      Effect.gen(function* () {
        const first = yield* openClaimed;
        yield* recordEnd(first.threadId!, "failed", "unavailable");
        yield* Ref.set(visible, [issue(5), issue(6)]);
        yield* (yield* PipelineRuns).tick;
        yield* (yield* DispatchSession.DispatchSession).tick;
        const listed = (yield* (yield* PipelineRuns).list).runs;
        const kept = listed.find((item) => item.issueNumber === 5);
        const next = listed.find((item) => item.issueNumber === 6);
        assert.strictEqual(listed.length, 2);
        assert.strictEqual(kept?.renewedOnce, true);
        assert.strictEqual(kept?.id !== next?.id, true);
        assert.strictEqual(listed.filter((item) => item.status === "session").length, 1);
      }),
    ),
  );
});
