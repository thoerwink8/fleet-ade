import {
  AcpRegistryOperationError,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type AcpRegistryImportSessionInput,
  type AcpRegistryImportSessionResult,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type Project,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

// ACP imports read history while holding the session-mutation lock, and an agent can
// leave session/load unanswered longer than its own open deadline.
const NATIVE_HISTORY_READ_TIMEOUT = "2 minutes";

/**
 * Whether a thread bound to a native session still lacks its native history.
 * Once a turn has run, the native session also holds that turn's messages, so
 * its history can no longer be imported as run-less items.
 */
export function isNativeHistoryPending(input: {
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly hasRun: boolean;
}): boolean {
  return input.historyOrigin !== "v1_import" && !input.hasRun;
}

interface NativeHistoryMessage {
  readonly role: "user" | "assistant" | "reasoning";
  readonly text: string;
  readonly createdAt: string;
}

function nativeHistoryMessageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: NativeHistoryMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ordinal = input.index + 1;
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(`acp-native-history:turn-item:${input.threadId}:${suffix}`);
  const at = DateTime.makeUnsafe(input.message.createdAt);
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItemEvent = (payload: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
    id: EventId.make(turnItemId),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload,
  });
  if (input.message.role === "reasoning") {
    return [
      turnItemEvent({ ...common, type: "reasoning", text: input.message.text, streaming: false }),
    ];
  }
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`acp-native-history:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    turnItemEvent(turnItem),
  ];
}
export const importedThreadId = (input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: string;
}) =>
  IdAllocator.deriveThreadFromProviderThread({
    driver: input.driver,
    providerInstanceId: input.instanceId,
    nativeThreadId: input.sessionId,
  });

export class AcpRegistrySessions extends Context.Service<
  AcpRegistrySessions,
  {
    readonly project: (projectId: ProjectId) => Effect.Effect<Project, AcpRegistryOperationError>;
    readonly sessionManager: (instanceId: ProviderInstanceId) => Effect.Effect<
      {
        readonly instance: ProviderInstance;
        readonly manager: NonNullable<ProviderInstance["acpSessionManagement"]>;
      },
      AcpRegistryOperationError
    >;
    /**
     * Binds a native ACP session to a T3 thread and copies its history in. Importing a
     * session whose thread still lacks its history repairs that thread instead.
     */
    readonly importSession: (
      input: AcpRegistryImportSessionInput,
    ) => Effect.Effect<AcpRegistryImportSessionResult, AcpRegistryOperationError>;
  }
>()("t3/provider/AcpRegistrySessions") {}

const make = Effect.gen(function* () {
  const projectService = yield* ProjectService.ProjectService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const random = yield* SecureRandom.SecureRandom;

  const project = Effect.fn("AcpRegistrySessions.project")(function* (projectId: ProjectId) {
    const found = yield* projectService.getById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "project_not_found",
            message: `Project ${projectId} is unavailable.`,
            cause,
          }),
      ),
    );
    return yield* Effect.fromOption(
      found,
      () =>
        new AcpRegistryOperationError({
          reason: "project_not_found",
          message: `Project ${projectId} was not found.`,
        }),
    );
  });

  /**
   * Loading a native session replays its history only into the adapter's own
   * snapshot, so copy that snapshot into the thread as run-less history. The
   * `v1_import` origin keeps it in forks and marks the import done, so a call
   * after a failed read repairs the thread and any later call does nothing.
   */
  const importNativeHistory = Effect.fn("AcpRegistrySessions.importNativeHistory")(
    function* (input: { readonly threadId: ThreadId; readonly workspaceRoot: string }) {
      const pendingThread = Effect.map(
        orchestrator.getThreadRecords(input.threadId, ["providerThreads", "runs"]),
        (records) =>
          isNativeHistoryPending({
            historyOrigin: records.thread.historyOrigin,
            hasRun: records.runs.length > 0,
          })
            ? records
            : null,
      );
      // Thread commands write whole thread rows, so hold their lock from the
      // re-read through the write to keep both this marker and their changes.
      const commit = (messages: ReadonlyArray<NativeHistoryMessage>) =>
        threadCommands.withLock(
          input.threadId,
          Effect.gen(function* () {
            const current = yield* pendingThread;
            if (current === null) return 0;
            yield* eventSink.write({
              events: [
                ...messages.flatMap((message, index) =>
                  nativeHistoryMessageEvents({ threadId: input.threadId, index, message }),
                ),
                {
                  id: EventId.make(`acp-native-history:thread:${input.threadId}:native-history`),
                  type: "thread.metadata-updated",
                  threadId: input.threadId,
                  providerInstanceId: current.thread.providerInstanceId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...current.thread, historyOrigin: "v1_import" },
                },
              ],
            });
            return messages.length;
          }),
        );
      const records = yield* pendingThread;
      if (records === null) return 0;
      const { thread, providerThreads } = records;
      const providerThread = providerThreads.find(
        (candidate) =>
          candidate.appThreadId === input.threadId && candidate.nativeThreadRef !== null,
      );
      const nativeThreadId = providerThread?.nativeThreadRef?.nativeId;
      if (providerThread === undefined || nativeThreadId == null) return 0;
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: providerThread.providerInstanceId,
        threadId: input.threadId,
      });
      // The registry admits this open against sign-in changes, like any other open.
      const adapter = yield* registry.get(thread.modelSelection.instanceId);
      const snapshot = yield* adapter
        .openSession({
          threadId: input.threadId,
          providerSessionId,
          modelSelection: thread.modelSelection,
          runtimePolicy: {
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            cwd: thread.worktreePath ?? input.workspaceRoot,
          },
          initialNativeThreadId: nativeThreadId,
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        })
        .pipe(
          Effect.flatMap((session) => session.readThreadSnapshot({ providerThread })),
          Effect.timeout(NATIVE_HISTORY_READ_TIMEOUT),
          Effect.scoped,
        );
      const reasoningIds = new Set(snapshot.reasoningMessageIds);
      const messages = snapshot.messages.flatMap((message) =>
        (message.role === "user" || message.role === "assistant") && message.text.trim() !== ""
          ? [
              {
                role: reasoningIds.has(message.id) ? ("reasoning" as const) : message.role,
                text: message.text,
                createdAt: DateTime.formatIso(message.createdAt),
              },
            ]
          : [],
      );
      // Loading the session can take a while, and the thread is usable meanwhile.
      return yield* commit(messages);
    },
  );

  const sessionManager = Effect.fn("AcpRegistrySessions.sessionManager")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* providerInstances.getInstance(instanceId);
    if (instance === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "instance_not_found",
        message: `Provider instance ${instanceId} was not found.`,
      });
    }
    if (instance.acpSessionManagement === undefined) {
      return yield* new AcpRegistryOperationError({
        reason: "session_list_unsupported",
        message: `Provider instance ${instanceId} does not expose ACP session management.`,
      });
    }
    return { instance, manager: instance.acpSessionManagement };
  });

  const importSession = Effect.fn("AcpRegistrySessions.importSession")(function* (
    input: AcpRegistryImportSessionInput,
  ) {
    const { workspaceRoot } = yield* project(input.projectId);
    const { instance } = yield* sessionManager(input.instanceId);
    const providerSnapshot = yield* instance.snapshot.getSnapshot;
    if (
      providerSnapshot.nativeSessions?.canLoad !== true &&
      providerSnapshot.nativeSessions?.canResume !== true
    ) {
      return yield* new AcpRegistryOperationError({
        reason: "session_resume_unsupported",
        message: "The ACP agent cannot load or resume native sessions.",
      });
    }
    const threadId = importedThreadId({
      driver: instance.driverKind,
      instanceId: input.instanceId,
      sessionId: input.sessionId,
    });
    const existing = yield* threadManagement.getThreadShell(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryOperationError({
            reason: "session_import_failed",
            message: "Could not inspect the imported ACP session mapping.",
            cause,
          }),
      ),
    );
    if (existing !== null) {
      const repairing = isNativeHistoryPending({
        historyOrigin: existing.historyOrigin,
        hasRun: existing.latestRunId !== null,
      });
      yield* importNativeHistory({ threadId, workspaceRoot }).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "session_import_failed",
              message: "Could not import the ACP session history.",
              cause,
            }),
        ),
      );
      return { threadId, imported: repairing } as const;
    }

    const provider = (yield* providerRegistry.getProviders).find(
      (candidate) => candidate.instanceId === input.instanceId,
    );
    const model =
      provider?.models.find((candidate) => candidate.isDefault)?.slug ??
      provider?.models[0]?.slug ??
      "default";
    const commandId = CommandId.make(yield* random.uuidV4());
    const launched = yield* Effect.result(
      startup.enqueueCommand(
        threadLaunch.launch({
          commandId,
          threadId,
          projectId: input.projectId,
          title: input.title ?? "Imported ACP session",
          modelSelection: { instanceId: input.instanceId, model },
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          importedNativeThread: {
            ref: {
              driver: instance.driverKind,
              nativeId: input.sessionId,
              strength: "strong",
            },
            metadata: {
              itemIdentityVersion: 2,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
            },
          },
          createdBy: "user",
          creationSource: "web",
        }),
      ),
    );
    if (Result.isFailure(launched)) {
      const racedImport = yield* threadManagement.getThreadShell(threadId).pipe(
        Effect.mapError(
          (cause) =>
            new AcpRegistryOperationError({
              reason: "session_import_failed",
              message: "Could not inspect the imported ACP session after launch failed.",
              cause,
            }),
        ),
      );
      if (racedImport !== null) return { threadId, imported: false } as const;
      return yield* new AcpRegistryOperationError({
        reason: "session_import_failed",
        message: "Could not create a T3 thread for the ACP session.",
        cause: launched.failure,
      });
    }
    // The thread is usable without its history, so a failed read only logs.
    yield* importNativeHistory({ threadId, workspaceRoot }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not import ACP session history", {
          instanceId: input.instanceId,
          sessionId: input.sessionId,
          cause,
        }),
      ),
    );
    return { threadId, imported: true } as const;
  }, coordinator.withSessionMutation);

  return AcpRegistrySessions.of({ project, sessionManager, importSession });
});

export const layer = Layer.effect(AcpRegistrySessions, make);
