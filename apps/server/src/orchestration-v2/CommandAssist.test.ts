import { assert, it } from "@effect/vitest";
import {
  COMMAND_ASSIST_TIMEOUT_MS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ServerSettingsError,
  type ServerSettings,
  type CommandAssistRunResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as CommandAssist from "./CommandAssist.ts";

const projectId = ProjectId.make("project-assist");
const named = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "name-model",
};

const layerFor = (
  model: CommandAssist.CommandAssistModel["Service"],
  settings: Layer.Layer<
    ServerSettingsService.ServerSettingsService,
    ServerSettingsError
  > = ServerSettingsService.layerTest({}),
) =>
  CommandAssist.layer.pipe(
    Layer.provide(Layer.succeed(CommandAssist.CommandAssistModel, model)),
    Layer.provide(settings),
    Layer.provide(SqlitePersistence.layerMemory),
  );

const countingModel = (complete: CommandAssist.CommandAssistModel["Service"]["complete"]) => {
  const calls = { complete: 0 };
  const model: CommandAssist.CommandAssistModel["Service"] = {
    complete: (input) => {
      calls.complete += 1;
      return complete(input);
    },
  };
  return { calls, model };
};

const enabledAssist = {
  ...DEFAULT_SERVER_SETTINGS.commandAssist,
  activity: { enabled: true, modelSelection: null },
  drift: { enabled: true, modelSelection: null },
  handback: { enabled: true, modelSelection: null },
  speech: { enabled: true, modelSelection: null },
};

it.effect("skips a row that is off, a row with no model, and an unknown step", () =>
  Effect.gen(function* () {
    const { calls, model } = countingModel(() => Effect.succeed("unused"));
    const assist = yield* CommandAssist.CommandAssist.pipe(
      Effect.provide(
        layerFor(
          model,
          Layer.mock(ServerSettingsService.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              textGenerationModelSelection: null,
              commandAssist: {
                ...DEFAULT_SERVER_SETTINGS.commandAssist,
                activity: { enabled: false, modelSelection: named },
                drift: { enabled: true, modelSelection: null },
                futureStep: { enabled: true, modelSelection: named },
              },
            } as unknown as ServerSettings),
          }),
        ),
      ),
    );
    const off = yield* assist.run("activity", {
      projectId,
      cwd: "/repo",
      prompt: "summary",
    });
    const unknown = yield* assist.run("futureStep", {
      projectId,
      cwd: "/repo",
      prompt: "later",
    });
    const missing = yield* assist.run("drift", { projectId: null, cwd: "/repo", prompt: "drift" });
    assert.deepStrictEqual(off, { _tag: "skipped", reason: "off" });
    assert.deepStrictEqual(unknown, { _tag: "skipped", reason: "unknown" });
    assert.deepStrictEqual(missing, { _tag: "skipped", reason: "no-model" });
    assert.strictEqual(calls.complete, 0);
  }),
);

it.effect("returns the model text, and a model failure stays a value", () =>
  Effect.gen(function* () {
    const childStatus = yield* Ref.make("running");
    const assist = yield* CommandAssist.CommandAssist;
    const done = yield* assist.run("activity", {
      projectId: null,
      cwd: "/repo",
      prompt: "what now",
    });
    const broken = yield* assist.run("drift", {
      projectId: null,
      cwd: "/repo",
      prompt: "drift",
    });
    assert.deepStrictEqual(done, { _tag: "completed", text: "在改解析器" });
    assert.deepStrictEqual(broken, { _tag: "failed", reason: "调用失败" });
    assert.strictEqual(yield* Ref.get(childStatus), "running");
  }).pipe(
    Effect.provide(
      layerFor(
        {
          complete: (input) =>
            input.prompt === "drift"
              ? Effect.fail({ reason: "调用失败" })
              : Effect.succeed("在改解析器"),
        },
        ServerSettingsService.layerTest({ commandAssist: enabledAssist }),
      ),
    ),
  ),
);

it.effect("stops at 15 seconds without holding dispatch or a pull request", () =>
  Effect.gen(function* () {
    const childStatus = yield* Ref.make("running");
    const assist = yield* CommandAssist.CommandAssist;
    const fiber = yield* Effect.gen(function* () {
      const opened = yield* Effect.succeed("pr-opened");
      assert.strictEqual(opened, "pr-opened");
      assert.strictEqual(yield* Ref.get(childStatus), "running");
      return yield* assist.run("speech", { projectId: null, cwd: "/repo", prompt: "整理这段" });
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(COMMAND_ASSIST_TIMEOUT_MS));
    const result: CommandAssistRunResult = yield* Fiber.join(fiber);
    assert.deepStrictEqual(result, { _tag: "failed", reason: "超时" });
    assert.strictEqual(yield* Ref.get(childStatus), "running");
  }).pipe(
    Effect.provide(
      layerFor(
        {
          complete: () =>
            Effect.sleep(Duration.millis(COMMAND_ASSIST_TIMEOUT_MS + 1_000)).pipe(
              Effect.as("late"),
            ),
        },
        ServerSettingsService.layerTest({ commandAssist: enabledAssist }),
      ),
    ),
  ),
);

const threadId = ThreadId.make("thread-assist");

const facts = (
  patch: Partial<CommandAssist.CommandAssistFacts> = {},
): CommandAssist.CommandAssistFacts => ({
  threadId,
  projectId: null,
  cwd: "/repo",
  runId: "run-1",
  opened: false,
  stepCount: 0,
  silence: false,
  goal: "修好解析",
  avoid: "别改锁",
  activity: "在改 parser.ts",
  files: [{ path: "parser.ts", additions: 3, deletions: 1 }],
  latestCommand: "vp test run parser",
  additions: 3,
  deletions: 1,
  childPhase: "在跑",
  ...patch,
});

const asksOf = (prompt: string) => (prompt.split("\n")[0] ?? "").replace(/^ASK\s?/u, "");

const rows = (
  activity: boolean,
  drift: boolean,
  patrol = false,
  handback = false,
  speech = false,
): ServerSettings["commandAssist"] => ({
  ...DEFAULT_SERVER_SETTINGS.commandAssist,
  activity: { enabled: activity, modelSelection: null },
  drift: { enabled: drift, modelSelection: null },
  handback: { enabled: handback, modelSelection: null },
  speech: { enabled: speech, modelSelection: null },
  patrol: { enabled: patrol, modelSelection: null },
});

const harness = (
  model: CommandAssist.CommandAssistModel["Service"],
  settings: Layer.Layer<ServerSettingsService.ServerSettingsService, ServerSettingsError>,
) => Layer.merge(layerFor(model, settings), settings);

const reply = JSON.stringify({
  activity: "在改 a.ts",
  drift: "碰了不该碰的",
  outlook: "会改 1 个文件",
});

it.effect("does not write state when activity and drift are off", () => {
  const database = SqlitePersistence.layerMemory;
  const assist = CommandAssist.layer.pipe(
    Layer.provide(
      Layer.succeed(CommandAssist.CommandAssistModel, {
        complete: () => Effect.die("off rows do not call"),
      }),
    ),
    Layer.provide(ServerSettingsService.layerTest({ commandAssist: rows(false, false) })),
    Layer.provide(database),
  );
  const stack = Layer.merge(assist, database);
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    const sql = yield* SqlClient.SqlClient;
    const thread = ThreadId.make("thread-nosave");
    yield* assist.observe(facts({ opened: true, stepCount: 40, silence: true, threadId: thread }));
    const rows = yield* sql<{ readonly total: number }>`
      SELECT count(*) AS total FROM command_assist_state
    `;
    assert.strictEqual(Number(rows[0]?.total ?? 0), 0);
    yield* sql`
      INSERT INTO command_assist_state (thread_id, state_json, updated_at)
      VALUES (${thread}, ${JSON.stringify({ outlook: "共享" })}, ${"2026-01-01T00:00:00.000Z"})
    `;
    assert.strictEqual((yield* assist.read(thread)).outlook, "共享");
  }).pipe(Effect.provide(stack));
});

it.effect("calls once for summary and drift, and skips the part that is off", () => {
  const prompts: string[] = [];
  const settings = ServerSettingsService.layerTest({ commandAssist: rows(false, false) });
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    const settingsService = yield* ServerSettingsService.ServerSettingsService;
    const childPhase = yield* Ref.make("在跑");
    const bothOff = yield* assist.observe(
      facts({ opened: true, stepCount: 40, silence: true, threadId: ThreadId.make("thread-off") }),
    );
    assert.strictEqual(bothOff.called, false);
    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(bothOff.outlook, null);
    assert.strictEqual(bothOff.childPhase, yield* Ref.get(childPhase));

    yield* settingsService.updateSettings({ commandAssist: rows(true, false) });
    const onlyActivity = yield* assist.observe(
      facts({ opened: true, threadId: ThreadId.make("thread-activity") }),
    );
    assert.strictEqual(onlyActivity.called, true);
    assert.strictEqual(asksOf(prompts[0] ?? ""), "activity outlook");
    assert.strictEqual(onlyActivity.activity, "在改 a.ts");
    assert.strictEqual(onlyActivity.drift, null);
    assert.strictEqual(onlyActivity.outlook, "会改 1 个文件");

    yield* settingsService.updateSettings({ commandAssist: rows(false, true) });
    const onlyDrift = yield* assist.observe(
      facts({ opened: true, threadId: ThreadId.make("thread-drift") }),
    );
    assert.strictEqual(asksOf(prompts.at(-1) ?? ""), "drift");
    assert.strictEqual(onlyDrift.drift, "碰了不该碰的");
    assert.strictEqual(onlyDrift.outlook, null);
    assert.strictEqual(prompts.length, 2);
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: (input) => {
            prompts.push(input.prompt);
            return Effect.succeed(reply);
          },
        },
        settings,
      ),
    ),
  );
});

it.effect(
  "does not call again for the same input, a clock tick, or a marked false positive",
  () => {
    const prompts: string[] = [];
    let next = reply;
    const settings = ServerSettingsService.layerTest({ commandAssist: rows(true, true) });
    return Effect.gen(function* () {
      const assist = yield* CommandAssist.CommandAssist;
      const childPhase = yield* Ref.make("在跑");
      const opened = yield* assist.observe(facts({ opened: true }));
      assert.strictEqual(opened.called, true);
      assert.strictEqual(opened.drift, "碰了不该碰的");
      const again = yield* assist.observe(facts({ opened: true }));
      assert.strictEqual(again.called, false);
      yield* TestClock.adjust("1 hour");
      const later = yield* assist.observe(facts());
      assert.strictEqual(later.called, false);
      assert.strictEqual(prompts.length, 1);

      yield* assist.markDriftFalsePositive(threadId);
      const suppressed = yield* assist.observe(facts({ opened: true }));
      assert.strictEqual(suppressed.called, false);
      assert.strictEqual(suppressed.drift, null);
      assert.strictEqual(prompts.length, 1);

      next = JSON.stringify({ activity: "在改 b.ts", drift: "又走偏了", outlook: "会改 2 个文件" });
      const changed = yield* assist.observe(facts({ opened: true, goal: "换成别的目标" }));
      assert.strictEqual(changed.called, true);
      assert.strictEqual(changed.drift, "又走偏了");
      assert.strictEqual(changed.outlook, "会改 2 个文件");
      assert.strictEqual(changed.childPhase, yield* Ref.get(childPhase));
    }).pipe(
      Effect.provide(
        harness(
          {
            complete: (input) => {
              prompts.push(input.prompt);
              return Effect.succeed(next);
            },
          },
          settings,
        ),
      ),
    );
  },
);

it.effect("leaves the previous sentences when the reply is not the activity object", () => {
  const settings = ServerSettingsService.layerTest({ commandAssist: rows(true, true) });
  let next = JSON.stringify({
    activity: "在改 b.ts",
    drift: "又走偏了",
    outlook: "会改 2 个文件",
  });
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    yield* assist.observe(facts({ opened: true, threadId: ThreadId.make("thread-parse") }));
    next = "not json";
    const failed = yield* assist.observe(
      facts({ opened: true, goal: "再换一个目标", threadId: ThreadId.make("thread-parse") }),
    );
    assert.strictEqual(failed.called, true);
    assert.strictEqual(failed.outlook, "会改 2 个文件");
    assert.strictEqual(failed.activity, "在改 b.ts");
    assert.strictEqual(failed.drift, "又走偏了");
    assert.strictEqual(failed.childPhase, "在跑");
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: () => Effect.succeed(next),
        },
        settings,
      ),
    ),
  );
});

it.effect("drift reads the goal and avoid list stored at dispatch", () => {
  const prompts: string[] = [];
  const settings = ServerSettingsService.layerTest({ commandAssist: rows(true, true) });
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    const thread = ThreadId.make("thread-baseline");
    yield* assist.rememberDispatch({
      threadId: thread,
      goal: "修复解析器的回退逻辑",
      avoid: "锁那一层不许碰",
      testCommands: null,
    });
    yield* assist.observe(
      facts({ opened: true, threadId: thread, goal: "在改 parser.ts", avoid: "" }),
    );
    const prompt = prompts[0] ?? "";
    assert.ok(prompt.includes("修复解析器的回退逻辑"));
    assert.ok(prompt.includes("锁那一层不许碰"));
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: (input) => {
            prompts.push(input.prompt);
            return Effect.succeed(reply);
          },
        },
        settings,
      ),
    ),
  );
});

it.effect("clears outlook when the model fails and leaves the child phase alone", () => {
  const settings = ServerSettingsService.layerTest({ commandAssist: rows(true, true) });
  let fail = false;
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    const childPhase = yield* Ref.make("在跑");
    const thread = ThreadId.make("thread-fail");
    const first = yield* assist.observe(facts({ opened: true, threadId: thread }));
    assert.strictEqual(first.outlook, "会改 1 个文件");
    fail = true;
    const failed = yield* assist.observe(
      facts({ opened: true, goal: "再换一个目标", threadId: thread }),
    );
    assert.strictEqual(failed.called, true);
    assert.strictEqual(failed.outlook, null);
    assert.strictEqual(failed.childPhase, "在跑");
    assert.strictEqual(yield* Ref.get(childPhase), "在跑");
    assert.strictEqual((yield* assist.read(thread)).outlook, null);
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: () => (fail ? Effect.fail({ reason: "调用失败" }) : Effect.succeed(reply)),
        },
        settings,
      ),
    ),
  );
});

it.effect(
  "clears outlook when the model exceeds 15 seconds and leaves the child phase alone",
  () => {
    const settings = ServerSettingsService.layerTest({ commandAssist: rows(true, true) });
    let wait = false;
    return Effect.gen(function* () {
      const assist = yield* CommandAssist.CommandAssist;
      const childPhase = yield* Ref.make("在跑");
      const thread = ThreadId.make("thread-timeout");
      const first = yield* assist.observe(facts({ opened: true, threadId: thread }));
      assert.strictEqual(first.outlook, "会改 1 个文件");
      wait = true;
      const fiber = yield* assist
        .observe(
          facts({ opened: true, goal: "再换一个目标", threadId: thread, childPhase: "在跑" }),
        )
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(COMMAND_ASSIST_TIMEOUT_MS));
      const failed = yield* Fiber.join(fiber);
      assert.strictEqual(failed.called, true);
      assert.strictEqual(failed.outlook, null);
      assert.strictEqual(failed.childPhase, "在跑");
      assert.strictEqual(yield* Ref.get(childPhase), "在跑");
      assert.strictEqual((yield* assist.read(thread)).outlook, null);
    }).pipe(
      Effect.provide(
        harness(
          {
            complete: () =>
              wait
                ? Effect.sleep(Duration.millis(COMMAND_ASSIST_TIMEOUT_MS + 1_000)).pipe(
                    Effect.as("late"),
                  )
                : Effect.succeed(reply),
          },
          settings,
        ),
      ),
    );
  },
);

it.effect("keeps a false-positive mark written while observe is calling the model", () => {
  const gate: {
    started: Deferred.Deferred<void> | undefined;
    release: Deferred.Deferred<void> | undefined;
  } = { started: undefined, release: undefined };
  return Effect.gen(function* () {
    gate.started = yield* Deferred.make<void>();
    gate.release = yield* Deferred.make<void>();
    const assist = yield* CommandAssist.CommandAssist;
    const thread = ThreadId.make("thread-race");
    const fiber = yield* assist
      .observe(facts({ opened: true, threadId: thread }))
      .pipe(Effect.forkChild);
    yield* Deferred.await(gate.started);
    yield* assist.rememberDispatch({
      threadId: thread,
      goal: "别覆盖我",
      avoid: null,
      testCommands: ["vp test run parser"],
    });
    yield* assist.markDriftFalsePositive(thread);
    yield* Deferred.succeed(gate.release, undefined);
    const result = yield* Fiber.join(fiber);
    const stored = yield* assist.read(thread);
    assert.strictEqual(stored.falsePositiveKey, stored.cacheKey);
    assert.ok(stored.falsePositiveKey !== null);
    assert.strictEqual(stored.goal, "别覆盖我");
    assert.deepStrictEqual(stored.testCommands, ["vp test run parser"]);
    assert.strictEqual(result.drift, null);
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: () => {
            const started = gate.started;
            const release = gate.release;
            if (started === undefined || release === undefined) {
              return Effect.die("observe gate was not ready");
            }
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(reply),
            );
          },
        },
        ServerSettingsService.layerTest({ commandAssist: rows(true, true) }),
      ),
    ),
  );
});

it.effect(
  "reads a fenced reply as sentences and writes 没核对成 when hand-back is not that object",
  () => {
    const fence = (body: string) => "```json\n" + body + "\n```";
    const settings = ServerSettingsService.layerTest({
      commandAssist: rows(true, true, false, true, true),
    });
    return Effect.gen(function* () {
      const assist = yield* CommandAssist.CommandAssist;
      const thread = ThreadId.make("thread-fence");
      const observed = yield* assist.observe(facts({ opened: true, threadId: thread }));
      assert.strictEqual(observed.activity, "在改 a.ts");
      assert.strictEqual(observed.outlook, "会改 1 个文件");
      const tidied = yield* assist.tidy({
        threadId: thread,
        projectId: null,
        cwd: "/repo",
        text: "把解析修好",
      });
      assert.strictEqual(tidied.goal, "修好解析");
      assert.strictEqual(tidied.done, "");
      yield* assist.rememberDispatch({
        threadId: thread,
        goal: "修好解析",
        avoid: null,
        testCommands: ["vp test run parser"],
      });
      const checked = yield* assist.handback({
        threadId: thread,
        projectId: null,
        cwd: "/repo",
        prExists: true,
        headOnBranch: true,
        report: "vp test run parser",
        childPhase: "做完",
      });
      assert.strictEqual(checked._tag, "completed");
      if (checked._tag === "completed") {
        assert.ok(checked.text.includes("不是同一件事：改的是锁"));
        assert.ok(!checked.text.includes("```"));
        assert.ok(!checked.text.includes('{"answer"'));
      }
      const stored = yield* assist.read(thread);
      assert.ok(stored.handback?.includes("不是同一件事：改的是锁"));
      const broken = yield* assist.handback({
        threadId: thread,
        projectId: null,
        cwd: "/repo",
        prExists: true,
        headOnBranch: true,
        report: "vp test run parser 第二遍",
        childPhase: "做完",
      });
      assert.strictEqual(broken._tag, "completed");
      if (broken._tag === "completed") {
        assert.ok(broken.text.includes("没核对成"));
        assert.ok(!broken.text.includes("not-json"));
      }
    }).pipe(
      Effect.provide(
        harness(
          {
            complete: (input) => {
              if (input.prompt.startsWith("ASK")) {
                return Effect.succeed(fence(reply));
              }
              if (input.prompt.includes("goal") && input.prompt.includes("第二遍")) {
                return Effect.succeed("not-json");
              }
              if (input.prompt.includes('{"answer"')) {
                return Effect.succeed(fence(JSON.stringify({ answer: "否", reason: "改的是锁" })));
              }
              return Effect.succeed(fence(JSON.stringify({ goal: "修好解析" })));
            },
          },
          settings,
        ),
      ),
    );
  },
);

it.effect("recomputes on 20 more steps or the first silence of the run, not on a clock", () => {
  const prompts: string[] = [];
  const settings = ServerSettingsService.layerTest({ commandAssist: rows(true, true) });
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    assert.strictEqual((yield* assist.observe(facts({ stepCount: 19 }))).called, false);
    assert.strictEqual((yield* assist.observe(facts({ stepCount: 20 }))).called, true);
    assert.strictEqual((yield* assist.observe(facts({ stepCount: 39 }))).called, false);
    assert.strictEqual((yield* assist.observe(facts({ stepCount: 40 }))).called, true);
    yield* TestClock.adjust("1 hour");
    assert.strictEqual((yield* assist.observe(facts({ stepCount: 40 }))).called, false);
    assert.strictEqual(
      (yield* assist.observe(facts({ silence: true, stepCount: 40 }))).called,
      true,
    );
    assert.strictEqual(
      (yield* assist.observe(facts({ silence: true, stepCount: 40 }))).called,
      false,
    );
    assert.strictEqual(
      (yield* assist.observe(facts({ silence: true, stepCount: 40, runId: "run-2" }))).called,
      true,
    );
    assert.strictEqual(prompts.length, 4);
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: (input) => {
            prompts.push(input.prompt);
            return Effect.succeed(JSON.stringify({ activity: "在改 a.ts" }));
          },
        },
        settings,
      ),
    ),
  );
});

it.effect("keeps the sentence that was written when the other one is missing", () => {
  const replies = [
    JSON.stringify({ activity: "在改 a.ts", drift: "碰了不该碰的" }),
    JSON.stringify({ activity: "在改 b.ts" }),
  ];
  const settings = ServerSettingsService.layerTest({ commandAssist: rows(true, true) });
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    const first = yield* assist.observe(facts({ opened: true }));
    const second = yield* assist.observe(facts({ opened: true, goal: "下一个目标" }));
    assert.strictEqual(first.drift, "碰了不该碰的");
    assert.strictEqual(second.activity, "在改 b.ts");
    assert.strictEqual(second.drift, "碰了不该碰的");
    assert.strictEqual(replies.length, 0);
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: () => Effect.succeed(replies.shift() ?? "{}"),
        },
        settings,
      ),
    ),
  );
});

it.effect("checks the stored commands without a model, and does not judge without a goal", () => {
  const prompts: string[] = [];
  const settings = ServerSettingsService.layerTest({
    commandAssist: rows(true, true, false, true),
  });
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    const childPhase = yield* Ref.make("做完");
    yield* assist.rememberDispatch({
      threadId,
      goal: null,
      avoid: null,
      testCommands: null,
    });
    const missing = yield* assist.handback({
      threadId,
      projectId: null,
      cwd: "/repo",
      prExists: false,
      headOnBranch: null,
      report: "我跑了测试",
      childPhase: "做完",
    });
    assert.strictEqual(missing._tag, "completed");
    if (missing._tag === "completed") {
      assert.ok(missing.text.includes("没有给测试基准"));
      assert.ok(missing.text.includes("没有目标，没做这句判断"));
      assert.ok(!missing.text.includes("对得上"));
      assert.ok(!missing.text.includes("绿"));
    }
    assert.strictEqual(prompts.length, 0);

    yield* assist.rememberDispatch({
      threadId,
      goal: null,
      avoid: "别改锁",
      testCommands: ["vp test run parser"],
    });
    const noGoal = yield* assist.handback({
      threadId,
      projectId: null,
      cwd: "/repo",
      prExists: true,
      headOnBranch: true,
      report: "vp test run parser",
      childPhase: "做完",
    });
    assert.strictEqual(noGoal._tag, "completed");
    if (noGoal._tag === "completed") {
      assert.ok(noGoal.text.includes("没有目标，没做这句判断"));
      assert.ok(noGoal.text.includes("对得上"));
      assert.ok(!noGoal.text.includes("绿"));
    }
    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(yield* Ref.get(childPhase), "做完");
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: (input) => {
            prompts.push(input.prompt);
            return Effect.succeed("是一件事");
          },
        },
        settings,
      ),
    ),
  );
});

it.effect("writes a failed hand-back without blocking the pull request or the child", () => {
  const settings = ServerSettingsService.layerTest({
    commandAssist: rows(true, true, false, true),
  });
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    const childPhase = yield* Ref.make("做完");
    yield* assist.rememberDispatch({
      threadId: ThreadId.make("thread-handback"),
      goal: "修好解析",
      avoid: null,
      testCommands: ["vp test run parser"],
    });
    const fiber = yield* assist
      .handback({
        threadId: ThreadId.make("thread-handback"),
        projectId: null,
        cwd: "/repo",
        prExists: true,
        headOnBranch: false,
        report: "没有写命令",
        childPhase: "做完",
      })
      .pipe(Effect.forkChild);
    const opened = yield* Effect.succeed("pr-opened");
    assert.strictEqual(opened, "pr-opened");
    yield* TestClock.adjust(Duration.millis(COMMAND_ASSIST_TIMEOUT_MS));
    const result = yield* Fiber.join(fiber);
    assert.deepStrictEqual(result, { _tag: "failed", reason: "超时" });
    const stored = yield* assist.read(ThreadId.make("thread-handback"));
    assert.ok(stored.handback?.includes("没核对成"));
    assert.ok(stored.handback?.includes("头提交不在该分支"));
    assert.ok(stored.handback?.includes("回报里没有：vp test run parser"));
    assert.ok(!stored.handback?.includes("绿"));
    assert.strictEqual(yield* Ref.get(childPhase), "做完");
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: () =>
            Effect.sleep(Duration.millis(COMMAND_ASSIST_TIMEOUT_MS + 1_000)).pipe(
              Effect.as("late"),
            ),
        },
        settings,
      ),
    ),
  );
});

it.effect("tidies only when asked and leaves blank fields blank", () => {
  const settings = ServerSettingsService.layerTest({
    commandAssist: rows(true, true, false, false, true),
  });
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    const childPhase = yield* Ref.make("在跑");
    yield* assist.observe(facts({ opened: true }));
    const before = yield* assist.read(threadId);
    assert.strictEqual(before.speechGoal, "");
    const tidied = yield* assist.tidy({
      threadId,
      projectId: null,
      cwd: "/repo",
      text: "把解析修好，别动锁",
    });
    assert.strictEqual(tidied.goal, "修好解析");
    assert.strictEqual(tidied.done, "");
    assert.strictEqual(tidied.avoid, "");
    assert.strictEqual(tidied.tests, "");
    assert.strictEqual(tidied.note, null);
    assert.strictEqual(tidied.original, "把解析修好，别动锁");
    assert.strictEqual(yield* Ref.get(childPhase), "在跑");
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: (input) =>
            input.prompt.startsWith("ASK")
              ? Effect.succeed(JSON.stringify({ activity: "在改 a.ts" }))
              : Effect.succeed(JSON.stringify({ goal: "修好解析" })),
        },
        settings,
      ),
    ),
  );
});

it.effect("tidy reports skipped without calling the model, and failed with a reason code", () => {
  const settings = ServerSettingsService.layerTest({
    commandAssist: rows(false, false, false, false, false),
  });
  const { calls, model } = countingModel((input) =>
    input.prompt.includes("慢")
      ? Effect.sleep(Duration.millis(COMMAND_ASSIST_TIMEOUT_MS + 1_000)).pipe(Effect.as("late"))
      : Effect.fail({ reason: "Provider exploded in English detail" }),
  );
  const speechOn = rows(false, false, false, false, true);
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    const settingsService = yield* ServerSettingsService.ServerSettingsService;

    const off = yield* assist.tidy({
      threadId,
      projectId: null,
      cwd: "/repo",
      text: "把解析修好",
    });
    assert.strictEqual(off.result._tag, "skipped");
    assert.strictEqual(off.note, "跳过");
    assert.strictEqual(off.goal, "");
    assert.strictEqual(calls.complete, 0);
    assert.strictEqual((yield* assist.read(threadId)).speechNote, "跳过");

    yield* settingsService.updateSettings({ commandAssist: speechOn });
    const failed = yield* assist.tidy({
      threadId,
      projectId: null,
      cwd: "/repo",
      text: "把解析修好",
    });
    assert.deepStrictEqual(failed.result, { _tag: "failed", reason: "调用失败" });
    assert.strictEqual(failed.note, "没整理成");
    assert.strictEqual(calls.complete, 1);

    const slow = yield* assist
      .tidy({ threadId, projectId: null, cwd: "/repo", text: "慢" })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.millis(COMMAND_ASSIST_TIMEOUT_MS));
    const timedOut = yield* Fiber.join(slow);
    assert.deepStrictEqual(timedOut.result, { _tag: "failed", reason: "超时" });
    assert.strictEqual(timedOut.note, "没整理成");
    assert.strictEqual(timedOut.original, "慢");
  }).pipe(Effect.provide(harness(model, settings)));
});

it.effect("calls the model once when two observes share an input", () => {
  const gate: {
    started: Deferred.Deferred<void> | undefined;
    release: Deferred.Deferred<void> | undefined;
    calls: number;
  } = { started: undefined, release: undefined, calls: 0 };
  return Effect.gen(function* () {
    gate.started = yield* Deferred.make<void>();
    gate.release = yield* Deferred.make<void>();
    gate.calls = 0;
    const assist = yield* CommandAssist.CommandAssist;
    const input = facts({ opened: true, threadId: ThreadId.make("thread-once") });
    const first = yield* assist.observe(input).pipe(Effect.forkChild);
    yield* Deferred.await(gate.started);
    const second = yield* assist.observe(input).pipe(Effect.forkChild);
    yield* Deferred.succeed(gate.release, undefined);
    const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
    assert.strictEqual(gate.calls, 1);
    assert.strictEqual(results.filter((result) => result.called).length, 1);
  }).pipe(
    Effect.provide(
      harness(
        {
          complete: () => {
            gate.calls += 1;
            const started = gate.started;
            const release = gate.release;
            if (started === undefined || release === undefined) {
              return Effect.die("observe gate was not ready");
            }
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(JSON.stringify({ activity: "在改 a.ts", outlook: "一句" })),
            );
          },
        },
        ServerSettingsService.layerTest({ commandAssist: rows(true, true) }),
      ),
    ),
  );
});

it.effect(
  "sends one patrol message for one drift or one silence, and none while the row is off",
  () => {
    const settings = ServerSettingsService.layerTest({ commandAssist: rows(true, true, false) });
    return Effect.gen(function* () {
      const assist = yield* CommandAssist.CommandAssist;
      const settingsService = yield* ServerSettingsService.ServerSettingsService;
      const quiet = yield* assist.considerPatrol({
        threadId,
        projectId: null,
        runId: "run-1",
        kind: "drift",
        driftKey: "key-a",
        block: null,
      });
      assert.deepStrictEqual(quiet, { sent: false, text: null });
      yield* settingsService.updateSettings({ commandAssist: rows(true, true, true) });
      const blocked = yield* assist.considerPatrol({
        threadId,
        projectId: null,
        runId: "run-1",
        kind: "drift",
        driftKey: "key-a",
        block: "queued",
      });
      assert.strictEqual(blocked.sent, false);
      for (const block of ["waiting", "command", "done", "failed", "review"] as const) {
        const skipped = yield* assist.considerPatrol({
          threadId,
          projectId: null,
          runId: "run-1",
          kind: "silence",
          driftKey: "key-a",
          block,
        });
        assert.strictEqual(skipped.sent, false);
      }
      const first = yield* assist.considerPatrol({
        threadId,
        projectId: null,
        runId: "run-1",
        kind: "drift",
        driftKey: "key-a",
        block: null,
      });
      const repeat = yield* assist.considerPatrol({
        threadId,
        projectId: null,
        runId: "run-1",
        kind: "drift",
        driftKey: "key-a",
        block: null,
      });
      const next = yield* assist.considerPatrol({
        threadId,
        projectId: null,
        runId: "run-1",
        kind: "drift",
        driftKey: "key-b",
        block: null,
      });
      const silence = yield* assist.considerPatrol({
        threadId,
        projectId: null,
        runId: "run-1",
        kind: "silence",
        driftKey: "key-b",
        block: null,
      });
      yield* TestClock.adjust("1 hour");
      const silenceAgain = yield* assist.considerPatrol({
        threadId,
        projectId: null,
        runId: "run-1",
        kind: "silence",
        driftKey: "key-b",
        block: null,
      });
      assert.deepStrictEqual(first, { sent: true, text: "可能走偏" });
      assert.strictEqual(repeat.sent, false);
      assert.deepStrictEqual(next, { sent: true, text: "可能走偏" });
      assert.deepStrictEqual(silence, { sent: true, text: "没动静" });
      assert.strictEqual(silenceAgain.sent, false);
    }).pipe(
      Effect.provide(
        harness(
          {
            complete: () => Effect.die("patrol does not call a model"),
          },
          settings,
        ),
      ),
    );
  },
);
