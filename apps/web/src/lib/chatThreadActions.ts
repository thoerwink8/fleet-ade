import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import type { ComposerThreadDraftState, DraftThreadEnvMode } from "../composerDraftStore";

type ComposerModelSelectionState = Pick<
  ComposerThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly currentProjectRef?: ScopedProjectRef | null | undefined;
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export interface CurrentProjectGroupMemberLike {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly physicalProjectKey: string;
}

export interface CurrentProjectGroupLike {
  readonly projectKey: string;
  readonly memberProjects: readonly CurrentProjectGroupMemberLike[];
}

export interface CurrentProjectRouteContext {
  readonly pathname: string;
  readonly search?:
    | {
        readonly project?: unknown;
        readonly machine?: unknown;
        readonly checkout?: unknown;
      }
    | undefined;
  readonly activeThread: ThreadContextLike | null | undefined;
  readonly activeDraftThread: ThreadContextLike | null | undefined;
  readonly projectGroups?: readonly CurrentProjectGroupLike[] | undefined;
}

function nonEmptySearchParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Resolves the project the user is currently looking at (thread, draft, or project settings), or null elsewhere. */
export function resolveCurrentProjectRef(
  input: CurrentProjectRouteContext,
): ScopedProjectRef | null {
  if (input.activeThread) {
    return scopeProjectRef(input.activeThread.environmentId, input.activeThread.projectId);
  }
  if (input.activeDraftThread) {
    return scopeProjectRef(
      input.activeDraftThread.environmentId,
      input.activeDraftThread.projectId,
    );
  }
  if (input.pathname === "/settings/projects" && input.projectGroups) {
    const projectKey = nonEmptySearchParam(input.search?.project);
    if (!projectKey) return null;
    const group = input.projectGroups.find((candidate) => candidate.projectKey === projectKey);
    if (!group) return null;
    const machine = nonEmptySearchParam(input.search?.machine);
    const checkout = nonEmptySearchParam(input.search?.checkout);
    const member = group.memberProjects.find(
      (candidate) =>
        (machine === undefined || candidate.environmentId === machine) &&
        (checkout === undefined || candidate.physicalProjectKey === checkout),
    );
    return member ? scopeProjectRef(member.environmentId, member.id) : null;
  }
  return null;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelSelectionOverride(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carrySelection: ModelSelection | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelSelection | null {
  return (
    input.projectDefaultSelection ??
    (input.carrySourceDraftId === input.destinationDraftId ? null : input.carrySelection)
  );
}

export function hasExplicitComposerModelSelection(
  draft: ComposerModelSelectionState | null | undefined,
): boolean {
  const activeProvider = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeProvider !== null &&
    activeProvider !== undefined &&
    draft.modelSelectionByProvider[activeProvider] !== undefined
  );
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.currentProjectRef) {
    return context.currentProjectRef;
  }
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
