import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import * as commandPalette from "../commandPaletteBus";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import * as storage from "../hooks/useLocalStorage";
import * as threadActions from "../lib/chatThreadActions";
import * as entities from "../state/entities";
import * as projectsState from "../state/projects";
import { Atom } from "effect/reactivity";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import { installChatRouteCommands } from "./chatRouteCommands";
import * as dispatcher from "./dispatcher";

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("new thread commands", () => {
  it.each([
    { count: 2, command: "chat.new", picker: true },
    { count: 1, command: "chat.new", picker: false },
    { count: 2, command: "chat.newLocal", picker: false },
  ] as const)("$count projects, $command: picker=$picker", (scenario) => {
    using _projects = vi
      .spyOn(entities, "readProjects")
      .mockReturnValue([project("active"), project("idle")].slice(0, scenario.count));
    using _ready = vi
      .spyOn(projectsState, "defaultProjectFallbackReadyAtom")
      .mockReturnValue(Atom.make(true));
    using storedProject = vi.spyOn(storage, "getLocalStorageItem").mockReturnValue("local:active");
    using openPicker = vi.spyOn(commandPalette, "openCommandPalette").mockImplementation(() => {});
    using startLocal = vi.spyOn(threadActions, "startNewThreadFromContext").mockResolvedValue(true);
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
    const router = { state: { matches: [] } } as unknown as AnyRouter;
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    const commands = register.mock.calls[0]![0];
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    storedProject.mockReturnValue("local:idle");
    commands[scenario.command]!(event);

    if (scenario.picker) {
      expect(openPicker).toHaveBeenCalledWith({ open: "new-thread-in" });
      expect(startLocal).not.toHaveBeenCalled();
    } else {
      expect(openPicker).not.toHaveBeenCalled();
      expect(startLocal).toHaveBeenCalledOnce();
      expect(startLocal.mock.calls[0]![0].defaultProjectRef).toEqual({
        environmentId: "local",
        projectId: scenario.count === 1 ? "active" : "idle",
      });
    }
  });

  it("creates directly in the active thread or draft project on Ctrl+N even with two projects", () => {
    const active = project("active");
    const idle = project("idle");
    const thread = makeThreadFixture({
      environmentId: active.environmentId,
      projectId: active.id,
      id: ThreadId.make("thread-1"),
    });
    using _projects = vi.spyOn(entities, "readProjects").mockReturnValue([active, idle]);
    using _thread = vi.spyOn(entities, "readThreadShell").mockReturnValue(thread);
    using _ready = vi
      .spyOn(projectsState, "defaultProjectFallbackReadyAtom")
      .mockReturnValue(Atom.make(true));
    using _storedProject = vi.spyOn(storage, "getLocalStorageItem").mockReturnValue("local:idle");
    using openPicker = vi.spyOn(commandPalette, "openCommandPalette").mockImplementation(() => {});
    using startLocal = vi.spyOn(threadActions, "startNewThreadFromContext").mockResolvedValue(true);
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});

    // 1) Thread route
    const threadRouter = {
      state: {
        location: { pathname: "/local/thread-1", search: {} },
        matches: [{ params: { environmentId: "local", threadId: "thread-1" } }],
      },
    } as unknown as AnyRouter;
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(threadRouter));
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;

    register.mock.calls[0]![0]["chat.new"]!(event);
    expect(openPicker).not.toHaveBeenCalled();
    expect(startLocal).toHaveBeenCalledOnce();
    expect(startLocal.mock.calls[0]![0].currentProjectRef).toEqual({
      environmentId: "local",
      projectId: "active",
    });

    // 2) Draft route
    startLocal.mockClear();
    const draftId = DraftId.make("draft-1");
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(
        { environmentId: active.environmentId, projectId: active.id },
        draftId,
        { threadId: ThreadId.make("draft-thread-1") },
      );
    stack.defer(() => {
      const store = useComposerDraftStore.getState();
      store.clearProjectDraftThreadId({
        environmentId: active.environmentId,
        projectId: active.id,
      });
      store.clearDraftThread(draftId);
    });
    const draftRouter = {
      state: {
        location: { pathname: "/draft/draft-1", search: {} },
        matches: [{ params: { draftId } }],
      },
    } as unknown as AnyRouter;
    stack.defer(installChatRouteCommands(draftRouter));
    register.mock.calls[1]![0]["chat.new"]!(event);
    expect(openPicker).not.toHaveBeenCalled();
    expect(startLocal).toHaveBeenCalledOnce();
    expect(startLocal.mock.calls[0]![0].currentProjectRef).toEqual({
      environmentId: "local",
      projectId: "active",
    });
  });
});
