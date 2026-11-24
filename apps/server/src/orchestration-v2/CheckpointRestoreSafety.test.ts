import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2, type ProjectionCheckpointRollbackContext } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

it.effect.each([
  "nested",
  "ancestor",
  "provider",
  "sibling",
  "shared-provider",
  "conversation",
] as const)("preserves overlapping workspace files, owner=%s", (owner) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-restore-" });
    const cwd = path.join(parent, "worktree");
    const nested = path.join(cwd, "nested");
    const sibling = path.join(parent, "worktree2");
    yield* fs.makeDirectory(nested, { recursive: true });
    yield* fs.makeDirectory(sibling);
    const otherFile = path.join(nested, "other-thread.txt");
    yield* fs.writeFileString(otherFile, "other thread's uncommitted work");
    const threadId = ThreadId.make("restore-current");
    const otherId = ThreadId.make("restore-other");
    const projectId = ProjectId.make("restore-project");
    const providerThreadId = ProviderThreadId.make("restore-provider");
    const providerSessionId = ProviderSessionId.make("restore-session");
    const instanceId = ProviderInstanceId.make("restore-instance");
    const checkpointId = CheckpointId.make("restore-checkpoint");
    const scopeId = CheckpointScopeId.make("restore-scope");
    const calls: string[] = [];
    const providerThread = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId: instanceId,
    };
    const otherThread = {
      id: otherId,
      projectId,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: otherId },
      worktreePath:
        owner === "ancestor" || owner === "conversation"
          ? parent
          : owner === "nested"
            ? nested
            : sibling,
    };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath: cwd,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId, model: "test" },
      },
      providerThread,
      providerSession: undefined,
      providerTurns: [],
      rootNodes: [],
      targetAttempt: undefined,
      rolledBackAttemptIds: [],
      staleCheckpoints: [],
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: null },
      scope: { id: scopeId, cwd },
      runsToRollback: [{ id: "later-run", ordinal: 1, status: "completed", rootNodeId: null }],
    } as unknown as ProjectionCheckpointRollbackContext;
    const layerTest = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/synthetic-worktrees" } as never),
          ServerSettings.layerTest(),
          ThreadCommandExecutor.layer,
          IdAllocator.layer,
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeedSome({ workspaceRoot: parent } as never),
          }),
          Layer.mock(ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [otherThread] as never,
                archivedThreads: [],
              }),
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [],
                checkpoints: [],
                checkpointScopes: [],
              }),
            getThreadProviderContext: () =>
              Effect.succeed({
                thread: otherThread as never,
                providerThreads: [],
                providerSessions:
                  owner === "provider" || owner === "shared-provider"
                    ? ([
                        {
                          cwd: owner === "shared-provider" ? cwd : nested,
                          status: "running",
                          capabilities: {
                            sessions: {
                              supportsMultipleProviderThreadsPerSession:
                                owner === "shared-provider",
                            },
                          },
                        },
                      ] as never)
                    : [],
              }),
          }),
          Layer.mock(CheckpointServiceV2)({
            restore: () =>
              Effect.gen(function* () {
                calls.push("files");
                yield* fs.remove(otherFile).pipe(Effect.orDie);
              }),
          }),
          Layer.mock(EventSinkV2)({ write: () => Effect.succeed([]) }),
          Layer.mock(ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                rollbackThread: () =>
                  Effect.sync(() => {
                    calls.push("provider");
                    return { providerThread };
                  }),
              } as never),
          }),
          Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        ),
      ),
    );
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2.pipe(
      Effect.provide(layerTest),
    );
    const restoreFiles = owner !== "conversation";
    const rejected = !["sibling", "shared-provider", "conversation"].includes(owner);
    if (rejected) {
      const error = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.flip);
      assert.equal(error.reason, "shared-workspace");
      assert.deepEqual(calls, []);
      assert.equal(yield* fs.readFileString(otherFile), "other thread's uncommitted work");
    } else {
      yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
      assert.deepEqual(calls, restoreFiles ? ["provider", "files"] : ["provider"]);
      assert.equal(yield* fs.exists(otherFile), !restoreFiles);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("lets rollback recreate a worktree storage cleanup removed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-v2-restore-removed-" });
    const worktreePath = path.join(parent, "worktree");
    const isolated = yield* isCheckpointRestoreIsolated(
      { id: ThreadId.make("restore-removed"), worktreePath },
      { cwd: worktreePath },
      {
        fileSystem,
        path,
        projections: {
          getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
        } as never,
        projects: {} as never,
      },
    );
    assert.isTrue(isolated);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { sideChat: "answering questions", running: false, toolItems: 0, isolated: true },
  { sideChat: "running", running: true, toolItems: 0, isolated: false },
  { sideChat: "after running tools", running: false, toolItems: 1, isolated: false },
] as const)(
  "a side chat $sideChat shares the parent's worktree: $isolated",
  ({ running, toolItems, isolated }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreePath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-v2-restore-side-chat-",
      });
      const parentId = ThreadId.make("restore-side-chat-parent");
      const sideChat = {
        id: ThreadId.make("restore-side-chat"),
        projectId: ProjectId.make("restore-project"),
        deletedAt: null,
        worktreePath,
        activeRunId: running ? "side-chat-run" : null,
        lineage: {
          parentThreadId: parentId,
          relationshipToParent: "fork",
          rootThreadId: parentId,
          sideChat: true,
        },
      };
      const result = yield* isCheckpointRestoreIsolated(
        { id: parentId, worktreePath },
        { cwd: worktreePath },
        {
          fileSystem,
          path,
          projections: {
            getShellSnapshot: () => Effect.succeed({ threads: [sideChat], archivedThreads: [] }),
            getThreadRecords: () =>
              Effect.succeed({
                turnItems: Array.from({ length: toolItems }, () => ({ type: "command_execution" })),
              }),
            getCheckpointContext: () => Effect.succeed({ checkpointScopes: [] }),
            getThreadProviderContext: () => Effect.succeed({ providerSessions: [] }),
          } as never,
          projects: {} as never,
        },
      );
      assert.equal(result, isolated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  {
    name: "ready isolated worktree",
    turnCount: 1,
    checkpointStatus: "ready" as const,
    isolatedWorktree: true,
    overlappingThread: false,
    expected: { canRestoreFiles: true, removedTurnCount: 2 },
  },
  {
    name: "missing checkpoint at thread start",
    turnCount: 0,
    checkpointStatus: "missing" as const,
    isolatedWorktree: true,
    overlappingThread: false,
    expected: { canRestoreFiles: false, reason: "checkpoint-missing", removedTurnCount: 3 },
  },
  {
    name: "shared project directory",
    turnCount: 1,
    checkpointStatus: "ready" as const,
    isolatedWorktree: false,
    overlappingThread: false,
    expected: {
      canRestoreFiles: false,
      reason: "shared-workspace",
      inProjectDirectory: true,
      removedTurnCount: 2,
    },
  },
  {
    name: "overlapping worktree thread",
    turnCount: 1,
    checkpointStatus: "ready" as const,
    isolatedWorktree: true,
    overlappingThread: true,
    expected: {
      canRestoreFiles: false,
      reason: "shared-workspace",
      inProjectDirectory: false,
      removedTurnCount: 2,
    },
  },
] as const)(
  "checkRestoreSafety evaluates $name",
  ({ turnCount, checkpointStatus, isolatedWorktree, overlappingThread, expected }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-v2-precheck-" });
      const worktreeCwd = path.join(parent, "worktree");
      const nestedCwd = path.join(worktreeCwd, "nested");
      yield* fsMakeDir(fileSystem, nestedCwd);
      const threadId = ThreadId.make("precheck-current");
      const otherId = ThreadId.make("precheck-other");
      const projectId = ProjectId.make("precheck-project");
      const scopeId = CheckpointScopeId.make("precheck-scope");
      const cwd = isolatedWorktree ? worktreeCwd : parent;
      const worktreePath = isolatedWorktree ? worktreeCwd : null;
      const serviceLayer = CheckpointRollbackService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ServerConfig.ServerConfig)({
              worktreesDir: "/synthetic-worktrees",
            } as never),
            ServerSettings.layerTest(),
            ThreadCommandExecutor.layer,
            IdAllocator.layer,
            Layer.mock(GitWorkflowService.GitWorkflowService)({}),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: () => Effect.succeedSome({ workspaceRoot: parent } as never),
            }),
            Layer.mock(ProjectionStoreV2)({
              getThread: () =>
                Effect.succeed({
                  id: threadId,
                  projectId,
                  worktreePath,
                } as never),
              getCheckpointContext: () =>
                Effect.succeed({
                  runs: [
                    { id: RunId.make("run-1"), ordinal: 1, status: "completed" },
                    { id: RunId.make("run-2"), ordinal: 2, status: "completed" },
                    { id: RunId.make("run-3"), ordinal: 3, status: "interrupted" },
                    { id: RunId.make("run-4"), ordinal: 4, status: "rolled_back" },
                    { id: RunId.make("run-5"), ordinal: 5, status: "running" },
                  ],
                  checkpointScopes: [{ id: scopeId, runId: null, kind: "thread", cwd }],
                  checkpoints: [
                    {
                      scopeId,
                      runId: turnCount === 0 ? null : RunId.make("run-1"),
                      ordinalWithinScope: turnCount === 0 ? 0 : 1,
                      appRunOrdinal: turnCount === 0 ? null : 1,
                      status: checkpointStatus,
                      ref: "refs/t3/precheck",
                    },
                  ],
                } as never),
              getShellSnapshot: () =>
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 0,
                  threads: overlappingThread
                    ? ([
                        {
                          id: otherId,
                          projectId,
                          deletedAt: null,
                          lineage: {
                            parentThreadId: null,
                            relationshipToParent: null,
                            rootThreadId: otherId,
                          },
                          worktreePath: nestedCwd,
                        },
                      ] as never)
                    : [],
                  archivedThreads: [],
                }),
              getThreadProviderContext: () =>
                Effect.succeed({
                  providerThreads: [],
                  providerSessions: [],
                } as never),
            }),
            Layer.mock(CheckpointServiceV2)({}),
            Layer.mock(EventSinkV2)({}),
            Layer.mock(ProviderSessionManagerV2)({}),
            Layer.mock(RuntimePolicyV2)({}),
          ),
        ),
      );
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2.pipe(
        Effect.provide(serviceLayer),
      );
      const actual = yield* service.checkRestoreSafety({ threadId, turnCount });
      assert.deepEqual(actual, expected);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const fsMakeDir = (fileSystem: FileSystem.FileSystem, directory: string) =>
  fileSystem.makeDirectory(directory, { recursive: true });
