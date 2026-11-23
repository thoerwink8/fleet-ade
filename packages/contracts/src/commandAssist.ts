import * as Schema from "effect/Schema";

import { ModelSelection as ModelSelectionSchema } from "./modelSelection.ts";
import type { ModelSelection } from "./modelSelection.ts";

/** Fixed. Not a setting: a larger limit would let an assist call hold up dispatch. */
export const COMMAND_ASSIST_TIMEOUT_MS = 15_000;

/** File edits plus commands since the last summary call. Not a clock. */
export const COMMAND_ASSIST_STEP_BURST = 20;

/** Goal and avoid together, before they are sent. */
export const COMMAND_ASSIST_INPUT_LIMIT = 2_000;

export const HAND_BACK_NO_BASELINE = "没有给测试基准";
export const HAND_BACK_NO_GOAL = "没有目标，没做这句判断";
export const HAND_BACK_FAILED = "没核对成";
export const HAND_BACK_ALIGNED = "对得上";

const COMMAND_ASSIST_STEPS = [
  "naming",
  "activity",
  "drift",
  "handback",
  "speech",
  "patrol",
] as const;
export const CommandAssistStep = Schema.Literals(COMMAND_ASSIST_STEPS);
export type CommandAssistStep = typeof CommandAssistStep.Type;

const KNOWN_STEPS: ReadonlySet<string> = new Set(COMMAND_ASSIST_STEPS);

function isCommandAssistStep(step: string): step is CommandAssistStep {
  return KNOWN_STEPS.has(step);
}

/** One cell. An empty model uses `textGenerationModelSelection`. */
export const CommandAssistRow = Schema.Struct({
  enabled: Schema.Boolean,
  modelSelection: Schema.NullOr(ModelSelectionSchema),
});
export type CommandAssistRow = typeof CommandAssistRow.Type;

function defaultCommandAssistRow(step: CommandAssistStep): CommandAssistRow {
  return {
    enabled: step === "naming",
    modelSelection: null,
  };
}

export function defaultCommandAssistRows(): Record<CommandAssistStep, CommandAssistRow> {
  return {
    naming: defaultCommandAssistRow("naming"),
    activity: defaultCommandAssistRow("activity"),
    drift: defaultCommandAssistRow("drift"),
    handback: defaultCommandAssistRow("handback"),
    speech: defaultCommandAssistRow("speech"),
    patrol: defaultCommandAssistRow("patrol"),
  };
}

/** Stored rows, including step ids this build does not run. */
export const CommandAssistRows = Schema.Record(Schema.String, CommandAssistRow);
export type CommandAssistRows = typeof CommandAssistRows.Type;

export function fillCommandAssistRows(
  rows: Readonly<Record<string, CommandAssistRow>> | undefined,
): Record<string, CommandAssistRow> {
  return {
    ...defaultCommandAssistRows(),
    ...rows,
  };
}

export type CommandAssistLookup =
  | { readonly _tag: "skipped"; readonly reason: "unknown" | "off" | "no-model" }
  | { readonly _tag: "ready"; readonly model: ModelSelection };

/** Unknown ids are kept in settings and are not run. An empty model uses text generation. */
export function lookupCommandAssistRow(
  rows: Readonly<Record<string, CommandAssistRow>>,
  step: string,
  textGeneration: ModelSelection | null,
): CommandAssistLookup {
  if (!isCommandAssistStep(step)) return { _tag: "skipped", reason: "unknown" };
  const row = fillCommandAssistRows(rows)[step] ?? defaultCommandAssistRow(step);
  if (!row.enabled) return { _tag: "skipped", reason: "off" };
  const model = row.modelSelection ?? textGeneration;
  if (model === null) return { _tag: "skipped", reason: "no-model" };
  return { _tag: "ready", model };
}
