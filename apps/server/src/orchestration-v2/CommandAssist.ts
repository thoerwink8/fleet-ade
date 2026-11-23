import {
  COMMAND_ASSIST_INPUT_LIMIT,
  COMMAND_ASSIST_STEP_BURST,
  COMMAND_ASSIST_TIMEOUT_MS,
  HAND_BACK_ALIGNED,
  HAND_BACK_FAILED,
  HAND_BACK_NO_BASELINE,
  HAND_BACK_NO_GOAL,
  type CommandAssistLookup,
  lookupCommandAssistRow,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveCommandAssist } from "@t3tools/shared/projectSettings";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
  }
>()("t3/orchestration-v2/CommandAssist/CommandAssistModel") {}

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

export type AssistBlock = "waiting" | "command" | "done" | "failed" | "review" | "queued" | null;

export interface CommandAssistFacts {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly cwd: string;
  readonly runId: string;
  readonly opened: boolean;
  readonly stepCount: number;
  readonly silence: boolean;
  readonly goal: string;
  readonly avoid: string;
  readonly activity: string;
  readonly files: readonly {
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }[];
  readonly latestCommand: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly childPhase: string;
}

export interface CommandAssistObservation {
  readonly called: boolean;
  readonly activity: string | null;
  readonly drift: string | null;
  readonly outlook: string | null;
  readonly childPhase: string;
}

export interface CommandAssistSpeech {
  readonly goal: string;
  readonly done: string;
  readonly avoid: string;
  readonly tests: string;
  readonly note: string | null;
  readonly original: string;
  readonly result: CommandAssistRunResult;
}

export interface CommandAssistPatrol {
  readonly sent: boolean;
  readonly text: string | null;
}

const nullableText = Schema.NullOr(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);

const StoredAssistSchema = Schema.Struct({
  cacheKey: nullableText,
  activity: nullableText,
  drift: nullableText,
  outlook: nullableText,
  falsePositiveKey: nullableText,
  handback: nullableText,
  speechGoal: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  speechDone: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  speechAvoid: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  speechTests: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  speechNote: nullableText,
  runId: nullableText,
  stepsAtLastCall: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  silenceSeen: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  patrolDriftKey: nullableText,
  patrolSilenceRun: nullableText,
  patrolCount: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  testCommands: Schema.NullOr(Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  goal: nullableText,
  avoid: nullableText,
});
type StoredAssist = typeof StoredAssistSchema.Type;

const StoredAssistJson = Schema.fromJsonString(StoredAssistSchema);
const decodeStored = Schema.decodeUnknownEffect(StoredAssistJson);
const encodeStored = Schema.encodeSync(StoredAssistJson);
const decodeAssistState = Schema.decodeSync(StoredAssistSchema);

function emptyState(): StoredAssist {
  return decodeAssistState({});
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function clipChars(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join("");
}

function clipFacts(input: CommandAssistFacts): {
  readonly goal: string;
  readonly avoid: string;
  readonly activity: string;
  readonly files: CommandAssistFacts["files"];
  readonly latestCommand: string | null;
  readonly additions: number;
  readonly deletions: number;
} {
  const goal = clipChars(input.goal, COMMAND_ASSIST_INPUT_LIMIT);
  const remain = COMMAND_ASSIST_INPUT_LIMIT - Array.from(goal).length;
  return {
    goal,
    avoid: remain > 0 ? clipChars(input.avoid, remain) : "",
    activity: input.activity,
    files: input.files.slice(0, 5),
    latestCommand: input.latestCommand,
    additions: input.additions,
    deletions: input.deletions,
  };
}

function factsKey(facts: ReturnType<typeof clipFacts>): string {
  return [
    facts.goal,
    facts.avoid,
    facts.activity,
    facts.files.map((file) => `${file.path}:${file.additions}:${file.deletions}`).join(","),
    facts.latestCommand ?? "",
    String(facts.additions),
    String(facts.deletions),
  ].join("\n");
}

function driftText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "否") return null;
  return trimmed;
}

function activityPrompt(
  facts: ReturnType<typeof clipFacts>,
  asks: { readonly activity: boolean; readonly drift: boolean; readonly outlook: boolean },
): string {
  const asked = [
    asks.activity ? "activity" : "",
    asks.drift ? "drift" : "",
    asks.outlook ? "outlook" : "",
  ].filter((part) => part.length > 0);
  const meanings = [
    asks.activity ? "activity: one sentence, what this work is doing now." : "",
    asks.drift
      ? "drift: null or 否 when it still matches the goal and the avoid list; otherwise one sentence why it drifted."
      : "",
    asks.outlook
      ? "outlook: which files would change, about how many lines, one sentence result, and where that differs from the goal."
      : "",
  ].filter((line) => line.length > 0);
  return [
    `ASK ${asked.join(" ")}`,
    "Reply with JSON only. No markdown. Include only the requested fields.",
    ...meanings,
    `goal:${facts.goal}`,
    `avoid:${facts.avoid}`,
    `activity:${facts.activity}`,
    `files:${facts.files.map((file) => `${file.path} +${file.additions}/-${file.deletions}`).join(",")}`,
    `command:${facts.latestCommand ?? ""}`,
    `lines:+${facts.additions}/-${facts.deletions}`,
  ].join("\n");
}

function handbackPrompt(goal: string, report: string): string {
  return [
    'Reply with JSON only: {"answer":"是"|"否","reason":""}.',
    "Question: are this report and the goal the same piece of work? answer is 是 or 否, and reason is one sentence. No other fields.",
    `goal:${goal}`,
    `report:${report}`,
  ].join("\n");
}

function speechPrompt(text: string): string {
  return [
    'Reply with JSON only: {"goal":"","done":"","avoid":"","tests":""}.',
    "Fill only what the person actually said. Leave a field as an empty string when they did not say it. Do not invent.",
    text,
  ].join("\n");
}

function handbackText(input: {
  readonly commands: readonly string[] | null;
  readonly prExists: boolean;
  readonly headOnBranch: boolean | null;
  readonly report: string;
  readonly goal: string | null;
}): { readonly text: string; readonly wantsModel: boolean } {
  const lines: string[] = [];
  const commands =
    input.commands?.map((command) => command.trim()).filter((command) => command.length > 0) ?? [];
  const hasBaseline = input.commands !== null && commands.length > 0;
  if (!hasBaseline) lines.push(HAND_BACK_NO_BASELINE);
  const missing = hasBaseline ? commands.filter((command) => !input.report.includes(command)) : [];
  const aligned =
    hasBaseline && missing.length === 0 && input.prExists && input.headOnBranch === true;
  if (hasBaseline && aligned) lines.push(HAND_BACK_ALIGNED);
  if (hasBaseline && !input.prExists) lines.push("PR 不存在");
  if (hasBaseline && input.headOnBranch === false) lines.push("头提交不在该分支");
  if (hasBaseline && input.headOnBranch === null) lines.push("头提交没查到");
  for (const command of missing) lines.push(`回报里没有：${command}`);
  const goal = input.goal?.trim() ?? "";
  if (goal.length === 0) lines.push(HAND_BACK_NO_GOAL);
  return {
    text: lines.join("\n"),
    wantsModel: hasBaseline && goal.length > 0,
  };
}

function parseSpeech(text: string): {
  readonly goal: string;
  readonly done: string;
  readonly avoid: string;
  readonly tests: string;
} | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const field = (key: string) => (typeof record[key] === "string" ? record[key] : "");
    return {
      goal: field("goal"),
      done: field("done"),
      avoid: field("avoid"),
      tests: field("tests"),
    };
  } catch {
    return null;
  }
}

function parseActivity(text: string): {
  readonly activity?: string;
  readonly drift?: string | null;
  readonly outlook?: string | null;
} | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.activity === "string" ? { activity: record.activity } : {}),
      ...(record.drift === null || typeof record.drift === "string"
        ? { drift: driftText(record.drift as string | null) }
        : {}),
      ...(record.outlook === null || typeof record.outlook === "string"
        ? { outlook: stringOrNull(record.outlook) }
        : {}),
    };
  } catch {
    return null;
  }
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
    return yield* generatePlainText({
      cwd: input.cwd,
      prompt: input.prompt,
      modelSelection: input.model,
      projectId: input.projectId,
    }).pipe(
      Effect.map((result) => result.text),
      Effect.mapError((error) => ({ reason: clipReason(error.detail) })),
    );
  });
  return CommandAssistModel.of({ complete });
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
    readonly observe: (input: CommandAssistFacts) => Effect.Effect<CommandAssistObservation>;
    readonly markDriftFalsePositive: (threadId: ThreadId) => Effect.Effect<void>;
    readonly rememberDispatch: (input: {
      readonly threadId: ThreadId;
      readonly goal: string | null;
      readonly avoid: string | null;
      readonly testCommands: readonly string[] | null;
    }) => Effect.Effect<void>;
    readonly handback: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId | null;
      readonly cwd: string;
      readonly prExists: boolean;
      readonly headOnBranch: boolean | null;
      readonly report: string;
      readonly childPhase: string;
    }) => Effect.Effect<CommandAssistRunResult>;
    readonly tidy: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId | null;
      readonly cwd: string;
      readonly text: string;
      readonly childPhase: string;
    }) => Effect.Effect<CommandAssistSpeech>;
    readonly considerPatrol: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId | null;
      readonly runId: string;
      readonly kind: "drift" | "silence";
      readonly driftKey: string;
      readonly block: AssistBlock;
    }) => Effect.Effect<CommandAssistPatrol>;
    readonly read: (threadId: ThreadId) => Effect.Effect<StoredAssist>;
  }
>()("t3/orchestration-v2/CommandAssist") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const model = yield* CommandAssistModel;
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const locks = yield* KeyedLock.make<ThreadId>();

  const cacheKey = Effect.fn("CommandAssist.cacheKey")(function* (
    facts: ReturnType<typeof clipFacts>,
  ) {
    const bytes = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(factsKey(facts)))
      .pipe(Effect.orDie);
    return Hex.encode(bytes);
  });

  const load = Effect.fn("CommandAssist.load")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ readonly stateJson: string }>`
      SELECT state_json AS stateJson FROM command_assist_state WHERE thread_id = ${threadId}
    `.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("command-assist.load-failed", { threadId, error }),
      ),
      Effect.orElseSucceed(() => [] as const),
    );
    const raw = rows[0]?.stateJson;
    if (raw === undefined) return emptyState();
    return yield* decodeStored(raw).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("command-assist.state-decode-failed", { threadId, error }),
      ),
      Effect.orElseSucceed(() => emptyState()),
    );
  });

  const save = Effect.fn("CommandAssist.save")(function* (threadId: ThreadId, state: StoredAssist) {
    const now = yield* Clock.currentTimeMillis;
    const updatedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
    yield* sql`
      INSERT INTO command_assist_state (thread_id, state_json, updated_at)
      VALUES (${threadId}, ${encodeStored(state)}, ${updatedAt})
      ON CONFLICT(thread_id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("command-assist.save-failed", { threadId, error }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
  });

  const invoke = Effect.fn("CommandAssist.invoke")(function* (
    selection: ModelSelection,
    input: CommandAssistRunInput,
  ) {
    // The limit is a constant so a slow reply cannot stall dispatch or opening a PR.
    const effect = model.complete({
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
      return yield* invoke(lookup.model, input);
    },
  );

  const visibleDrift = (state: StoredAssist, key: string | null) =>
    key !== null && state.falsePositiveKey === key ? null : state.drift;

  const observeTurn: CommandAssist["Service"]["observe"] = Effect.fn("CommandAssist.observe")(
    function* (input) {
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      const state = yield* load(input.threadId);
      const facts = clipFacts(input);
      const key = yield* cacheKey(facts);
      const runChanged = state.runId !== input.runId;
      const stepsAt = runChanged ? 0 : state.stepsAtLastCall;
      const silenceSeen = runChanged ? false : state.silenceSeen;
      const cached = !runChanged && state.cacheKey === key;
      const shouldCall =
        (input.opened && !cached) ||
        input.stepCount - stepsAt >= COMMAND_ASSIST_STEP_BURST ||
        (input.silence && !silenceSeen);
      const show = (next: StoredAssist): CommandAssistObservation => ({
        called: false,
        activity: next.activity,
        drift: visibleDrift(next, next.cacheKey),
        outlook: next.outlook,
        childPhase: input.childPhase,
      });
      if (settings === null) return show(state);
      const resolved = resolveCommandAssist(settings, input.projectId);
      const activity = lookupCommandAssistRow(resolved.rows, "activity", resolved.textGeneration);
      const drift = lookupCommandAssistRow(resolved.rows, "drift", resolved.textGeneration);
      const asks = {
        activity: activity._tag === "ready",
        drift: drift._tag === "ready",
        outlook: activity._tag === "ready",
      };
      if ((!asks.activity && !asks.drift) || !shouldCall) {
        const kept = {
          ...state,
          runId: input.runId,
          silenceSeen: silenceSeen || input.silence,
          stepsAtLastCall: runChanged ? 0 : state.stepsAtLastCall,
        };
        yield* save(input.threadId, kept);
        return show(kept);
      }
      const selection =
        asks.activity && activity._tag === "ready"
          ? activity.model
          : drift._tag === "ready"
            ? drift.model
            : null;
      if (selection === null) return show(state);
      const reserved = {
        ...state,
        runId: input.runId,
        silenceSeen: silenceSeen || input.silence,
        stepsAtLastCall: input.stepCount,
        cacheKey: key,
      };
      yield* save(input.threadId, reserved);
      const result = yield* invoke(selection, {
        projectId: input.projectId,
        cwd: input.cwd,
        prompt: activityPrompt(facts, asks),
      });
      const base = reserved;
      if (result._tag !== "completed") {
        const failedState = { ...base, outlook: asks.outlook ? null : state.outlook };
        yield* save(input.threadId, failedState);
        return { ...show(failedState), called: true };
      }
      const parsed = parseActivity(result.text);
      if (parsed === null) {
        return { ...show(base), called: true };
      }
      const next: StoredAssist = {
        ...base,
        cacheKey: key,
        activity:
          asks.activity && parsed !== null && parsed.activity !== undefined
            ? parsed.activity
            : state.activity,
        drift:
          asks.drift && parsed !== null && parsed.drift !== undefined ? parsed.drift : state.drift,
        outlook: asks.outlook
          ? parsed.outlook !== undefined
            ? parsed.outlook
            : state.outlook
          : state.outlook,
      };
      yield* save(input.threadId, next);
      return { ...show(next), called: true };
    },
  );

  const observe: CommandAssist["Service"]["observe"] = (input) =>
    locks.withLock(input.threadId, observeTurn(input));

  const markDriftFalsePositive: CommandAssist["Service"]["markDriftFalsePositive"] = Effect.fn(
    "CommandAssist.markDriftFalsePositive",
  )(function* (threadId) {
    const state = yield* load(threadId);
    yield* save(threadId, {
      ...state,
      falsePositiveKey: state.cacheKey,
      drift: null,
    });
  });

  const rememberDispatch: CommandAssist["Service"]["rememberDispatch"] = Effect.fn(
    "CommandAssist.rememberDispatch",
  )(function* (input) {
    const state = yield* load(input.threadId);
    yield* save(input.threadId, {
      ...state,
      goal: input.goal,
      avoid: input.avoid,
      testCommands: input.testCommands === null ? null : [...input.testCommands],
    });
  });

  const handback: CommandAssist["Service"]["handback"] = Effect.fn("CommandAssist.handback")(
    function* (input) {
      const state = yield* load(input.threadId);
      const query = handbackText({
        commands: state.testCommands,
        prExists: input.prExists,
        headOnBranch: input.headOnBranch,
        report: input.report,
        goal: state.goal,
      });
      if (!query.wantsModel) {
        yield* save(input.threadId, { ...state, handback: query.text });
        return { _tag: "completed", text: query.text };
      }
      const judged = yield* run("handback", {
        projectId: input.projectId,
        cwd: input.cwd,
        prompt: handbackPrompt(state.goal ?? "", input.report),
      });
      const text =
        judged._tag === "completed"
          ? `${query.text}\n${judged.text}`
          : judged._tag === "failed"
            ? `${query.text}\n${HAND_BACK_FAILED}`
            : query.text;
      yield* save(input.threadId, { ...state, handback: text });
      if (judged._tag === "failed") return judged;
      return { _tag: "completed", text };
    },
  );

  const tidy: CommandAssist["Service"]["tidy"] = Effect.fn("CommandAssist.tidy")(function* (input) {
    const original = input.text;
    const result = yield* run("speech", {
      projectId: input.projectId,
      cwd: input.cwd,
      prompt: speechPrompt(clipChars(original, COMMAND_ASSIST_INPUT_LIMIT)),
    });
    const state = yield* load(input.threadId);
    const empty = { goal: "", done: "", avoid: "", tests: "", note: "没整理成" as string | null };
    if (result._tag !== "completed") {
      yield* save(input.threadId, { ...state, ...speechOf(empty) });
      return { ...empty, original, result };
    }
    const parsed = parseSpeech(result.text) ?? empty;
    const note = parsed === empty ? "没整理成" : null;
    const speech = { ...parsed, note };
    yield* save(input.threadId, { ...state, ...speechOf(speech) });
    return { ...speech, original, result };
  });

  const considerPatrol: CommandAssist["Service"]["considerPatrol"] = Effect.fn(
    "CommandAssist.considerPatrol",
  )(function* (input) {
    if (input.block !== null) return { sent: false, text: null };
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return { sent: false, text: null };
    const resolved = resolveCommandAssist(settings, input.projectId);
    const row = lookupCommandAssistRow(resolved.rows, "patrol", resolved.textGeneration);
    if (row._tag !== "ready") return { sent: false, text: null };
    const state = yield* load(input.threadId);
    if (input.kind === "drift") {
      if (state.patrolDriftKey === input.driftKey) return { sent: false, text: null };
      yield* save(input.threadId, {
        ...state,
        patrolDriftKey: input.driftKey,
        patrolCount: state.patrolCount + 1,
      });
      return { sent: true, text: "可能走偏" };
    }
    if (state.patrolSilenceRun === input.runId) return { sent: false, text: null };
    yield* save(input.threadId, {
      ...state,
      patrolSilenceRun: input.runId,
      patrolCount: state.patrolCount + 1,
    });
    return { sent: true, text: "没动静" };
  });

  return CommandAssist.of({
    run,
    observe,
    markDriftFalsePositive,
    rememberDispatch,
    handback,
    tidy,
    considerPatrol,
    read: Effect.fn("CommandAssist.read")(function* (threadId: ThreadId) {
      return yield* load(threadId);
    }),
  });
});

function speechOf(speech: {
  readonly goal: string;
  readonly done: string;
  readonly avoid: string;
  readonly tests: string;
  readonly note: string | null;
}): Pick<StoredAssist, "speechGoal" | "speechDone" | "speechAvoid" | "speechTests" | "speechNote"> {
  return {
    speechGoal: speech.goal,
    speechDone: speech.done,
    speechAvoid: speech.avoid,
    speechTests: speech.tests,
    speechNote: speech.note,
  };
}

export const layer = Layer.effect(CommandAssist, make).pipe(Layer.provide(NodeCrypto.layerDigest));
