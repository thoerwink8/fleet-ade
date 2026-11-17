import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

import {
  ColdVerifySession,
  MAX_INCONCLUSIVE_RETRIES,
  VerifierOpener,
  conclusionOf,
  decideColdVerify,
  layer as coldLayer,
  type ColdVerifyRequest,
} from "./ColdVerifySession.ts";
import { GitHubCommitStatus, type CommitStatusWrite } from "./GitHubCommitStatus.ts";
import { PipelineGitHubIssues, type PipelineIssue } from "./GitHubIssues.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
import { layerPortsDefault } from "./intakeGates.ts";
import { SessionEndInbox, layer as inboxLayer } from "./SessionEndInbox.ts";
import type { ColdVerifyModelOutput } from "./coldVerifyVerdict.ts";

const AUTHOR: ModelSelection = {
  instanceId: ProviderInstanceId.make("author"),
  model: "author",
};
const VERIFIER: ModelSelection = {
  instanceId: ProviderInstanceId.make("verifier"),
  model: "verifier",
};
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_SHA = "89abcdef0123456789abcdef0123456789abcdef01";
const NOW = "2026-11-16T00:00:00.000Z";

const PROJECT: Project = {
  id: ProjectId.make("project:pipeline"),
  title: "fleet-ade",
  workspaceRoot: "/repo",
  repositoryIdentity: {
    canonicalKey: "github.com/thoerwink8/fleet-ade",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://example.invalid/fleet-ade.git",
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

const issue = (number: number): PipelineIssue => ({
  number,
  title: `单 ${number}`,
  body: "## 怎么算做完\n- 跑通测试\n",
  labels: ["交给 ADE"],
  author: { login: "thoerwink8", id: 1, type: "User" },
});

const passOutput: ColdVerifyModelOutput = {
  verdict: "pass",
  problems: [],
  suggestions: [{ text: "命名可以再短一点" }],
  handovers: [],
};

const blockOutput: ColdVerifyModelOutput = {
  verdict: "fail",
  problems: [{ text: "没做到验收条：第 1 条要求的测试没出现" }],
  suggestions: [],
  handovers: [],
};

interface Written {
  readonly sha: string;
  readonly state: string;
}

interface Handles {
  readonly opened: Ref.Ref<ReadonlyArray<ColdVerifyRequest>>;
  readonly written: Ref.Ref<ReadonlyArray<Written>>;
  readonly writeState: Ref.Ref<"success" | "failure" | "miss">;
  readonly messages: Ref.Ref<ReadonlyArray<{ readonly role: string; readonly text: string }>>;
}

const harness = (
  models: {
    readonly author: ReadonlyArray<ModelSelection>;
    readonly verifier: ReadonlyArray<ModelSelection>;
  },
  handles: Handles,
  openFails = false,
  eligible: ReadonlyArray<PipelineIssue> = [issue(8)],
) => {
  const memory = SqlitePersistence.layerMemory;
  const issues = Layer.succeed(
    PipelineGitHubIssues,
    PipelineGitHubIssues.of({
      listEligible: () => Effect.succeed(eligible),
      read: (number) => Effect.succeed(eligible.find((item) => item.number === number) ?? issue(8)),
    }),
  );
  const usage = Layer.succeed(PipelineUsage, PipelineUsage.of({ read: () => Effect.succeed([]) }));
  const settings = ServerSettings.layerTest({
    pipelineEnabled: true,
    pipelineAuthorModel: models.author,
    pipelineVerifierModel: models.verifier,
  });
  const opener = Layer.succeed(
    VerifierOpener,
    VerifierOpener.of({
      open: (request) =>
        openFails
          ? Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: CommandId.make("test:open"),
                commandType: "thread.create",
              }),
            )
          : Ref.update(handles.opened, (current) => [...current, request]),
    }),
  );
  const statuses = Layer.succeed(
    GitHubCommitStatus,
    GitHubCommitStatus.of({
      writeColdVerify: (target, outcome) =>
        Effect.gen(function* () {
          const mode = yield* Ref.get(handles.writeState);
          if (mode === "failure") {
            return yield* Effect.fail({
              _tag: "CommitStatusWriteError",
              sha: target.sha,
              message: "没写上",
            } as never);
          }
          const state = outcome.kind === "pass" ? "success" : "failure";
          const sha = mode === "miss" ? OLD_SHA : target.sha;
          const written: CommitStatusWrite = {
            kind: "written",
            sha,
            state,
            description: state,
          };
          yield* Ref.update(handles.written, (current) => [...current, { sha, state }]);
          return written;
        }),
    }),
  );
  const projects = Layer.succeed(ProjectService.ProjectService, {
    listPage: () => Effect.succeed({ projects: [PROJECT], nextCursor: null }),
  } as unknown as ProjectService.ProjectService["Service"]);
  const projections = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
    getThreadSnapshot: () =>
      Ref.get(handles.messages).pipe(
        Effect.map((messages) => ({
          schemaVersion: 2,
          snapshotSequence: 1,
          projection: { messages },
        })),
      ),
  } as unknown as ProjectionStore.ProjectionStoreV2["Service"]);
  const shared = Layer.mergeAll(runsLayer, inboxLayer).pipe(
    Layer.provide(issues),
    Layer.provide(usage),
    Layer.provide(settings),
    Layer.provide(layerPortsDefault),
    Layer.provideMerge(memory),
  );
  return coldLayer.pipe(
    Layer.provide(opener),
    Layer.provide(statuses),
    Layer.provide(projects),
    Layer.provide(projections),
    Layer.provide(settings),
    Layer.provideMerge(shared),
  );
};

const run = <E, R>(
  models: {
    readonly author: ReadonlyArray<ModelSelection>;
    readonly verifier: ReadonlyArray<ModelSelection>;
  },
  body: (handles: Handles) => Effect.Effect<void, E, R>,
  openFails = false,
  eligible: ReadonlyArray<PipelineIssue> = [issue(8)],
) =>
  Effect.gen(function* () {
    const opened = yield* Ref.make<ReadonlyArray<ColdVerifyRequest>>([]);
    const written = yield* Ref.make<ReadonlyArray<Written>>([]);
    const writeState = yield* Ref.make<"success" | "failure" | "miss">("success");
    const messages = yield* Ref.make<
      ReadonlyArray<{ readonly role: string; readonly text: string }>
    >([]);
    const handles = { opened, written, writeState, messages };
    return yield* body(handles).pipe(Effect.provide(harness(models, handles, openFails, eligible)));
  });

const claim = Effect.gen(function* () {
  yield* (yield* PipelineRuns).tick;
  yield* (yield* PipelineRuns).note(8, { status: "verify", headSha: SHA, stuckReason: null });
});

const tick = Effect.gen(function* () {
  yield* (yield* ColdVerifySession).tick;
  return (yield* (yield* PipelineRuns).list).runs[0];
});

describe("ColdVerifySession", () => {
  it.effect("模型没配就卡住且不派会话", () =>
    run({ author: [AUTHOR], verifier: [] }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        const listed = yield* tick;
        assert.strictEqual(listed?.status, "stuck");
        assert.strictEqual(listed?.stuckReason, "没配模型");
        assert.deepEqual(yield* Ref.get(handles.opened), []);
      }),
    ),
  );

  it.effect("验单模型和写单模型相同就卡住且不派会话", () =>
    run({ author: [AUTHOR], verifier: [AUTHOR] }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        const listed = yield* tick;
        assert.strictEqual(listed?.stuckReason, "没配模型");
        assert.deepEqual(yield* Ref.get(handles.opened), []);
      }),
    ),
  );

  it.effect("任务号和 PR 号不同时，交代里是仓、PR 号和当前 head", () =>
    run(
      { author: [AUTHOR], verifier: [VERIFIER] },
      (handles) =>
        Effect.gen(function* () {
          const runs = yield* PipelineRuns;
          yield* runs.tick;
          yield* runs.note(28, {
            status: "verify",
            prNumber: 32,
            headSha: SHA,
            stuckReason: null,
          });
          yield* (yield* ColdVerifySession).tick;
          const text = (yield* Ref.get(handles.opened))[0]?.text ?? "";
          assert.match(text, /thoerwink8\/fleet-ade/);
          assert.match(text, /任务 #28/);
          assert.match(text, /任务号不是 PR 号/);
          assert.match(text, /PR #32/);
          assert.notMatch(text, /PR #28/);
          assert.match(text, /基线分支/);
          assert.match(text, new RegExp(SHA));
          assert.match(text, /别的 head 不算/);
          assert.notMatch(text, new RegExp(OLD_SHA));
        }),
      false,
      [issue(28)],
    ),
  );

  it.effect("第一轮过只把 success 写到当前 head，建议留在运行上", () =>
    run({ author: [AUTHOR], verifier: [VERIFIER] }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        const dispatched = yield* tick;
        const threadId = /^已派第:\d+:次:\d+:(\S+)$/.exec(dispatched?.detail ?? "")?.[1] ?? "";
        yield* Ref.set(handles.messages, [{ role: "assistant", text: JSON.stringify(passOutput) }]);
        yield* (yield* SessionEndInbox).record({
          threadId: ThreadId.make(threadId),
          runId: RunId.make(`end:${threadId}`),
          status: "completed",
          endedAt: NOW,
          headLookup: "found",
          headSha: SHA,
        });
        const listed = yield* tick;
        assert.strictEqual(listed?.status, "verify");
        assert.strictEqual(listed?.stuckReason, null);
        assert.match(listed?.detail ?? "", /建议：命名可以再短一点/);
        assert.deepEqual(yield* Ref.get(handles.written), [{ sha: SHA, state: "success" }]);
      }),
    ),
  );

  it.effect("两轮都不过就卡住，原因是冷验收不过", () =>
    run({ author: [AUTHOR], verifier: [VERIFIER] }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        for (const round of [1, 2]) {
          const dispatched = yield* tick;
          const threadId = /^已派第:\d+:次:\d+:(\S+)$/.exec(dispatched?.detail ?? "")?.[1] ?? "";
          assert.match(dispatched?.detail ?? "", new RegExp(`已派第:${round}:次:1:`));
          yield* Ref.set(handles.messages, [
            { role: "assistant", text: JSON.stringify(blockOutput) },
          ]);
          yield* (yield* SessionEndInbox).record({
            threadId: ThreadId.make(threadId),
            runId: RunId.make(`end:${threadId}:${round}`),
            status: "completed",
            endedAt: NOW,
            headLookup: "found",
            headSha: SHA,
          });
          yield* tick;
        }
        const listed = (yield* (yield* PipelineRuns).list).runs[0];
        assert.strictEqual(listed?.status, "stuck");
        assert.strictEqual(listed?.stuckReason, "冷验收不过");
        assert.deepEqual(yield* Ref.get(handles.written), []);
      }),
    ),
  );

  it.effect("旧 head 上的 success 不放行", () =>
    run({ author: [AUTHOR], verifier: [VERIFIER] }, () =>
      Effect.gen(function* () {
        const decision = yield* decideColdVerify(
          {
            sha: SHA,
            priorRounds: 0,
            inconclusiveAttempts: 0,
            attempts: [{ kind: "output", output: passOutput }],
            suggestions: [],
          },
          () =>
            Effect.succeed({
              kind: "written",
              sha: OLD_SHA,
              state: "success",
              description: "验收通过",
            }),
        );
        assert.strictEqual(decision.note.status, "verify");
        assert.strictEqual(decision.status, undefined);
        assert.match(decision.note.detail ?? "", /没写到当前 head/);
      }),
    ),
  );

  it.effect("会话没跑起来是不过，不写成通过", () =>
    run(
      { author: [AUTHOR], verifier: [VERIFIER] },
      () =>
        Effect.gen(function* () {
          yield* claim;
          const listed = yield* tick;
          assert.strictEqual(listed?.status, "stuck");
          assert.strictEqual(listed?.stuckReason, "冷验收不过");
          assert.match(listed?.detail ?? "", /没跑起来/);
        }),
      true,
    ),
  );

  it.effect("等资源仍是待验，不写失败也不写通过", () =>
    Effect.gen(function* () {
      const decision = yield* decideColdVerify(
        {
          sha: SHA,
          priorRounds: 0,
          inconclusiveAttempts: 0,
          attempts: [{ kind: "waiting" }],
          suggestions: [],
        },
        () => Effect.die("等资源不该写状态"),
      );
      assert.strictEqual(decision.note.status, "verify");
      assert.strictEqual(decision.note.stuckReason, undefined);
      assert.strictEqual(decision.status, undefined);
    }),
  );

  it.effect("名额满了不派验单会话，空出名额后再派", () =>
    run(
      { author: [AUTHOR], verifier: [VERIFIER] },
      (handles) =>
        Effect.gen(function* () {
          const runs = yield* PipelineRuns;
          yield* runs.tick;
          yield* runs.note(8, {
            status: "session",
            threadId: "author-thread",
            stuckReason: null,
          });
          yield* runs.note(9, { status: "verify", headSha: SHA, stuckReason: null });
          yield* (yield* ColdVerifySession).tick;
          const waiting = (yield* runs.list).runs.find((run) => run.issueNumber === 9);
          assert.strictEqual(waiting?.status, "verify");
          assert.strictEqual(waiting?.stuckReason, null);
          assert.deepEqual(yield* Ref.get(handles.opened), []);
          assert.deepEqual(yield* Ref.get(handles.written), []);
          yield* runs.note(8, { status: "merged", stuckReason: null });
          yield* (yield* ColdVerifySession).tick;
          const dispatched = (yield* runs.list).runs.find((run) => run.issueNumber === 9);
          assert.match(dispatched?.detail ?? "", /已派第:1:次:1:/);
          assert.strictEqual((yield* Ref.get(handles.opened)).length, 1);
        }),
      false,
      [issue(8), issue(9)],
    ),
  );

  it.effect("派验单和记结论都不换作者线程，也不清用量", () =>
    run({ author: [AUTHOR], verifier: [VERIFIER] }, (handles) =>
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const sql = yield* SqlClient.SqlClient;
        yield* runs.tick;
        yield* runs.note(8, {
          status: "verify",
          headSha: SHA,
          threadId: "author-thread",
          stuckReason: null,
        });
        yield* sql`UPDATE pipeline_runs SET
          model_account = 'author',
          input_tokens = 40,
          output_tokens = 2,
          cache_tokens = 0,
          converted_cost = 1
          WHERE issue_number = 8`;
        const dispatched = yield* tick;
        assert.strictEqual(dispatched?.threadId, "author-thread");
        assert.strictEqual(dispatched?.inputTokens, 40);
        assert.strictEqual(dispatched?.modelAccount, "author");
        const threadId = /^已派第:1:次:1:(\S+)$/.exec(dispatched?.detail ?? "")?.[1] ?? "";
        assert.notStrictEqual(threadId, "");
        assert.notStrictEqual(threadId, "author-thread");
        yield* Ref.set(handles.messages, [{ role: "assistant", text: JSON.stringify(passOutput) }]);
        yield* (yield* SessionEndInbox).record({
          threadId: ThreadId.make(threadId),
          runId: RunId.make(`end:${threadId}`),
          status: "completed",
          endedAt: NOW,
          headLookup: "found",
          headSha: SHA,
        });
        const listed = yield* tick;
        assert.strictEqual(listed?.status, "verify");
        assert.strictEqual(listed?.threadId, "author-thread");
        assert.strictEqual(listed?.inputTokens, 40);
        assert.strictEqual(listed?.outputTokens, 2);
        assert.strictEqual(listed?.modelAccount, "author");
        assert.strictEqual(listed?.usageNote, null);
      }),
    ),
  );

  it.effect("状态写失败则仍是待验", () =>
    run({ author: [AUTHOR], verifier: [VERIFIER] }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        const dispatched = yield* tick;
        yield* Ref.set(handles.writeState, "failure");
        yield* Ref.set(handles.messages, [{ role: "assistant", text: JSON.stringify(passOutput) }]);
        yield* (yield* SessionEndInbox).record({
          threadId: ThreadId.make(
            /^已派第:\d+:次:\d+:(\S+)$/.exec(dispatched?.detail ?? "")?.[1] ?? "",
          ),
          runId: RunId.make("end:write-failed"),
          status: "completed",
          endedAt: NOW,
          headLookup: "found",
          headSha: SHA,
        });
        const failed = yield* (yield* ColdVerifySession).tick.pipe(Effect.exit);
        assert.strictEqual(failed._tag, "Failure");
        const listed = (yield* (yield* PipelineRuns).list).runs[0];
        assert.strictEqual(listed?.status, "verify");
        assert.strictEqual(listed?.stuckReason, null);
      }),
    ),
  );

  it.effect("最后一条助手消息才是结论", () =>
    Effect.gen(function* () {
      const output = yield* conclusionOf([
        { role: "user", text: "看 diff" },
        { role: "assistant", text: JSON.stringify(passOutput) },
      ]);
      assert.strictEqual(output !== "inconclusive" ? output?.verdict : undefined, "pass");
      const missing = yield* conclusionOf([{ role: "user", text: "只有问题" }]);
      assert.strictEqual(missing, undefined);
    }),
  );
  const recordCompleted = (threadId: string, runId: string) =>
    Effect.gen(function* () {
      yield* (yield* SessionEndInbox).record({
        threadId: ThreadId.make(threadId),
        runId: RunId.make(runId),
        status: "completed",
        endedAt: NOW,
        headLookup: "found",
        headSha: SHA,
      });
    });

  it.effect("没验成不占轮次，同一轮内换新会话，真不过仍占两轮", () =>
    run({ author: [AUTHOR], verifier: [VERIFIER] }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        assert.strictEqual(MAX_INCONCLUSIVE_RETRIES, 3);
        const threads: string[] = [];
        for (let attempt = 1; attempt <= MAX_INCONCLUSIVE_RETRIES; attempt += 1) {
          const dispatched = yield* tick;
          const threadId = /^已派第:1:次:(\d+):(\S+)$/.exec(dispatched?.detail ?? "")?.[2] ?? "";
          assert.match(dispatched?.detail ?? "", new RegExp(`已派第:1:次:${attempt}:`));
          threads.push(threadId);
          yield* Ref.set(handles.messages, [
            {
              role: "assistant",
              text: JSON.stringify({
                verdict: "blocked",
                findings: [{ scope: "diff" }],
                suggestions: ["再看"],
              }),
            },
          ]);
          yield* recordCompleted(threadId, `end:${threadId}`);
          const listed = yield* tick;
          if (attempt < MAX_INCONCLUSIVE_RETRIES) {
            assert.strictEqual(listed?.status, "verify");
            assert.strictEqual(listed?.stuckReason, null);
          } else {
            assert.strictEqual(listed?.status, "stuck");
            assert.strictEqual(listed?.stuckReason, "冷验收没验成");
          }
          assert.match(listed?.detail ?? "", /已完成:0:轮:没验成/);
        }
        assert.strictEqual(new Set(threads).size, MAX_INCONCLUSIVE_RETRIES);
        assert.strictEqual((yield* Ref.get(handles.opened)).length, MAX_INCONCLUSIVE_RETRIES);
        assert.deepEqual(yield* Ref.get(handles.written), []);
      }),
    ),
  );

  it.effect("空结论不占轮次，同一轮内记一次没验成", () =>
    run({ author: [AUTHOR], verifier: [VERIFIER] }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        const dispatched = yield* tick;
        const threadId = /^已派第:1:次:1:(\S+)$/.exec(dispatched?.detail ?? "")?.[1] ?? "";
        yield* Ref.set(handles.messages, [
          {
            role: "assistant",
            text: JSON.stringify({
              verdict: null,
              problems: [],
              suggestions: [],
              handovers: [],
            }),
          },
        ]);
        yield* recordCompleted(threadId, `end:${threadId}`);
        const listed = yield* tick;
        assert.strictEqual(listed?.status, "verify");
        assert.strictEqual(listed?.stuckReason, null);
        assert.match(listed?.detail ?? "", /已完成:0:轮:没验成:已试:1/);
        assert.strictEqual((yield* Ref.get(handles.opened)).length, 1);
        const retried = yield* tick;
        assert.match(retried?.detail ?? "", /已派第:1:次:2:/);
        assert.strictEqual((yield* Ref.get(handles.opened)).length, 2);
      }),
    ),
  );

  it.effect("解码失败记没验成，不记成空结论", () =>
    Effect.gen(function* () {
      const malformed = yield* conclusionOf([
        {
          role: "assistant",
          text: JSON.stringify({
            verdict: "blocked",
            findings: [{ scope: "diff" }],
            suggestions: ["再看"],
          }),
        },
      ]);
      assert.strictEqual(malformed, "inconclusive");
      const unreadable = yield* conclusionOf([{ role: "assistant", text: "不是 JSON" }]);
      assert.strictEqual(unreadable, "inconclusive");
    }),
  );

  it.effect("旧的没验成卡住运行回到待验，保留 PR、head 和作者用量", () =>
    run({ author: [AUTHOR], verifier: [VERIFIER] }, (handles) =>
      Effect.gen(function* () {
        const runs = yield* PipelineRuns;
        const sql = yield* SqlClient.SqlClient;
        yield* runs.tick;
        yield* runs.note(8, {
          status: "verify",
          prNumber: 32,
          headSha: SHA,
          threadId: "author-thread",
          stuckReason: null,
        });
        yield* runs.note(8, {
          status: "stuck",
          stuckReason: "冷验收不过",
          detail: "第 2 轮仍没验成",
        });
        yield* sql`UPDATE pipeline_runs SET model_account = 'author', input_tokens = 40, output_tokens = 2, cache_tokens = 0, converted_cost = 1 WHERE issue_number = 8`;
        const listed = yield* tick;
        assert.strictEqual(listed?.status, "verify");
        assert.strictEqual(listed?.stuckReason, null);
        assert.strictEqual(listed?.prNumber, 32);
        assert.strictEqual(listed?.headSha, SHA);
        assert.strictEqual(listed?.threadId, "author-thread");
        assert.strictEqual(listed?.inputTokens, 40);
        assert.match(listed?.detail ?? "", /已派第:2:次:1:/);
        const text = (yield* Ref.get(handles.opened))[0]?.text ?? "";
        assert.match(text, /PR #32/);
        assert.match(text, new RegExp(SHA));
        assert.match(text, /verdict/);
        assert.match(text, /"text"/);
      }),
    ),
  );
});
