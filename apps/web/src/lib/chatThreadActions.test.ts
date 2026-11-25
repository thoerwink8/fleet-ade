import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveCurrentProjectRef,
  resolveNewThreadModelSelectionOverride,
  resolveThreadActionProjectRef,
} from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});

describe("resolveCurrentProjectRef", () => {
  const localEnv = EnvironmentId.make("local");
  const remoteEnv = EnvironmentId.make("remote");
  const activeProj = ProjectId.make("proj-active");
  const draftProj = ProjectId.make("proj-draft");
  const settingsProj = ProjectId.make("proj-settings");
  const projectGroups = [
    {
      projectKey: "group:demo",
      memberProjects: [
        {
          environmentId: localEnv,
          id: settingsProj,
          physicalProjectKey: "local:proj-settings",
        },
        {
          environmentId: remoteEnv,
          id: activeProj,
          physicalProjectKey: "remote:proj-active",
        },
      ],
    },
  ];

  it.each([
    {
      name: "thread page resolves the active thread project",
      input: {
        pathname: "/local/thread-1",
        activeThread: { environmentId: localEnv, projectId: activeProj },
        activeDraftThread: null,
        projectGroups,
      },
      expected: { environmentId: localEnv, projectId: activeProj },
    },
    {
      name: "draft page resolves the active draft project",
      input: {
        pathname: "/draft/draft-1",
        activeThread: undefined,
        activeDraftThread: { environmentId: localEnv, projectId: draftProj },
        projectGroups,
      },
      expected: { environmentId: localEnv, projectId: draftProj },
    },
    {
      name: "project settings page resolves the selected project group member",
      input: {
        pathname: "/settings/projects",
        search: { project: "group:demo" },
        activeThread: undefined,
        activeDraftThread: null,
        projectGroups,
      },
      expected: { environmentId: localEnv, projectId: settingsProj },
    },
    {
      name: "project settings page narrows by machine or checkout",
      input: {
        pathname: "/settings/projects",
        search: { project: "group:demo", machine: remoteEnv, checkout: "remote:proj-active" },
        activeThread: undefined,
        activeDraftThread: null,
        projectGroups,
      },
      expected: { environmentId: remoteEnv, projectId: activeProj },
    },
    {
      name: "project settings page without a selected project returns null",
      input: {
        pathname: "/settings/projects",
        search: {},
        activeThread: undefined,
        activeDraftThread: null,
        projectGroups,
      },
      expected: null,
    },
    {
      name: "settings index and general settings return null even if search retains project",
      input: {
        pathname: "/settings/general",
        search: { project: "group:demo" },
        activeThread: undefined,
        activeDraftThread: null,
        projectGroups,
      },
      expected: null,
    },
    {
      name: "settings index without active thread returns null",
      input: {
        pathname: "/settings",
        search: {},
        activeThread: undefined,
        activeDraftThread: null,
        projectGroups,
      },
      expected: null,
    },
    {
      name: "utility pages without a thread return null",
      input: {
        pathname: "/usage",
        activeThread: undefined,
        activeDraftThread: null,
        projectGroups,
      },
      expected: null,
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(resolveCurrentProjectRef(input)).toEqual(expected);
  });

  it("prefers currentProjectRef in resolveThreadActionProjectRef", () => {
    const currentProjectRef = { environmentId: remoteEnv, projectId: settingsProj };
    expect(
      resolveThreadActionProjectRef({
        currentProjectRef,
        activeThread: undefined,
        activeDraftThread: null,
        defaultProjectRef: { environmentId: localEnv, projectId: activeProj },
        handleNewThread: async () => null,
      }),
    ).toEqual(currentProjectRef);
  });
});
