#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - standalone maintenance command uses Node I/O.
// @effect-diagnostics globalConsole:off - standalone maintenance command output.
// @effect-diagnostics globalFetch:off - the source URL is an explicit command argument.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as ModelManifest from "../src/provider/ModelManifest.ts";
import * as Schema from "effect/Schema";
import { format } from "vite-plus/fmt";

const MANIFEST_PATH = NodeURL.fileURLToPath(
  new URL("../src/provider/model-manifest.json", import.meta.url),
);
const SOURCE_TIMEOUT_MS = 15_000;
const USAGE = "用法：pnpm models:sync --source <地址或本地 JSON 路径> [--write]";

type ModelEntry = NonNullable<
  NonNullable<ModelManifest.ModelManifestData["providers"]>[string]
>["models"][number];

export type ModelManifestChange = {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
};

export type ModelManifestWriteDecision =
  | { readonly write: false }
  | { readonly write: true; readonly text: string };

export async function formatModelManifest(
  manifest: ModelManifest.ModelManifestData,
  baselineText: string,
): Promise<string> {
  const merged = equalJson(JSON.parse(baselineText), manifest)
    ? baselineText
    : mergeManifestText(baselineText, manifest);
  const result = await format("model-manifest.json", merged, { objectWrap: "preserve" });
  if (result.errors.length > 0) throw new Error("无法格式化模型清单");
  return result.code;
}

export async function decideModelManifestWrite(
  current: ModelManifest.ModelManifestData,
  next: ModelManifest.ModelManifestData,
  baselineText: string,
): Promise<ModelManifestWriteDecision> {
  return compareModelManifests(current, next).changes.length === 0
    ? { write: false }
    : { write: true, text: await formatModelManifest(next, baselineText) };
}

type JsonRange =
  | {
      readonly kind: "object";
      readonly start: number;
      readonly end: number;
      readonly entries: ReadonlyMap<
        string,
        { readonly start: number; readonly end: number; readonly value: JsonRange }
      >;
    }
  | {
      readonly kind: "array";
      readonly start: number;
      readonly end: number;
      readonly items: ReadonlyArray<JsonRange>;
    }
  | { readonly kind: "leaf"; readonly start: number; readonly end: number };

// JSON.range-style structural parse so unchanged subtrees keep their existing layout.
function parseJsonRange(text: string): JsonRange {
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(text[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    index += 1;
    while (text[index] !== '"') {
      if (text[index] === "\\") index += 1;
      index += 1;
    }
    index += 1;
    return text.slice(start, index);
  };
  const parseValue = (): JsonRange => {
    whitespace();
    const start = index;
    if (text[index] === "{") {
      index += 1;
      const entries = new Map<string, { start: number; end: number; value: JsonRange }>();
      for (;;) {
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return { kind: "object", start, end: index, entries };
        }
        const entryStart = index;
        const key = JSON.parse(parseString()) as string;
        whitespace();
        index += 1;
        const value = parseValue();
        entries.set(key, { start: entryStart, end: value.end, value });
        whitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] !== "}") throw new Error("invalid JSON");
        index += 1;
        return { kind: "object", start, end: index, entries };
      }
    }
    if (text[index] === "[") {
      index += 1;
      const items: Array<JsonRange> = [];
      for (;;) {
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return { kind: "array", start, end: index, items };
        }
        items.push(parseValue());
        whitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] !== "]") throw new Error("invalid JSON");
        index += 1;
        return { kind: "array", start, end: index, items };
      }
    }
    if (text[index] === '"') {
      parseString();
    } else {
      while (!/[\s,\]}]/.test(text[index] ?? "")) index += 1;
    }
    return { kind: "leaf", start, end: index };
  };
  return parseValue();
}

function emitJson(value: unknown): string {
  return JSON.stringify(value);
}

function mergeRange(
  text: string,
  range: JsonRange,
  current: unknown,
  next: unknown,
  indent: number,
): string {
  if (equalJson(current, next)) return text.slice(range.start, range.end);
  if (range.kind === "object" && isRecord(current) && isRecord(next)) {
    if (!text.slice(range.start, range.end).includes("\n")) return emitJson(next);
    const emitted = new Set<string>();
    const parts: Array<string> = [];
    for (const [key, entry] of range.entries) {
      if (!(key in next)) continue;
      emitted.add(key);
      parts.push(
        equalJson(current[key], next[key])
          ? text.slice(entry.start, entry.end)
          : `${JSON.stringify(key)}: ${mergeRange(text, entry.value, current[key], next[key], indent + 1)}`,
      );
    }
    for (const key of Object.keys(next)) {
      if (!emitted.has(key)) parts.push(`${JSON.stringify(key)}: ${emitJson(next[key])}`);
    }
    if (parts.length === 0) return "{}";
    const pad = "  ".repeat(indent);
    return `{\n${pad}${parts.join(`,\n${pad}`)}\n${"  ".repeat(indent - 1)}}`;
  }
  if (range.kind === "array" && Array.isArray(current) && Array.isArray(next)) {
    const currentItems = range.items;
    const reused = new Set<number>();
    const parts = next.map((item) => {
      const sourceIndex = current.findIndex(
        (candidate, index) => !reused.has(index) && equalJson(candidate, item),
      );
      if (sourceIndex >= 0) {
        reused.add(sourceIndex);
        const sourceRange = currentItems[sourceIndex];
        if (sourceRange !== undefined) return text.slice(sourceRange.start, sourceRange.end);
      }
      return emitJson(item);
    });
    if (parts.length === 0) return "[]";
    const pad = "  ".repeat(indent);
    return `[\n${pad}${parts.join(`,\n${pad}`)}\n${"  ".repeat(indent - 1)}]`;
  }
  return emitJson(next);
}

function mergeManifestText(baselineText: string, next: ModelManifest.ModelManifestData): string {
  const current = JSON.parse(baselineText) as unknown;
  return `${mergeRange(baselineText, parseJsonRange(baselineText), current, next, 1)}\n`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ModelManifestDiff = {
  readonly added: ReadonlyArray<{ readonly provider: string; readonly model: ModelEntry }>;
  readonly removed: ReadonlyArray<{ readonly provider: string; readonly model: ModelEntry }>;
  readonly changed: ReadonlyArray<{
    readonly provider: string;
    readonly slug: string;
    readonly fields: ReadonlyArray<{
      readonly field: string;
      readonly from: unknown;
      readonly to: unknown;
    }>;
  }>;
  readonly changes: ReadonlyArray<ModelManifestChange>;
};

const manifestFields = ["version", "updatedAt", "compatibility", "currentModels"] as const;

export function compareModelManifests(
  current: ModelManifest.ModelManifestData,
  next: ModelManifest.ModelManifestData,
): ModelManifestDiff {
  const changes: Array<ModelManifestChange> = [];
  for (const field of manifestFields) addChange(changes, field, current[field], next[field]);

  const currentProviders = current.providers ?? {};
  const nextProviders = next.providers ?? {};
  const providerNames = new Set([...Object.keys(currentProviders), ...Object.keys(nextProviders)]);
  for (const provider of [...providerNames].sort()) {
    const currentCatalog = currentProviders[provider];
    const nextCatalog = nextProviders[provider];
    if (!currentCatalog || !nextCatalog) {
      addChange(changes, `providers.${provider}`, currentCatalog, nextCatalog);
      continue;
    }
    addChange(
      changes,
      `providers.${provider}.defaults`,
      currentCatalog.defaults,
      nextCatalog.defaults,
    );
    addChange(
      changes,
      `providers.${provider}.profiles`,
      currentCatalog.profiles,
      nextCatalog.profiles,
    );
  }

  const currentModels = modelEntries(current);
  const nextModels = modelEntries(next);
  const added: Array<ModelManifestDiff["added"][number]> = [];
  const removed: Array<ModelManifestDiff["removed"][number]> = [];
  const changed: Array<ModelManifestDiff["changed"][number]> = [];
  for (const [key, { provider, model: nextModel }] of nextModels) {
    const currentModel = currentModels.get(key)?.model;
    if (!currentModel) {
      added.push({ provider, model: nextModel });
      continue;
    }
    const fields = Object.keys({ ...currentModel, ...nextModel })
      .sort()
      .flatMap((field) => {
        const from = currentModel[field as keyof ModelEntry];
        const to = nextModel[field as keyof ModelEntry];
        return equalJson(from, to) ? [] : [{ field, from, to }];
      });
    if (fields.length > 0) changed.push({ provider, slug: nextModel.slug, fields });
  }
  for (const [key, { provider, model }] of currentModels) {
    if (!nextModels.has(key)) removed.push({ provider, model });
  }
  for (const provider of new Set(
    [...currentModels.keys(), ...nextModels.keys()].map((key) => key.split(":", 1)[0]!),
  )) {
    addChange(
      changes,
      `providers.${provider}.models`,
      currentProviders[provider]?.models,
      nextProviders[provider]?.models,
    );
  }
  return { added, removed, changed, changes };
}

function addChange(
  changes: Array<ModelManifestChange>,
  path: string,
  from: unknown,
  to: unknown,
): void {
  if (!equalJson(from, to)) changes.push({ path, from, to });
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortObjectKeys(left)) === JSON.stringify(sortObjectKeys(right));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortObjectKeys(entry)]),
    );
  }
  return value;
}

function modelEntries(
  manifest: ModelManifest.ModelManifestData,
): Map<string, { readonly provider: string; readonly model: ModelEntry }> {
  const entries = new Map<string, { readonly provider: string; readonly model: ModelEntry }>();
  for (const [provider, catalog] of Object.entries(manifest.providers ?? {})) {
    for (const model of catalog.models)
      entries.set(`${provider}:${model.slug}`, { provider, model });
  }
  return entries;
}

export function validateModelManifest(input: unknown): ModelManifest.ModelManifestData {
  const result = ModelManifest.decodeModelManifest(input);
  if (Exit.isFailure(result)) {
    const error = Cause.squash(result.cause);
    throw new Error(
      `来源不是合法的模型清单：${Schema.isSchemaError(error) ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (modelEntries(result.value).size === 0) throw new Error("来源模型清单不包含任何模型");
  return result.value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `来源不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readSource(
  source: string,
): Promise<{ readonly value: unknown; readonly text: string }> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`来源返回 HTTP ${response.status}`);
    const text = await response.text();
    return { text, value: parseJson(text) };
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  try {
    const text = await NodeFSP.readFile(NodePath.resolve(cwd, source), "utf8");
    return { text, value: parseJson(text) };
  } catch (error) {
    throw new Error(`无法读取来源：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function printValue(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function printDiff(diff: ModelManifestDiff): void {
  if (diff.changes.length === 0) {
    console.log("已是最新");
    return;
  }
  for (const change of diff.changes) {
    if (change.path.endsWith(".models")) continue;
    console.log(`清单改动 ${change.path}：${printValue(change.from)} -> ${printValue(change.to)}`);
  }
  if (diff.added.length)
    console.log(
      `新增模型：${diff.added.map(({ provider, model }) => `${provider}/${model.slug}`).join("、")}`,
    );
  if (diff.removed.length)
    console.log(
      `删除模型：${diff.removed.map(({ provider, model }) => `${provider}/${model.slug}`).join("、")}`,
    );
  for (const model of diff.changed) {
    for (const field of model.fields)
      console.log(
        `模型改动 ${model.provider}/${model.slug}.${field.field}：${printValue(field.from)} -> ${printValue(field.to)}`,
      );
  }
}

async function writeManifest(text: string): Promise<void> {
  const temporaryPath = `${MANIFEST_PATH}.${process.pid}.tmp`;
  try {
    await NodeFSP.writeFile(temporaryPath, text);
    await NodeFSP.rename(temporaryPath, MANIFEST_PATH);
  } catch (error) {
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf("--source");
  const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
  if (!source || source.startsWith("--") || args.filter((arg) => arg === "--source").length > 1) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  try {
    const currentText = await NodeFSP.readFile(MANIFEST_PATH, "utf8");
    const current = validateModelManifest(parseJson(currentText));
    const sourceResult = await readSource(source);
    const next = validateModelManifest(sourceResult.value);
    const diff = compareModelManifests(current, next);
    printDiff(diff);
    const decision = args.includes("--write")
      ? await decideModelManifestWrite(current, next, currentText)
      : { write: false as const };
    if (decision.write) {
      await writeManifest(decision.text);
      console.log("已写入内置模型清单");
    }
  } catch (error) {
    console.error(`模型清单同步失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
