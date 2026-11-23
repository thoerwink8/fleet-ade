import { assert, it } from "@effect/vitest";
import {
  COMMAND_ASSIST_TIMEOUT_MS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  type ThreadTitleGenerationInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettingsService from "../serverSettings.ts";
import * as CommandAssist from "./CommandAssist.ts";
import type { CommandAssistRunResult } from "./CommandAssist.ts";

const projectId = ProjectId.make("project-assist");
const projectOff = ProjectId.make("project-off");
const named = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "name-model",
};

const layerFor = (
  model: CommandAssist.CommandAssistModel["Service"],
  settings: Layer.Layer<ServerSettingsService.ServerSettingsService> = ServerSettingsService.layerTest(
    {},
  ),
) =>
  CommandAssist.layer.pipe(
    Layer.provide(Layer.succeed(CommandAssist.CommandAssistModel, model)),
    Layer.provide(settings),
  );

const countingModel = (complete: CommandAssist.CommandAssistModel["Service"]["complete"]) => {
  const calls = { complete: 0, title: 0 };
  const model: CommandAssist.CommandAssistModel["Service"] = {
    complete: (input) => {
      calls.complete += 1;
      return complete(input);
    },
    title: (input: ThreadTitleGenerationInput) => {
      calls.title += 1;
      return Effect.succeed({ title: input.message });
    },
  };
  return { calls, model };
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
    assert.strictEqual(calls.title, 0);
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
      layerFor({
        complete: (input) =>
          input.prompt === "drift"
            ? Effect.fail({ reason: "调用失败" })
            : Effect.succeed("在改解析器"),
        title: () => Effect.die("naming uses the existing title generator"),
      }),
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
      layerFor({
        complete: () =>
          Effect.sleep(Duration.millis(COMMAND_ASSIST_TIMEOUT_MS + 1_000)).pipe(Effect.as("late")),
        title: () => Effect.die("unused"),
      }),
    ),
  ),
);

it.effect("names through the existing title generator and the naming cell", () => {
  const seen: Array<string> = [];
  return Effect.gen(function* () {
    const assist = yield* CommandAssist.CommandAssist;
    const namedResult = yield* assist.run("naming", {
      projectId,
      cwd: "/repo",
      prompt: "修解析器",
    });
    const skipped = yield* assist.run("naming", {
      projectId: projectOff,
      cwd: "/repo",
      prompt: "另一条",
    });
    assert.deepStrictEqual(namedResult, { _tag: "completed", text: "修解析器" });
    assert.deepStrictEqual(skipped, { _tag: "skipped", reason: "off" });
    assert.deepStrictEqual(seen, [named.model]);
  }).pipe(
    Effect.provide(
      layerFor(
        {
          complete: () => Effect.die("naming does not use the plain assist call"),
          title: (input) => {
            seen.push(input.modelSelection.model);
            return Effect.succeed({ title: input.message });
          },
        },
        ServerSettingsService.layerTest({
          commandAssist: {
            ...DEFAULT_SERVER_SETTINGS.commandAssist,
            naming: { enabled: true, modelSelection: named },
          },
          projectSettingsOverrides: {
            [projectOff]: {
              commandAssist: {
                naming: { enabled: false, modelSelection: null },
              },
            },
          },
        }),
      ),
    ),
  );
});
