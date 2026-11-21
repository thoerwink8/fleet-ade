#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - standalone maintenance command uses Node I/O.
// @effect-diagnostics globalConsole:off - standalone maintenance command output.
// @effect-diagnostics globalFetch:off - the source URL is an explicit command argument.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as ModelManifest from "../apps/server/src/provider/ModelManifest.ts";

const MANIFEST_PATH = NodeURL.fileURLToPath(
  new URL("../apps/server/src/provider/model-manifest.json", import.meta.url),
);
const SOURCE_TIMEOUT_MS = 15_000;
const USAGE = "Usage: pnpm models:sync --source <URL or local JSON path> [--write]";

type ModelEntry = NonNullable<
  NonNullable<ModelManifest.ModelManifestData["providers"]>[string]
>["models"][number];

export type ModelManifestWriteDecision =
  | { readonly write: false }
  | { readonly write: true; readonly text: string };

export function decideModelManifestWrite(
  current: ModelManifest.ModelManifestData,
  next: ModelManifest.ModelManifestData,
  sourceText: string,
): ModelManifestWriteDecision {
  return JSON.stringify(current) === JSON.stringify(next)
    ? { write: false }
    : { write: true, text: sourceText.endsWith("\n") ? sourceText : `${sourceText}\n` };
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
};

export function compareModelManifests(
  current: ModelManifest.ModelManifestData,
  next: ModelManifest.ModelManifestData,
): ModelManifestDiff {
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
        return JSON.stringify(from) === JSON.stringify(to) ? [] : [{ field, from, to }];
      });
    if (fields.length > 0) changed.push({ provider, slug: nextModel.slug, fields });
  }
  for (const [key, { provider, model }] of currentModels) {
    if (!nextModels.has(key)) removed.push({ provider, model });
  }

  return { added, removed, changed };
}

function modelEntries(
  manifest: ModelManifest.ModelManifestData,
): Map<string, { readonly provider: string; readonly model: ModelEntry }> {
  const entries = new Map<string, { readonly provider: string; readonly model: ModelEntry }>();
  for (const [provider, catalog] of Object.entries(manifest.providers ?? {})) {
    for (const model of catalog.models) {
      entries.set(`${provider}:${model.slug}`, { provider, model });
    }
  }
  return entries;
}

export function validateModelManifest(input: unknown): ModelManifest.ModelManifestData {
  const decoded = ModelManifest.decodeModelManifest(input);
  if (decoded._tag === "None") throw new Error("source is not a valid model manifest");
  if (modelEntries(decoded.value).size === 0)
    throw new Error("source model manifest contains no models");
  return decoded.value;
}

async function readSource(
  source: string,
): Promise<{ readonly text: string; readonly value: unknown }> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`source returned HTTP ${response.status}`);
    const text = await response.text();
    try {
      return { text, value: JSON.parse(text) };
    } catch {
      throw new Error("source response is not valid JSON");
    }
  }
  try {
    const text = await NodeFSP.readFile(NodePath.resolve(source), "utf8");
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(
      `could not read source: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function printDiff(diff: ModelManifestDiff): void {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    console.log("已是最新");
    return;
  }
  if (diff.added.length > 0) {
    console.log(
      `新增模型:\n${diff.added.map(({ provider, model }) => `  ${provider}/${model.slug} (${model.name})`).join("\n")}`,
    );
  }
  if (diff.removed.length > 0) {
    console.log(
      `删除模型:\n${diff.removed.map(({ provider, model }) => `  ${provider}/${model.slug} (${model.name})`).join("\n")}`,
    );
  }
  if (diff.changed.length > 0) {
    console.log("改动模型:");
    for (const model of diff.changed) {
      console.log(`  ${model.provider}/${model.slug}`);
      for (const field of model.fields) {
        console.log(
          `    ${field.field}: ${JSON.stringify(field.from)} -> ${JSON.stringify(field.to)}`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf("--source");
  const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
  const write = args.includes("--write");
  if (
    !source ||
    args.filter((arg) => arg === "--source").length > 1 ||
    args.some((arg, index) => arg === "--source" && !args[index + 1])
  ) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  try {
    const currentText = await NodeFSP.readFile(MANIFEST_PATH, "utf8");
    const current = validateModelManifest(JSON.parse(currentText));
    const sourceResult = await readSource(source);
    const next = validateModelManifest(sourceResult.value);
    const diff = compareModelManifests(current, next);
    printDiff(diff);
    if (write) {
      const decision = decideModelManifestWrite(current, next, sourceResult.text);
      if (decision.write) {
        await NodeFSP.writeFile(MANIFEST_PATH, decision.text);
        console.log("已写入内置模型清单");
      }
    }
  } catch (error) {
    console.error(`模型清单同步失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
