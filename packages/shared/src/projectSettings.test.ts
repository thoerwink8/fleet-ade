import {
  BUILTIN_COMMANDER_INSTRUCTIONS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  lookupCommandAssistRow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  clearProjectSettingsOverrides,
  hasProjectSettingsOverrides,
  resolveCommandAssist,
  resolveDispatchAssignment,
  resolveNewThreadEnvMode,
  resolveProjectSettings,
  resolveSendEnvMode,
  resolveWorktreeCleanup,
} from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");

describe("resolveSendEnvMode", () => {
  // regression: #21404 non-git projects send from the current checkout, git repos keep their mode
  it.each(["local", "worktree"] as const)(
    "uses local for non-git projects requesting %s",
    (mode) => {
      expect(resolveSendEnvMode({ requestedEnvMode: mode, isGitRepo: false })).toBe("local");
    },
  );

  it.each(["local", "worktree"] as const)("preserves %s for git repositories", (mode) => {
    expect(resolveSendEnvMode({ requestedEnvMode: mode, isGitRepo: true })).toBe(mode);
  });
});

describe("resolveProjectSettings", () => {
  it("ignores an override left undefined by a forward-compatible decode", () => {
    const resolved = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        defaultRuntimeMode: "full-access",
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      },
      projectId,
    );
    expect(resolved.settings.defaultRuntimeMode).toBe("full-access");
    expect(resolved.sources.defaultRuntimeMode).toBe("environment");
    expect(
      hasProjectSettingsOverrides({
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      }),
    ).toBe(false);
  });

  it("ignores a key of a removed feature stored in a project's overrides", () => {
    const resolved = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: {
          [projectId]: { speechProjectCustomWords: [{ term: "Effect", aliases: [] }] } as never,
        },
      },
      projectId,
    );
    expect(resolved.settings).not.toHaveProperty("speechProjectCustomWords");
    expect(new Set(Object.values(resolved.sources))).toEqual(new Set(["environment"]));
  });

  it("applies overrides per key and reports their source", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultAutoPull: true,
      sidebarAutoSettleAfterDays: 3,
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: false, sidebarAutoSettleAfterDays: null },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultAutoPull).toBe(false);
    expect(resolved.settings.sidebarAutoSettleAfterDays).toBeNull();
    expect(resolved.settings.defaultThreadEnvMode).toBe(settings.defaultThreadEnvMode);
    expect(resolved.sources.defaultAutoPull).toBe("project");
    expect(resolved.sources.sidebarAutoSettleAfterDays).toBe("project");
    expect(resolved.sources.defaultThreadEnvMode).toBe("environment");
    expect(resolveProjectSettings(settings, otherProjectId).settings.defaultAutoPull).toBe(true);
  });

  it("honours the aggregate's own fields only until the server has folded them", () => {
    const aggregateModel = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
    const project = {
      defaultModelSelection: aggregateModel,
      defaultThreadEnvMode: "local" as const,
    };
    const unfolded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: false },
      projectId,
      project,
    );
    expect(unfolded.settings.defaultModelSelection).toEqual(aggregateModel);
    expect(unfolded.settings.defaultThreadEnvMode).toBe("local");
    expect(unfolded.sources.defaultModelSelection).toBe("project");
    const overridden = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: false,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
      },
      projectId,
      project,
    );
    expect(overridden.settings.defaultThreadEnvMode).toBe("worktree");
    const folded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true },
      projectId,
      project,
    );
    expect(folded.settings.defaultModelSelection).toBeNull();
    expect(folded.sources.defaultModelSelection).toBe("environment");
  });

  it("keeps the environment default model when the override's provider is disabled", () => {
    const disabledSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "opus");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
        },
      },
      projectSettingsOverrides: { [projectId]: { defaultModelSelection: disabledSelection } },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultModelSelection).toBeNull();
    expect(resolved.sources.defaultModelSelection).toBe("environment");
  });

  // regression: #17556 a hidden project default silently became the catalog's first model
  it.each([
    ["hidden", ["gpt-5.6-terra", "gpt-5.6-sol"], [], "gpt-6.1-sol", "environment"],
    ["visible", ["gpt-5.6-terra"], [], "gpt-5.6-sol", "project"],
    ["custom", ["gpt-5.6-sol"], ["gpt-5.6-sol"], "gpt-5.6-sol", "project"],
  ] as const)(
    "resolves a %s project default model against the environment default",
    (_visibility, hiddenModels, customModels, expectedModel, expectedSource) => {
      const codex = ProviderInstanceId.make("codex");
      const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        defaultModelSelection: createModelSelection(codex, "gpt-6.1-sol"),
        providerInstances: {
          [codex]: { driver: ProviderDriverKind.make("codex"), config: { customModels } },
        },
        providerModelPreferences: { [codex]: { hiddenModels, modelOrder: [] } },
        projectSettingsOverrides: {
          [projectId]: { defaultModelSelection: createModelSelection(codex, "gpt-5.6-sol") },
        },
      });
      const resolved = resolveProjectSettings(settings, projectId);
      expect(resolved.settings.defaultModelSelection?.model).toBe(expectedModel);
      expect(resolved.sources.defaultModelSelection).toBe(expectedSource);
      expect(resolved.overrides.defaultModelSelection?.model).toBe("gpt-5.6-sol");
    },
  );

  it("moves text generation off an instance the project turned off", () => {
    const codex = ProviderInstanceId.make("codex");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(codex, "gpt-5"),
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [codex]: { enabled: false } } },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      resolveProjectSettings(settings, otherProjectId).settings.textGenerationModelSelection,
    ).toEqual(settings.textGenerationModelSelection);
  });

  it("falls back to a configured instance when every built-in one is off for the project", () => {
    const codex = ProviderInstanceId.make("codex");
    const codexWork = ProviderInstanceId.make("codex_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(codex, "gpt-5"),
      providerInstances: { [codexWork]: { driver: ProviderDriverKind.make("codex"), config: {} } },
      projectSettingsOverrides: {
        [projectId]: {
          providerInstances: {
            [codex]: { enabled: false },
            [ProviderInstanceId.make("claudeAgent")]: { enabled: false },
          },
        },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(codexWork);
  });
});

describe("resolveDispatchAssignment", () => {
  it("uses project role cells and falls back to the default model", () => {
    const defaultSelection = createModelSelection(ProviderInstanceId.make("codex"), "default");
    const reviewSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "review");
    const settings = applyServerSettingsPatch(
      {
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: defaultSelection,
        dispatchConcurrencyLimit: 3,
      },
      {
        projectSettingsOverrides: {
          [projectId]: {
            dispatchCodeModelSelection: null,
            dispatchReviewModelSelection: reviewSelection,
            dispatchConcurrencyLimit: 5,
          },
        },
      },
    );
    const resolved = resolveDispatchAssignment(settings, projectId);
    expect(resolved.roles.code).toEqual(defaultSelection);
    expect(resolved.roles.review).toEqual(reviewSelection);
    expect(resolved.roles.readonly).toEqual(defaultSelection);
    expect(resolved.roles.plan).toEqual(defaultSelection);
    expect(resolved.concurrencyLimit).toBe(5);
  });

  it("uses the environment cap when the project has no override", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, dispatchConcurrencyLimit: 3 };
    expect(resolveDispatchAssignment(settings, otherProjectId).concurrencyLimit).toBe(3);
  });

  it("uses project instructions, then environment instructions, then the built-in text", () => {
    const environment = {
      ...DEFAULT_SERVER_SETTINGS,
      commanderInstructions: "环境守则",
      dispatchTimeoutMs: 60_000,
      dispatchStopOnTimeout: true,
    };
    expect(resolveDispatchAssignment(environment, projectId).instructions).toBe("环境守则");
    const project = applyServerSettingsPatch(environment, {
      projectSettingsOverrides: {
        [projectId]: { commanderInstructions: "项目守则", dispatchTimeoutMs: null },
      },
    });
    expect(resolveDispatchAssignment(project, projectId)).toMatchObject({
      instructions: "项目守则",
      timeoutMs: null,
      stopOnTimeout: true,
    });
    const reset = applyServerSettingsPatch(environment, {
      projectSettingsOverrides: { [projectId]: {} },
    });
    expect(resolveDispatchAssignment(reset, projectId).instructions).toBe("环境守则");
    expect(
      resolveDispatchAssignment(
        { ...DEFAULT_SERVER_SETTINGS, commanderInstructions: "   " },
        projectId,
      ).instructions,
    ).toBe(BUILTIN_COMMANDER_INSTRUCTIONS);
  });

  it("keeps the commander model off the role cells", () => {
    const commander = createModelSelection(ProviderInstanceId.make("codex"), "commander");
    const review = createModelSelection(ProviderInstanceId.make("claudeAgent"), "review");
    const settings = applyServerSettingsPatch(
      { ...DEFAULT_SERVER_SETTINGS, dispatchCommanderModelSelection: commander },
      {
        projectSettingsOverrides: {
          [projectId]: { dispatchReviewModelSelection: review },
          [otherProjectId]: { dispatchCommanderModelSelection: null },
        },
      },
    );
    const host = resolveDispatchAssignment(settings, projectId);
    expect(host.commanderModel).toEqual(commander);
    expect(host.roles.review).toEqual(review);
    expect(host.roles.code).toBeNull();
    expect(resolveDispatchAssignment(settings, otherProjectId).commanderModel).toBeNull();
    expect(resolveDispatchAssignment(settings, otherProjectId).roles.review).toBeNull();
  });
});

describe("resolveCommandAssist", () => {
  it("lets a project cover one assist row and leaves the others on the environment", () => {
    const activity = createModelSelection(ProviderInstanceId.make("codex"), "activity");
    const drift = createModelSelection(ProviderInstanceId.make("claudeAgent"), "drift");
    const settings = applyServerSettingsPatch(
      {
        ...DEFAULT_SERVER_SETTINGS,
        commandAssist: {
          ...DEFAULT_SERVER_SETTINGS.commandAssist,
          drift: { enabled: true, modelSelection: drift },
        },
      },
      {
        projectSettingsOverrides: {
          [projectId]: {
            commandAssist: {
              activity: { enabled: false, modelSelection: activity },
            },
          },
        },
      },
    );
    const resolved = resolveCommandAssist(settings, projectId);
    expect(lookupCommandAssistRow(resolved.rows, "activity", resolved.textGeneration)).toEqual({
      _tag: "skipped",
      reason: "off",
    });
    expect(lookupCommandAssistRow(resolved.rows, "drift", resolved.textGeneration)).toEqual({
      _tag: "ready",
      model: drift,
    });
    expect(lookupCommandAssistRow(resolved.rows, "patrol", resolved.textGeneration)).toEqual({
      _tag: "skipped",
      reason: "off",
    });
    expect(lookupCommandAssistRow(resolved.rows, "naming", resolved.textGeneration)).toEqual({
      _tag: "ready",
      model: resolved.textGeneration,
    });
    const other = resolveCommandAssist(settings, otherProjectId);
    expect(lookupCommandAssistRow(other.rows, "activity", other.textGeneration)).toEqual({
      _tag: "skipped",
      reason: "off",
    });
    expect(lookupCommandAssistRow(other.rows, "drift", other.textGeneration)).toEqual({
      _tag: "ready",
      model: drift,
    });
  });
});

describe("resolveProjectSettings with a t3.json", () => {
  it("walks project override, environment value, file, then built-in for file-backed keys", () => {
    const file = { defaultThreadEnvMode: "worktree" as const };
    const fromOverride = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "local" } },
      },
      projectId,
      null,
      file,
    );
    expect(fromOverride.settings.defaultThreadEnvMode).toBe("local");
    expect(fromOverride.sources.defaultThreadEnvMode).toBe("project");

    const fromEnvironment = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" },
      projectId,
      null,
      file,
    );
    expect(fromEnvironment.settings.defaultThreadEnvMode).toBe("local");
    expect(fromEnvironment.sources.defaultThreadEnvMode).toBe("environment");

    const fromFile = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, file);
    expect(fromFile.settings.defaultThreadEnvMode).toBe("worktree");
    expect(fromFile.sources.defaultThreadEnvMode).toBe("t3.json");

    const builtIn = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, null);
    expect(builtIn.settings.defaultThreadEnvMode).toBe("local");
    expect(builtIn.sources.defaultThreadEnvMode).toBe("environment");
    const nullOverride = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: null } as never },
      },
      projectId,
      null,
      file,
    );
    expect(nullOverride.settings.defaultThreadEnvMode).toBe("worktree");
    expect(nullOverride.sources.defaultThreadEnvMode).toBe("t3.json");
    expect(
      resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, {}).sources
        .defaultThreadEnvMode,
    ).toBe("environment");
  });
});

describe("resolveNewThreadEnvMode", () => {
  const worktreeEnvironment = resolveProjectSettings(
    { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
    projectId,
    null,
    null,
  );
  const newProject = {
    projectSettings: worktreeEnvironment,
    workspaceRoot: "/data/projects/pinball-stats",
    newProjectsRoot: "/data/projects/",
    projectHasThreads: false,
  };

  it("starts a new project's first thread in its checkout", () => {
    expect(resolveNewThreadEnvMode(newProject)).toBe("local");
    expect(
      resolveNewThreadEnvMode({
        ...newProject,
        workspaceRoot: "C:\\Data\\Projects\\Pinball-Stats",
        newProjectsRoot: "c:/data/projects",
      }),
    ).toBe("local");
  });

  it("keeps the configured default once the project has a thread or is not a new project", () => {
    expect(resolveNewThreadEnvMode({ ...newProject, projectHasThreads: true })).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects" })).toBe(
      "worktree",
    );
    expect(
      resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects/a/nested" }),
    ).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects-old/a" })).toBe(
      "worktree",
    );
    expect(resolveNewThreadEnvMode({ ...newProject, newProjectsRoot: undefined })).toBe("worktree");
  });

  it("lets a project override, or a t3.json the environment defers to, keep worktree mode", () => {
    for (const projectSettings of [
      resolveProjectSettings(
        {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "worktree" } },
        },
        projectId,
        null,
        null,
      ),
      resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, {
        defaultThreadEnvMode: "worktree",
      }),
    ]) {
      expect(resolveNewThreadEnvMode({ ...newProject, projectSettings })).toBe("worktree");
    }
  });
});

describe("projectSettingsOverrides patches", () => {
  it("replaces a project's entry, removes it with null, and drops empty entries", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, enableAgentDeviceAccess: false },
        [otherProjectId]: { defaultAutoPull: false },
      },
    });
    expect(hasProjectSettingsOverrides(first)).toBe(true);
    const replaced = applyServerSettingsPatch(first, {
      projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: false } },
    });
    expect(replaced.projectSettingsOverrides[projectId]).toEqual({
      enableAgentDeviceAccess: false,
    });
    expect(replaced.projectSettingsOverrides[otherProjectId]).toEqual({ defaultAutoPull: false });
    const emptied = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectId]: {} },
    });
    expect(emptied.projectSettingsOverrides[projectId]).toBeUndefined();
    const removed = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectId]: null },
    });
    expect(removed.projectSettingsOverrides).toEqual({
      [otherProjectId]: { defaultAutoPull: false },
    });
    expect(hasProjectSettingsOverrides(DEFAULT_SERVER_SETTINGS)).toBe(false);
  });

  it("derives the legacy per-key maps from the generic record", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true },
        [otherProjectId]: { defaultProjectScripts: [] },
      },
    });
    expect(settings.projectAutoPullOverrides).toEqual({ [projectId]: true });
    expect(settings.projectScriptOverrides).toEqual({ [otherProjectId]: [] });
  });

  it("translates legacy per-key patches into the generic record", () => {
    const written = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectAutoPullOverrides: { [projectId]: true },
    });
    expect(written.projectSettingsOverrides).toEqual({
      [projectId]: { defaultAutoPull: true },
    });
    const cleared = applyServerSettingsPatch(written, {
      projectAutoPullOverrides: { [projectId]: null },
    });
    expect(cleared.projectSettingsOverrides).toEqual({});
  });

  it("lets a canonical entry win over a legacy map for the same project", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    const next = applyServerSettingsPatch(current, {
      projectSettingsOverrides: { [projectId]: { defaultThreadEnvMode: "local" } },
      projectAutoPullOverrides: { [projectId]: true, [otherProjectId]: false },
    });
    expect(next.projectSettingsOverrides).toEqual({
      [projectId]: { defaultThreadEnvMode: "local" },
      [otherProjectId]: { defaultAutoPull: false },
    });
  });
});

describe("resolveWorktreeCleanup", () => {
  it("inherits machine rules, disables one project and keeps custom rules isolated", () => {
    const machine = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: {
        worktreeAfterDays: 8,
        worktreeSettledAfterDays: 2,
        worktreeKeepWhen: "any-local-files",
        worktreeOnDelete: true,
        logsAfterDays: 3,
      },
    });
    const inherited = resolveWorktreeCleanup(machine, projectId);
    expect(inherited).toMatchObject({
      worktreeSettledAfterDays: 2,
      worktreeKeepWhen: "any-local-files",
    });
    const off = applyServerSettingsPatch(machine, {
      projectSettingsOverrides: {
        [projectId]: { worktreeCleanup: { mode: "off" } },
      },
    });
    expect(resolveWorktreeCleanup(off, projectId)).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnDelete: false,
      worktreeOnMerge: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "any-local-files",
    });
    expect(resolveWorktreeCleanup(off, otherProjectId)).toEqual(inherited);
    const custom = applyServerSettingsPatch(off, {
      projectSettingsOverrides: {
        [projectId]: {
          worktreeCleanup: {
            mode: "custom",
            rules: { ...inherited, worktreeAfterDays: 15, worktreeSettledAfterDays: 0 },
          },
        },
      },
    });
    expect(resolveWorktreeCleanup(custom, projectId).worktreeAfterDays).toBe(15);
    expect(resolveWorktreeCleanup(custom, projectId).worktreeSettledAfterDays).toBe(0);
    expect(resolveWorktreeCleanup(custom, otherProjectId)).toEqual(inherited);
    expect(custom.storageCleanup.logsAfterDays).toBe(3);
    const reset = applyServerSettingsPatch(custom, {
      projectSettingsOverrides: {
        [projectId]: clearProjectSettingsOverrides(custom, projectId, ["worktreeCleanup"]),
      },
    });
    expect(resolveWorktreeCleanup(reset, projectId)).toEqual(inherited);
  });
  it("completes partial machine custom rules and preserves them across edits", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: { worktreeAfterDays: 8, worktreeSettledAfterDays: 0, worktreeOnDelete: true },
    });
    const custom = applyServerSettingsPatch(initial, {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnMerge: true } },
    });
    const edited = applyServerSettingsPatch(custom, {
      worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 15 } },
    });
    expect(resolveWorktreeCleanup(edited, null)).toEqual({
      worktreeAfterDays: 15,
      worktreeSettledAfterDays: 0,
      worktreeOnDelete: true,
      worktreeOnMerge: true,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
    });
    expect(
      resolveWorktreeCleanup(applyServerSettingsPatch(edited, { worktreeCleanup: null }), null)
        .worktreeAfterDays,
    ).toBe(8);
  });
});
