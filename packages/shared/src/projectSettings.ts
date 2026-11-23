import {
  BUILTIN_COMMANDER_INSTRUCTIONS,
  PROJECT_FILE_BACKED_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type CommandAssistRows,
  type ProjectFileBackedSettingKey,
  type ProjectId,
  type DispatchRole,
  fillCommandAssistRows,
  type ModelSelection,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  resolveProjectProviderInstanceEnabled,
  resolveTextGenerationSelectionEnabled,
  type ResolvedServerSettings,
  type ServerSettings,
  type T3ProjectFile,
  type ThreadEnvMode,
  type WorktreeCleanupRules,
} from "@t3tools/contracts";
import { readCustomModelEntries } from "./model.ts";
import { normalizeProjectPathForComparison } from "./path.ts";
import { fallbackTextGenerationModelSelection } from "./serverSettings.ts";

export type ProjectSettingSource = "environment" | "project" | "t3.json";

export type ProjectSettingSources = Readonly<
  Record<ProjectScopedServerSettingKey, ProjectSettingSource>
>;

export interface ResolvedProjectSettings<Settings extends ServerSettings = ServerSettings> {
  readonly settings: Settings;
  readonly sources: ProjectSettingSources;
  readonly overrides: ProjectSettingsOverrides;
}

const EMPTY_OVERRIDES: ProjectSettingsOverrides = {};

const ENVIRONMENT_SOURCES: ProjectSettingSources = Object.fromEntries(
  PROJECT_SCOPED_SERVER_SETTING_KEYS.map((key) => [key, "environment"]),
) as Record<ProjectScopedServerSettingKey, ProjectSettingSource>;

export function hasProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): boolean {
  for (const entry of Object.values(settings.projectSettingsOverrides)) {
    // Forward-compatible decoding can leave a present undefined, which is not an override.
    if (Object.values(entry).some((value) => value !== undefined)) return true;
  }
  return false;
}

/** Legacy aggregate fields apply only until folded into overrides, so stale values cannot undo later resets. */
export interface LegacyProjectSettingsFields {
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
}

export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings;
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project: LegacyProjectSettingsFields | null | undefined,
  projectFile: T3ProjectFile | null,
): ResolvedProjectSettings<ResolvedServerSettings>;
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
  projectFile?: T3ProjectFile | null,
): ResolvedProjectSettings {
  const resolved = resolveProjectOverrides(settings, projectId, project);
  return projectFile === undefined ? resolved : applyProjectFile(resolved, projectFile);
}

function applyProjectFile(
  resolved: ResolvedProjectSettings,
  projectFile: T3ProjectFile | null,
): ResolvedProjectSettings {
  let effective: Record<string, unknown> | null = null;
  let sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> | null = null;
  for (const key of Object.keys(PROJECT_FILE_BACKED_SETTINGS) as ProjectFileBackedSettingKey[]) {
    if (resolved.settings[key] !== null) continue;
    const { value, source } = resolveProjectFileBackedSetting(key, null, projectFile);
    effective ??= { ...resolved.settings };
    sources ??= { ...resolved.sources };
    effective[key] = value;
    sources[key] = source;
  }
  return effective === null || sources === null
    ? resolved
    : { ...resolved, settings: effective as ServerSettings, sources };
}

export function resolveProjectFileBackedSetting<K extends ProjectFileBackedSettingKey>(
  key: K,
  setting: ServerSettings[K],
  projectFile: T3ProjectFile | null,
): { value: ResolvedServerSettings[K]; source: ProjectSettingSource } {
  if (setting !== null) {
    return { value: setting as ResolvedServerSettings[K], source: "environment" };
  }
  const { field, builtIn } = PROJECT_FILE_BACKED_SETTINGS[key];
  const fromFile = projectFile?.[field] as ResolvedServerSettings[K] | undefined;
  return fromFile === undefined
    ? { value: builtIn as ResolvedServerSettings[K], source: "environment" }
    : { value: fromFile, source: "t3.json" };
}

function resolveProjectOverrides(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings {
  const stored = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  const overrides: ProjectSettingsOverrides =
    project == null || settings.projectSettingsFolded
      ? (stored ?? EMPTY_OVERRIDES)
      : {
          ...(project.defaultModelSelection != null
            ? { defaultModelSelection: project.defaultModelSelection }
            : {}),
          ...(project.defaultThreadEnvMode != null
            ? { defaultThreadEnvMode: project.defaultThreadEnvMode }
            : {}),
          ...stored,
        };
  if (Object.keys(overrides).length === 0) {
    return { settings, sources: ENVIRONMENT_SOURCES, overrides: EMPTY_OVERRIDES };
  }
  const sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> = {
    ...ENVIRONMENT_SOURCES,
  };
  const effective: Record<string, unknown> = { ...settings };
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    // Forward-compatible decoding can leave a present undefined, which is not an override.
    if (value === undefined) continue;
    // A project writes the cells it changes. The rest stay on the environment row.
    if (key === "commandAssist") {
      effective.commandAssist = {
        ...settings.commandAssist,
        ...(value as CommandAssistRows),
      };
      sources.commandAssist = "project";
      continue;
    }
    if (
      (key === "textGenerationModelSelection" || key === "defaultModelSelection") &&
      value !== undefined &&
      value !== null &&
      !(
        key === "textGenerationModelSelection"
          ? resolveTextGenerationSelectionEnabled
          : resolveProjectProviderInstanceEnabled
      )(settings, projectId, (value as ModelSelection).instanceId)
    ) {
      continue;
    }
    // Clients resolve a hidden model to the catalog's first visible one, so a
    // hidden project default would silently pick a model nobody chose.
    // Custom models stay visible even when listed as hidden, as in the clients.
    if (key === "defaultModelSelection" && value !== null) {
      const { instanceId, model } = value as ModelSelection;
      const config = settings.providerInstances[instanceId]?.config as
        | { customModels?: unknown }
        | undefined;
      if (
        settings.providerModelPreferences?.[instanceId]?.hiddenModels.includes(model) &&
        !readCustomModelEntries(config?.customModels).some((entry) => entry.slug === model)
      ) {
        continue;
      }
    }
    effective[key] = value;
    sources[key] = "project";
  }
  const textGeneration = effective.textGenerationModelSelection as ModelSelection;
  if (!resolveTextGenerationSelectionEnabled(settings, projectId, textGeneration.instanceId)) {
    const fallback = fallbackTextGenerationModelSelection(
      settings.providerInstances,
      (instanceId) => resolveProjectProviderInstanceEnabled(settings, projectId, instanceId),
      { defaultModelSelection: effective.defaultModelSelection as ModelSelection | null },
    );
    if (fallback !== null) effective.textGenerationModelSelection = fallback;
  }
  return { settings: effective as ServerSettings, sources, overrides };
}

/** New name-only projects use their checkout until the first thread, even when the default is worktree. */
export function resolveNewThreadEnvMode(input: {
  readonly projectSettings: ResolvedProjectSettings<ResolvedServerSettings>;
  readonly workspaceRoot: string | null;
  readonly newProjectsRoot: string | null | undefined;
  readonly projectHasThreads: boolean;
}): ThreadEnvMode {
  const configured = input.projectSettings.settings.defaultThreadEnvMode;
  if (
    configured === "local" ||
    input.projectHasThreads ||
    input.projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    input.workspaceRoot === null ||
    input.newProjectsRoot == null
  ) {
    return configured;
  }
  const root = normalizeProjectPathForComparison(input.newProjectsRoot);
  const folder = normalizeProjectPathForComparison(input.workspaceRoot);
  const separator = root.includes("\\") ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  const isNewProjectFolder =
    folder.startsWith(prefix) &&
    folder.length > prefix.length &&
    !folder.slice(prefix.length).includes(separator);
  return isNewProjectFolder ? "local" : configured;
}

export function resolveSendEnvMode(input: {
  readonly requestedEnvMode: ThreadEnvMode;
  readonly isGitRepo: boolean;
}): ThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function clearProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  keys: readonly ProjectScopedServerSettingKey[],
): ProjectSettingsOverrides | null {
  const current = settings.projectSettingsOverrides[projectId];
  if (current === undefined) return null;
  const next = { ...current };
  for (const key of keys) delete next[key];
  return Object.keys(next).length === 0 ? null : next;
}

export function resolveWorktreeCleanup(
  settings: ServerSettings,
  projectId: ProjectId | null,
): WorktreeCleanupRules {
  const policy = resolveProjectSettings(settings, projectId).settings.worktreeCleanup;
  if (policy?.mode === "custom") return policy.rules;
  if (policy?.mode === "off")
    return {
      worktreeKeepWhen: settings.storageCleanup.worktreeKeepWhen,
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
    };
  const {
    worktreeKeepWhen,
    worktreeAfterDays,
    worktreeSettledAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  } = settings.storageCleanup;
  return {
    worktreeKeepWhen,
    worktreeAfterDays,
    worktreeSettledAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  };
}

const DISPATCH_ROLE_KEYS = {
  code: "dispatchCodeModelSelection",
  review: "dispatchReviewModelSelection",
  readonly: "dispatchReadonlyModelSelection",
  plan: "dispatchPlanModelSelection",
} as const satisfies Record<DispatchRole, ProjectScopedServerSettingKey>;

export interface ResolvedDispatchAssignment {
  /** Empty cell and empty default are null. Otherwise the model a new delegation of that role uses. */
  readonly roles: Readonly<Record<DispatchRole, ModelSelection | null>>;
  /** Null does not cap open delegations. */
  readonly concurrencyLimit: number | null;
  /** Null does not limit one delegation. Queue time is not included. */
  readonly timeoutMs: number | null;
  /** False leaves a timed-out delegation running. */
  readonly stopOnTimeout: boolean;
  /** Project text, else environment text, else the built-in instructions. */
  readonly instructions: string;
  /**
   * Host project only. Null keeps the commander thread's current model.
   * Role cells never read this, and this never reads a role cell.
   */
  readonly commanderModel: ModelSelection | null;
}

/** Project cells cover only the keys that project wrote. An empty cell uses `defaultModelSelection`. */
export function resolveDispatchAssignment(
  settings: ServerSettings,
  projectId: ProjectId | null,
): ResolvedDispatchAssignment {
  const resolved = resolveProjectSettings(settings, projectId).settings;
  const fallback = resolved.defaultModelSelection;
  const roleModel = (role: DispatchRole) => resolved[DISPATCH_ROLE_KEYS[role]] ?? fallback;
  const writtenInstructions = resolved.commanderInstructions.trim();
  return {
    roles: {
      code: roleModel("code"),
      review: roleModel("review"),
      readonly: roleModel("readonly"),
      plan: roleModel("plan"),
    },
    concurrencyLimit: resolved.dispatchConcurrencyLimit,
    timeoutMs: resolved.dispatchTimeoutMs,
    stopOnTimeout: resolved.dispatchStopOnTimeout,
    instructions:
      writtenInstructions.length > 0 ? writtenInstructions : BUILTIN_COMMANDER_INSTRUCTIONS,
    commanderModel: resolved.dispatchCommanderModelSelection,
  };
}

export interface ResolvedCommandAssist {
  readonly rows: CommandAssistRows;
  /** Empty assist cells use this selection. */
  readonly textGeneration: ModelSelection;
}

/** Project cells cover only the assist rows that project wrote. */
export function resolveCommandAssist(
  settings: ServerSettings,
  projectId: ProjectId | null,
): ResolvedCommandAssist {
  const resolved = resolveProjectSettings(settings, projectId).settings;
  return {
    rows: fillCommandAssistRows(resolved.commandAssist),
    textGeneration: resolved.textGenerationModelSelection,
  };
}
