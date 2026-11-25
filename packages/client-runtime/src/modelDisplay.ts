import { ANTIGRAVITY_DEFAULT_MODEL, type ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

export interface ModelDisplayCandidate {
  readonly slug: string;
  readonly name?: string | null | undefined;
  readonly aliases?: ReadonlyArray<string> | undefined;
  readonly isDefault?: boolean | undefined;
}

/**
 * Formats a model's display name solely from the provider-supplied name,
 * falling back to the raw model ID without inventing capitalization or short names.
 */
export function formatModelDisplayName(
  model: Pick<ModelDisplayCandidate, "slug" | "name">,
): string {
  const name = model.name?.trim();
  return name && name.length > 0 ? name : model.slug;
}

/**
 * Resolves the matching catalog entry for a model reference.
 * Priority: provider default placeholder (`acpRegistry`/`antigravity`), exact slug,
 * alias match, provider slug normalization, then case-insensitive name match.
 */
export function resolveCatalogModel<T extends ModelDisplayCandidate>(input: {
  readonly driverKind?: ProviderDriverKind | string | null | undefined;
  readonly model: string | null | undefined;
  readonly models?: ReadonlyArray<T> | null | undefined;
}): T | undefined {
  const trimmed = input.model?.trim();
  if (!trimmed) return undefined;
  const models = input.models;
  if (!models || models.length === 0) return undefined;

  if (input.driverKind === "acpRegistry" && trimmed === "default") {
    const discoveredDefault = models.find(
      (candidate) => candidate.isDefault && candidate.slug !== "default",
    );
    if (discoveredDefault) {
      return discoveredDefault;
    }
  }

  if (input.driverKind === "antigravity" && trimmed === ANTIGRAVITY_DEFAULT_MODEL) {
    const aliasDefault = models.find((candidate) =>
      candidate.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL),
    );
    if (aliasDefault) {
      return aliasDefault;
    }
    const markedDefault = models.find((candidate) => candidate.isDefault);
    if (markedDefault) {
      return markedDefault;
    }
  }

  const direct = models.find((candidate) => candidate.slug === trimmed);
  if (direct) {
    return direct;
  }

  const lower = trimmed.toLowerCase();
  const byAlias = models.find((candidate) =>
    candidate.aliases?.some((alias) => alias.toLowerCase() === lower),
  );
  if (byAlias) {
    return byAlias;
  }

  if (input.driverKind) {
    const normalized = normalizeModelSlug(trimmed, input.driverKind as ProviderDriverKind);
    if (normalized) {
      const byNormalized = models.find((candidate) => candidate.slug === normalized);
      if (byNormalized) {
        return byNormalized;
      }
    }
  }

  return models.find((candidate) => candidate.name?.trim().toLowerCase() === lower);
}

/** Resolves canonical model ID for identity comparison (e.g. model switch dividers). */
export function resolveCanonicalModelId(input: {
  readonly driverKind?: ProviderDriverKind | string | null | undefined;
  readonly model: string | null | undefined;
  readonly models?: ReadonlyArray<ModelDisplayCandidate> | null | undefined;
}): string {
  const trimmed = input.model?.trim() ?? "";
  if (!trimmed) return "";
  const match = resolveCatalogModel(input);
  if (match) {
    return match.slug;
  }
  if (input.driverKind) {
    return normalizeModelSlug(trimmed, input.driverKind as ProviderDriverKind) ?? trimmed;
  }
  return trimmed;
}

/** Single shared source of truth for displaying any model name across all UI surfaces. */
export function resolveModelDisplayName(input: {
  readonly driverKind?: ProviderDriverKind | string | null | undefined;
  readonly model: string | null | undefined;
  readonly models?: ReadonlyArray<ModelDisplayCandidate> | null | undefined;
}): string {
  const trimmed = input.model?.trim() ?? "";
  if (!trimmed) return "";
  const match = resolveCatalogModel(input);
  return match ? formatModelDisplayName(match) : trimmed;
}
