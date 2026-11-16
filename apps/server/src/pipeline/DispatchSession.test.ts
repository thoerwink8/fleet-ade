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
import * as TestClock from "effect/testing/TestClock";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PullRequestAdditions, layer as budgetLayer } from "./budget.ts";
import * as DispatchSession from "./DispatchSession.ts";
import { PipelineGitHubIssues, type PipelineIssue } from "./GitHubIssues.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
import { SessionEndInbox, layer as inboxLayer, type SessionEndStatus } from "./SessionEndInbox.ts";

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
});

interface PipelinePatch {
  readonly pipelineEnabled: boolean;
  readonly pipelineAuthorModel: ModelSelection | null;
  readonly pipelineSessionTimeoutMinutes?: number;
}

interface Handles {
  readonly opened: Ref.Ref<ReadonlyArray<DispatchSession.DispatchedSession>>;
  readonly created: Ref.Ref<ReadonlyArray<string>>;
  readonly visible: Ref.Ref<ReadonlyArray<PipelineIssue>>;
}

const sessionLayer = (
  patch: PipelinePatch,
  visible: Ref.Ref<ReadonlyArray<PipelineIssue>>,
  opened: Ref.Ref<ReadonlyArray<DispatchSession.DispatchedSession>>,
  created: Ref.Ref<ReadonlyArray<string>>,
) => {
  const memory = SqlitePersistence.layerMemory;
  const issues = Layer.succeed(
    PipelineGitHubIssues,
    PipelineGitHubIssues.of({
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
      return Ref.update(created, (current) => [...current, branch]).pipe(
        Effect.as({ worktree: { path: `/worktrees/${branch}`, refName: branch } }),
      );
    },
  } as unknown as GitWorkflowService.GitWorkflowService["Service"]);
  const projects = Layer.succeed(ProjectService.ProjectService, {
    listPage: () => Effect.succeed({ projects: [PROJECT], nextCursor: null }),
  } as unknown as ProjectService.ProjectService["Service"]);
  const shared = Layer.mergeAll(runsLayer, inboxLayer).pipe(
    Layer.provide(issues),
    Layer.provide(usage),
    Layer.provide(settings),
    Layer.provideMerge(memory),
  );
  return DispatchSession.layer.pipe(
    Layer.provide(budgetLayer),
    Layer.provide(
      Layer.succeed(PullRequestAdditions, {
        read: () => Effect.succeed(0),
      }),
    ),
    Layer.provide(opener),
    Layer.provide(git),
    Layer.provide(projects),
    Layer.provide(issues),
    Layer.provide(settings),
    Layer.provideMerge(shared),
  );
};

const run = <E, R>(
  patch: PipelinePatch,
  issues: ReadonlyArray<PipelineIssue>,
  body: (handles: Handles) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const opened = yield* Ref.make<ReadonlyArray<DispatchSession.DispatchedSession>>([]);
    const created = yield* Ref.make<ReadonlyArray<string>>([]);
    const visible = yield* Ref.make(issues);
    yield* body({ opened, created, visible }).pipe(
      Effect.provide(sessionLayer(patch, visible, opened, created)),
    );
  });

const enabled = {
  pipelineEnabled: true,
  pipelineAuthorModel: MODEL,
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

describe("DispatchSession", () => {
  it.effect("开关关着不建树不开会话", () =>
    run({ pipelineEnabled: false, pipelineAuthorModel: MODEL }, [issue(5)], ({ opened, created }) =>
      Effect.gen(function* () {
        yield* (yield* PipelineRuns).tick;
        yield* (yield* DispatchSession.DispatchSession).tick;
        assert.deepEqual(yield* Ref.get(opened), []);
        assert.deepEqual(yield* Ref.get(created), []);
        assert.strictEqual((yield* (yield* PipelineRuns).list).runs.length, 0);
      }),
    ),
  );

  it.effect("没配模型卡住且没有树", () =>
    run({ pipelineEnabled: true, pipelineAuthorModel: null }, [issue(5)], ({ created }) =>
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
    run(enabled, [issue(5)], () =>
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const opened = yield* openClaimed;
        const firstThread = opened.threadId;
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
