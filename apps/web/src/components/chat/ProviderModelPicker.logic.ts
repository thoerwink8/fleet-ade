import { formatModelDisplayName, resolveCatalogModel } from "@t3tools/client-runtime/model-display";
import { ANTIGRAVITY_DEFAULT_MODEL, type ProviderDriverKind } from "@t3tools/contracts";

import type { ModelEsque } from "./providerIconUtils";

/** Keeps a hidden model visible while its provider is locked or turned off. */
export function retainedModelWhileProviderLocked(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
    readonly models: ReadonlyArray<Pick<ModelEsque, "slug" | "name" | "shortName" | "subProvider">>;
  } | null,
  model: string,
): ModelEsque | undefined {
  if (!entry || (entry.enabled && entry.isAvailable) || !model) return undefined;
  if (entry.driverKind === "antigravity") return undefined;
  return entry.models.find((candidate) => candidate.slug === model) ?? { slug: model, name: model };
}

/** Resolves unified trigger text without clobbering uncataloged non-empty model IDs. */
export function resolveModelPickerTriggerDisplay(input: {
  readonly driverKind: ProviderDriverKind | undefined;
  readonly model: string;
  readonly options: ReadonlyArray<ModelEsque>;
  readonly retainedModel?: ModelEsque | undefined;
}): {
  readonly triggerTitle: string;
  readonly triggerLabel: string;
  readonly isUnavailable: boolean;
} {
  const trimmedModel = input.model.trim();
  const searchableOptions =
    input.driverKind === "antigravity" && trimmedModel === ANTIGRAVITY_DEFAULT_MODEL
      ? input.options.filter(
          (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
        )
      : input.options;
  const matchedModel =
    resolveCatalogModel({
      driverKind: input.driverKind,
      model: trimmedModel,
      models: searchableOptions,
    }) ?? input.retainedModel;
  const selectedModel =
    matchedModel ??
    (trimmedModel.length === 0 && input.driverKind !== "antigravity"
      ? input.options[0]
      : undefined);
  const triggerTitle = selectedModel
    ? formatModelDisplayName(selectedModel)
    : trimmedModel === ANTIGRAVITY_DEFAULT_MODEL
      ? "选择模型"
      : trimmedModel || "选择模型";
  const triggerLabel = selectedModel
    ? `${formatModelDisplayName(selectedModel)}${selectedModel.isUnavailable ? "（不可用）" : ""}`
    : triggerTitle;
  return {
    triggerTitle,
    triggerLabel,
    isUnavailable: Boolean(selectedModel?.isUnavailable),
  };
}
