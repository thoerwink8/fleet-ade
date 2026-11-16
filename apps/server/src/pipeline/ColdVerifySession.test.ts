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
import * as Feishu from "./feishu.ts";
import * as Ref from "effect/Ref";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

import {
  ColdVerifySession,
  VerifierOpener,
  conclusionOf,
  decideColdVerify,
  layer as coldLayer,
  type ColdVerifyRequest,
} from "./ColdVerifySession.ts";
import { GitHubCommitStatus, type CommitStatusWrite } from "./GitHubCommitStatus.ts";
import { PipelineGitHubIssues, type PipelineIssue } from "./GitHubIssues.ts";
import { PipelineRuns, PipelineUsage, layer as runsLayer } from "./PipelineRuns.ts";
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
  models: { readonly author: ModelSelection | null; readonly verifier: ModelSelection | null },
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
    Layer.provide(
      Layer.succeed(
        Feishu.PipelineFeishu,
        Feishu.PipelineFeishu.of({
          send: () => Effect.succeed({ delivered: false, note: "没送出：未配置" }),
        }),
      ),
    ),
    Layer.provide(issues),
    Layer.provide(usage),
    Layer.provide(settings),
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
  models: { readonly author: ModelSelection | null; readonly verifier: ModelSelection | null },
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
    run({ author: AUTHOR, verifier: null }, (handles) =>
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
    run({ author: AUTHOR, verifier: AUTHOR }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        const listed = yield* tick;
        assert.strictEqual(listed?.stuckReason, "没配模型");
        assert.deepEqual(yield* Ref.get(handles.opened), []);
      }),
    ),
  );

  it.effect("第一轮过只把 success 写到当前 head，建议留在运行上", () =>
    run({ author: AUTHOR, verifier: VERIFIER }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        const dispatched = yield* tick;
        const threadId = dispatched?.threadId ?? "";
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
    run({ author: AUTHOR, verifier: VERIFIER }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        for (const round of [1, 2]) {
          const dispatched = yield* tick;
          const threadId = dispatched?.threadId ?? "";
          assert.match(dispatched?.detail ?? "", new RegExp(`已派第 ${round} 轮`));
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
    run({ author: AUTHOR, verifier: VERIFIER }, () =>
      Effect.gen(function* () {
        const decision = yield* decideColdVerify(
          {
            sha: SHA,
            priorRounds: 0,
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
      { author: AUTHOR, verifier: VERIFIER },
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
        { sha: SHA, priorRounds: 0, attempts: [{ kind: "waiting" }], suggestions: [] },
        () => Effect.die("等资源不该写状态"),
      );
      assert.strictEqual(decision.note.status, "verify");
      assert.strictEqual(decision.note.stuckReason, undefined);
      assert.strictEqual(decision.status, undefined);
    }),
  );

  it.effect("名额满了不派验单会话，空出名额后再派", () =>
    run(
      { author: AUTHOR, verifier: VERIFIER },
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
          assert.match(dispatched?.detail ?? "", /已派第 1 轮/);
          assert.strictEqual((yield* Ref.get(handles.opened)).length, 1);
        }),
      false,
      [issue(8), issue(9)],
    ),
  );

  it.effect("状态写失败则仍是待验", () =>
    run({ author: AUTHOR, verifier: VERIFIER }, (handles) =>
      Effect.gen(function* () {
        yield* claim;
        const dispatched = yield* tick;
        yield* Ref.set(handles.writeState, "failure");
        yield* Ref.set(handles.messages, [{ role: "assistant", text: JSON.stringify(passOutput) }]);
        yield* (yield* SessionEndInbox).record({
          threadId: ThreadId.make(dispatched?.threadId ?? ""),
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
      assert.strictEqual(output?.verdict, "pass");
      const missing = yield* conclusionOf([{ role: "user", text: "只有问题" }]);
      assert.strictEqual(missing, undefined);
    }),
  );
});
