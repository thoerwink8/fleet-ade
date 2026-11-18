import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
import { PullRequestAdditions, layer as budgetLayer } from "./budget.ts";
import {
  MergeGate,
  MergeGateReader,
  PullRequestMerger,
  layer as mergeGateLayer,
} from "./mergeGate.ts";
import { PipelineSupervision, layer as supervisionLayer } from "./PipelineSupervision.ts";
import { PipelineGitHubIssues, PipelineIssuesIncompleteError } from "./GitHubIssues.ts";
import { layerPortsDefault } from "./intakeGates.ts";
import * as ClaimLease from "./claimLease.ts";

const repository = "thoerwink8/fleet-ade";
const controllerId = ThreadId.make("thread:controller");
const workerId = ThreadId.make("thread:worker");
const projectId = ProjectId.make("project:fleet-ade");
const providerInstanceId = ProviderInstanceId.make("codex");
const epoch = DateTime.makeUnsafe("2026-11-18T00:00:00.000Z");

const project: Project = {
  id: projectId,
  title: "fleet-ade",
  workspaceRoot: "/repos/thoerwink8/fleet-ade",
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
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-18T00:00:00.000Z",
  deletedAt: null,
};

const scope = (
  threadId: ThreadId,
  overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId,
  },
  client: undefined,
  ...overrides,
});

const shell = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id,
  projectId,
  title: id,
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: id === workerId ? "/worktrees/worker" : null,
  createdBy: "user",
  creationSource: "web",
  activeProviderThreadId: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  latestRunId: RunId.make(`run:${id}`),
  activeRunId: RunId.make(`run:${id}`),
  status: "running",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: epoch,
  hasActionableProposedPlan: false,
  itemCount: 1,
  visibleItemCount: 1,
  createdAt: epoch,
  updatedAt: epoch,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

const run = (threadId: ThreadId): OrchestrationV2Run => ({
  id: RunId.make(`run:${threadId}`),
  threadId,
  ordinal: 1,
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${threadId}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: epoch,
  startedAt: epoch,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

const message = (threadId: ThreadId): ThreadManagement.ThreadManagementSendResult["message"] => ({
  id: MessageId.make(`message:${threadId}`),
  threadId,
  runId: RunId.make(`run:${threadId}`),
  nodeId: null,
  role: "user",
  text: "继续",
  attachments: [],
  streaming: false,
  createdAt: epoch,
  updatedAt: epoch,
  createdBy: "agent",
  creationSource: "mcp",
});

const layer = (
  shells: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell | null>,
  mergeCalls?: Ref.Ref<ReadonlyArray<number>>,
) => {
  const projectionThread = (threadId: ThreadId) => {
    const current = shells.get(threadId) ?? shell(threadId);
    const {
      status: _status,
      activeRunId: _activeRunId,
      latestRunId: _latestRunId,
      pendingRuntimeRequest: _pendingRuntimeRequest,
      latestVisibleMessage: _latestVisibleMessage,
      hasActionableProposedPlan: _hasActionableProposedPlan,
      itemCount: _itemCount,
      visibleItemCount: _visibleItemCount,
      lastVisitedAt,
      ...thread6042
    } = current;
    return { ...thread6042, lastVisitedAt: lastVisitedAt ?? null };
  };
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    sendToThread: (input) =>
      Effect.succeed({
        dispatch: { sequence: 1, storedEvents: [] },
        projection: {
          thread: projectionThread(input.threadId),
          runs: [run(input.threadId)],
          messages: [message(input.threadId)],
          turnItems: [],
        },
        message: message(input.threadId),
        run: { ...run(input.threadId), status: "queued" },
        turnItem: null,
        delivery: "queued",
      } satisfies ThreadManagement.ThreadManagementSendResult),
    dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedSome(project),
  });
  const runs = runsLayer.pipe(
    Layer.provide(
      Layer.succeed(
        PipelineGitHubIssues,
        PipelineGitHubIssues.of({
          addLabel: () => Effect.die("unexpected label write"),
          listEligible: () =>
            Effect.succeed([
              {
                number: 81,
                title: "监督运行",
                body: "## 怎么算做完\n- 跑通测试\n",
                labels: ["交给 ADE"],
                author: { login: "thoerwink8", id: 1, type: "User" },
              },
            ]),
          read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(PipelineUsage, PipelineUsage.of({ read: () => Effect.succeed([]) })),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        pipelineEnabled: false,
        pipelineRepos: [repository],
      }),
    ),
    Layer.provide(layerPortsDefault),
    Layer.provide(ClaimLease.layerPort()),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  if (mergeCalls === undefined) {
    return Layer.mergeAll(supervisionLayer, mergeGateLayer).pipe(
      Layer.provide(threads),
      Layer.provide(projects),
      Layer.provide(budgetLayer),
      Layer.provide(Layer.succeed(PullRequestAdditions, { read: () => Effect.succeed(0) })),
      Layer.provide(
        Layer.succeed(MergeGateReader, {
          read: () => Effect.die("merge gate is not used by this test"),
        }),
      ),
      Layer.provide(
        Layer.succeed(PullRequestMerger, {
          merge: () => Effect.die("merge gate is not used by this test"),
        }),
      ),
      Layer.provideMerge(runs),
      Layer.provideMerge(ServerSettings.layerTest({ pipelineRepos: [repository] })),
    );
  }
  const settings = ServerSettings.layerTest({
    pipelineEnabled: false,
    pipelineAutoMerge: true,
    pipelineRepos: [repository],
  });
  const gatedRuns = runsLayer.pipe(
    Layer.provide(
      Layer.succeed(
        PipelineGitHubIssues,
        PipelineGitHubIssues.of({
          addLabel: () => Effect.die("unexpected label write"),
          listEligible: () =>
            Effect.succeed([
              {
                number: 81,
                title: "监督运行",
                body: "## 怎么算做完\n- 跑通测试\n",
                labels: ["交给 ADE"],
                author: { login: "thoerwink8", id: 1, type: "User" },
              },
            ]),
          read: () => Effect.fail(new PipelineIssuesIncompleteError({ reason: "capped" })),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(PipelineUsage, PipelineUsage.of({ read: () => Effect.succeed([]) })),
    ),
    Layer.provide(settings),
    Layer.provide(layerPortsDefault),
    Layer.provide(ClaimLease.layerPort()),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return Layer.mergeAll(supervisionLayer, mergeGateLayer).pipe(
    Layer.provide(threads),
    Layer.provide(projects),
    Layer.provide(budgetLayer),
    Layer.provide(Layer.succeed(PullRequestAdditions, { read: () => Effect.succeed(0) })),
    Layer.provide(
      Layer.succeed(MergeGateReader, {
        read: (entry) =>
          Effect.succeed({
            checks: [{ name: "CI", state: "success" as const }],
            coldVerify: "success" as const,
            paths: ["apps/server/src/pipeline/mergeGate.ts"],
            merged: entry.number === 18,
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(PullRequestMerger, {
        merge: (entry) => Ref.update(mergeCalls, (current) => [...current, entry.number]),
      }),
    ),
    Layer.provideMerge(gatedRuns),
    Layer.provideMerge(settings),
  );
};

describe("PipelineSupervision", () => {
  it.effect("授权控制线程、拒绝抢占并如实回报投递", () =>
    Effect.gen(function* () {
      const supervision = yield* PipelineSupervision;
      const started = yield* supervision.start(scope(controllerId), { issueNumber: 81 });
      assert.strictEqual(started.controllerThreadId, controllerId);
      const other = yield* Effect.exit(
        supervision.start(scope(ThreadId.make("thread:other")), { issueNumber: 81 }),
      );
      assert.strictEqual(Exit.isFailure(other), true);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE pipeline_runs SET thread_id = ${workerId}, head_sha = 'abc' WHERE id = ${started.id}`;
      const sent = yield* supervision.send(scope(controllerId), {
        issueNumber: 81,
        message: "继续",
      });
      assert.deepStrictEqual(sent, {
        delivery: "queued",
        threadId: workerId,
        messageId: MessageId.make(`message:${workerId}`),
        runId: RunId.make(`run:${workerId}`),
        status: "queued",
      });
      const status = yield* supervision.status(scope(controllerId), { issueNumber: 81 });
      assert.strictEqual(status.run.id, started.id);
      assert.deepStrictEqual(status.worker, {
        threadId: workerId,
        latestRunId: RunId.make(`run:${workerId}`),
        activeRunId: RunId.make(`run:${workerId}`),
        status: "running",
        latestMessage: null,
        lastError: null,
      });
    }).pipe(
      Effect.provide(
        layer(
          new Map([
            [controllerId, shell(controllerId)],
            [workerId, shell(workerId)],
          ]),
        ),
      ),
    ),
  );

  it.effect("拒绝旧头验收并接受同一头验收", () =>
    Effect.gen(function* () {
      const supervision = yield* PipelineSupervision;
      const started = yield* supervision.start(scope(controllerId), { issueNumber: 81 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE pipeline_runs SET head_sha = 'abc' WHERE id = ${started.id}`;
      const staleReview = {
        issueNumber: 81,
        verdict: "accepted" as const,
        expectedHeadSha: "abc",
      };
      yield* sql`UPDATE pipeline_runs SET head_sha = 'def' WHERE id = ${started.id}`;
      const stale = yield* Effect.exit(supervision.verdict(scope(controllerId), staleReview));
      assert.strictEqual(Exit.isFailure(stale), true);
      const accepted = yield* supervision.verdict(scope(controllerId), {
        issueNumber: 81,
        verdict: "accepted",
        expectedHeadSha: "def",
      });
      assert.deepStrictEqual(accepted, { verdict: "accepted", headSha: "def" });
    }).pipe(Effect.provide(layer(new Map([[controllerId, shell(controllerId)]])))),
  );

  it.effect("未合并时保留工人，合并后才按现有生命周期安全清理", () =>
    Effect.gen(function* () {
      const supervision = yield* PipelineSupervision;
      const started = yield* supervision.start(scope(controllerId), { issueNumber: 81 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE pipeline_runs SET thread_id = ${workerId}, head_sha = 'abc' WHERE id = ${started.id}`;
      const accepted = yield* supervision.verdict(scope(controllerId), {
        issueNumber: 81,
        verdict: "accepted",
        expectedHeadSha: "abc",
      });
      assert.deepStrictEqual(accepted, { verdict: "accepted", headSha: "abc" });
      const beforeMerge = yield* supervision.cleanup(scope(controllerId), { issueNumber: 81 });
      assert.deepStrictEqual(beforeMerge, {
        outcome: "retained",
        reason: "Pipeline run has not been merged.",
      });
      const stored = yield* PipelineRuns;
      yield* stored.note(81, { status: "merged" }, repository);
      const cleaned = yield* supervision.cleanup(scope(controllerId), { issueNumber: 81 });
      assert.deepStrictEqual(cleaned, {
        outcome: "retained",
        reason:
          "Worker deletion requested; existing lifecycle cleanup will remove its worktree only when safe.",
      });
    }).pipe(
      Effect.provide(
        layer(
          new Map([
            [controllerId, shell(controllerId)],
            [
              workerId,
              shell(workerId, {
                activeRunId: null,
                status: "idle",
                latestUserMessageAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
              }),
            ],
          ]),
        ),
      ),
    ),
  );

  it.effect("开关关闭时人工合并经合并闸回读后清理才可达", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<number>>([]);
      yield* Effect.gen(function* () {
        const supervision = yield* PipelineSupervision;
        const gate = yield* MergeGate;
        const stored = yield* PipelineRuns;
        yield* supervision.start(scope(controllerId), { issueNumber: 81 });
        yield* stored.note(
          81,
          { status: "verify", prNumber: 18, headSha: "abc", threadId: workerId },
          repository,
        );
        const accepted = yield* supervision.verdict(scope(controllerId), {
          issueNumber: 81,
          verdict: "accepted",
          expectedHeadSha: "abc",
        });
        assert.deepStrictEqual(accepted, { verdict: "accepted", headSha: "abc" });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO pipeline_runs (
            repository, issue_number, title, status, pr_number, head_sha, updated_at
          ) VALUES (
            ${repository}, 82, '普通运行', 'verify', 99, 'abc', '2026-11-18T00:00:00.000Z'
          )
        `;
        yield* gate.tick;
        const listed = (yield* stored.list).runs;
        const supervised = listed.find((run) => run.issueNumber === 81);
        const plain = listed.find((run) => run.issueNumber === 82);
        assert.strictEqual(supervised?.status, "merged");
        assert.strictEqual(plain?.status, "verify");
        assert.deepStrictEqual(yield* Ref.get(calls), []);
        const cleaned = yield* supervision.cleanup(scope(controllerId), { issueNumber: 81 });
        assert.deepStrictEqual(cleaned, {
          outcome: "retained",
          reason:
            "Worker deletion requested; existing lifecycle cleanup will remove its worktree only when safe.",
        });
      }).pipe(
        Effect.provide(
          layer(
            new Map([
              [controllerId, shell(controllerId)],
              [
                workerId,
                shell(workerId, {
                  activeRunId: null,
                  status: "idle",
                  latestUserMessageAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
                }),
              ],
            ]),
            calls,
          ),
        ),
      );
    }),
  );
});
