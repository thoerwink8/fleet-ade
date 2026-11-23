import {
  COMMAND_ASSIST_TIMEOUT_MS,
  type CommandAssistLookup,
  lookupCommandAssistRow,
  type ModelSelection,
  type ProjectId,
  type ThreadTitleGenerationInput,
} from "@t3tools/contracts";
import { resolveCommandAssist } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

const REASON_LIMIT = 200;

export interface CommandAssistRunInput {
  readonly projectId: ProjectId | null;
  readonly cwd: string;
  readonly prompt: string;
}

export type CommandAssistRunResult =
  | { readonly _tag: "skipped"; readonly reason: "off" | "no-model" | "unknown" }
  | { readonly _tag: "failed"; readonly reason: string }
  | { readonly _tag: "completed"; readonly text: string };

export interface CommandAssistCompletion {
  readonly model: ModelSelection;
  readonly projectId: ProjectId | null;
  readonly cwd: string;
  readonly prompt: string;
}

export class CommandAssistModel extends Context.Service<
  CommandAssistModel,
  {
    readonly complete: (
      input: CommandAssistCompletion,
    ) => Effect.Effect<string, { readonly reason: string }>;
    readonly title: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<{ readonly title: string }, { readonly reason: string }>;
  }
>()("t3/orchestration-v2/CommandAssistModel") {}

function clipReason(reason: string): string {
  const line = reason.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const clipped = Array.from(line).slice(0, REASON_LIMIT).join("");
  return clipped.length > 0 ? clipped : "调用失败";
}

function failed(reason: string): CommandAssistRunResult {
  return { _tag: "failed", reason: clipReason(reason) };
}

function failureReason(error: unknown): string {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const reason = error.reason;
    if (typeof reason === "string") return clipReason(reason);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TimeoutError"
  ) {
    return "超时";
  }
  return "调用失败";
}

const makeModel = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const complete: CommandAssistModel["Service"]["complete"] = Effect.fn(
    "CommandAssistModel.complete",
  )(function* (input) {
    const generatePlainText = textGeneration.generatePlainText;
    if (generatePlainText === undefined) {
      return yield* Effect.fail({ reason: "调用失败" });
    }
    return yield* generatePlainText(input).pipe(
      Effect.map((result) => result.text),
      Effect.mapError((error) => ({ reason: clipReason(error.detail) })),
    );
  });
  const title: CommandAssistModel["Service"]["title"] = Effect.fn("CommandAssistModel.title")(
    function* (input) {
      return yield* textGeneration
        .generateThreadTitle(input)
        .pipe(Effect.mapError((error) => ({ reason: clipReason(error.detail) })));
    },
  );
  return CommandAssistModel.of({ complete, title });
});

export const layerModel = Layer.effect(CommandAssistModel, makeModel);

export class CommandAssist extends Context.Service<
  CommandAssist,
  {
    /** Looks up one assist row. A failure is a value, so callers can ignore it. */
    readonly run: (
      step: string,
      input: CommandAssistRunInput,
    ) => Effect.Effect<CommandAssistRunResult>;
  }
>()("t3/orchestration-v2/CommandAssist") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const model = yield* CommandAssistModel;

  const invoke = Effect.fn("CommandAssist.invoke")(function* (
    step: string,
    selection: ModelSelection,
    input: CommandAssistRunInput,
  ) {
    // The limit is a constant so a slow reply cannot stall dispatch or opening a PR.
    const effect =
      step === "naming"
        ? model
            .title({
              cwd: input.cwd,
              message: input.prompt,
              modelSelection: selection,
              projectId: input.projectId,
            })
            .pipe(Effect.map((result) => result.title))
        : model.complete({
            model: selection,
            projectId: input.projectId,
            cwd: input.cwd,
            prompt: input.prompt,
          });
    return yield* effect.pipe(
      Effect.timeout(Duration.millis(COMMAND_ASSIST_TIMEOUT_MS)),
      Effect.match({
        onFailure: (error) => failed(failureReason(error)),
        onSuccess: (text) => ({ _tag: "completed" as const, text }),
      }),
    );
  });

  const run: CommandAssist["Service"]["run"] = Effect.fn("CommandAssist.run")(
    function* (step, input) {
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      if (settings === null) return failed("调用失败");
      const resolved = resolveCommandAssist(settings, input.projectId);
      const lookup: CommandAssistLookup = lookupCommandAssistRow(
        resolved.rows,
        step,
        resolved.textGeneration,
      );
      if (lookup._tag === "skipped") return lookup;
      return yield* invoke(step, lookup.model, input);
    },
  );

  return CommandAssist.of({ run });
});

export const layer = Layer.effect(CommandAssist, make);
