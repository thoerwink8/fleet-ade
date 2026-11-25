import { shouldShowOpenInPicker } from "./chat/OpenInPicker.logic";
import {
  boundAttachmentIds,
  buildExpiredTerminalContextToastCopy,
  mergeDirectPreviewAnnotation,
  planComposerTurn,
  snapshotComposerSend,
  withMessageContext,
  deriveAvailableRevertTurnCounts,
  deriveThreadPendingBackgroundTasks,
} from "./ChatView.logic";
import {
  isThreadEnvironmentLocked,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
} from "./ChatView.logic";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { deriveProviderInstanceEntries, NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import { evaluateProviderInstanceReadiness } from "./chat/composerProviderReadiness";
import { ensureInlineContextReferences } from "../lib/composerContextReferences";
import {
  responseContextRecord,
  responseContextReference,
  terminalContextReference,
} from "../lib/composerContextRecords";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";

import type { Thread } from "../types";
import { makeThreadFixture, makeThreadProjectionFixture } from "../test-fixtures";
import {
  resolveComposerProviderSelection,
  resolveWorktreeSetupProgress,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resetHeldThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
  createLocalDispatchSnapshot,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  deriveLockedProvider,
  hasServerAcknowledgedLocalDispatch,
  waitForRevertedMessage,
  waitForRollbackOutcome,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: threadId,
    environmentId,
    projectId,
    title: "会话",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

const completedTurn = {
  runId: RunId.make("turn-1"),
  status: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  status: "completed" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("deriveComposerSendState", () => {
  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo [Terminal 1](t3-context://v1/terminal/ctx-expired) waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("isThreadEnvironmentLocked", () => {
  it.each([
    { name: "an empty unbound thread", providerThread: null, expected: false },
    {
      name: "an imported session bound before its first run",
      providerThread: "imported",
      expected: true,
    },
  ])("locks $name: $expected", ({ providerThread, expected }) => {
    expect(
      isThreadEnvironmentLocked({
        messageCount: 0,
        hasRuntime: false,
        activeProviderThreadId:
          providerThread === null ? null : ProviderThreadId.make(providerThread),
      }),
    ).toBe(expected);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("refers to several expired contexts as them", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "empty")).toEqual({
      title: "过期的终端上下文不会发送",
      description: "请移除或重新添加them，才能带上终端输出。",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "消息中已省略过期的终端上下文",
      description: "如果仍需要那段终端输出，请重新添加them。",
    });
    expect(buildExpiredTerminalContextToastCopy(1, "omitted").description).toBe(
      "如果仍需要那段终端输出，请重新添加it。",
    );
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("acknowledges a settled newer background turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
      { submissionIntent: "background" },
    );
    const newerTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestRun: newerTurn,
        runtime: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("holds a first send while the thread shell still reports a preparing run", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const preparingRun = {
      ...completedTurn,
      status: "preparing" as const,
      startedAt: null,
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "disconnected",
        latestRun: preparingRun,
        runtime: { ...readySession, status: "preparing", activeRunId: preparingRun.runId },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it.each([
    ["queued", "message-queued", true],
    ["queued", "message-before-send", false],
    ["preparing", "message-queued", false],
    ["starting", "message-queued", false],
  ] as const)("acknowledges %s with latest message %s: %s", (status, messageId, acknowledged) => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
      { latestUserMessageId: MessageId.make("message-before-send") },
    );
    // The shell hides the silent compaction run, so its runtime reports the queued message's run.
    const queuedRun = {
      ...completedTurn,
      runId: RunId.make("turn-queued"),
      status: "queued" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: null,
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: queuedRun,
        latestUserMessageId: MessageId.make(messageId),
        runtime: { ...readySession, status },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(acknowledged);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      status: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: RunId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: runningTurn.runId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running run", () => {
    const runningRun = {
      ...completedTurn,
      status: "running" as const,
      completedAt: null,
    };
    const runningRuntime = {
      ...readySession,
      status: "running" as const,
      activeRunId: runningRun.runId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: runningRun, runtime: runningRuntime }),
      { latestUserMessageId: MessageId.make("message-before-steer") },
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningRun,
        latestUserMessageId: MessageId.make("message-steer"),
        runtime: runningRuntime,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

describe("deriveCommittedServerUserMessageIds", () => {
  it("tracks only committed user turn items, not assistant rows or projection-only messages", () => {
    const turnStartId = MessageId.make("message-turn-start");
    const steerId = MessageId.make("message-steer");
    const assistantId = MessageId.make("message-assistant");
    const committedAt = DateTime.makeUnsafe("2026-06-26T17:50:15.180Z");
    const runId = RunId.make("run:thread:thread-1:ordinal:1");
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-turn-start"),
        item: {
          id: TurnItemId.make("turn-item:message-turn-start"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: turnStartId,
          inputIntent: "turn_start",
          text: "start",
          attachments: [],
        },
      },
      {
        position: 1,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-assistant"),
        item: {
          id: TurnItemId.make("turn-item:message-assistant"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          type: "assistant_message",
          messageId: assistantId,
          text: "working",
          streaming: false,
        },
      },
      {
        position: 2,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-steer"),
        item: {
          id: TurnItemId.make("turn-item:message-steer"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: steerId,
          inputIntent: "steer",
          text: "continue",
          attachments: [],
        },
      },
    ];

    expect(deriveCommittedServerUserMessageIds(visibleTurnItems)).toEqual(
      new Set([turnStartId, steerId]),
    );
  });
});

describe("resolveThreadSwitchTimeline", () => {
  afterEach(() => {
    resetHeldThreadTimeline();
  });

  const held = { threadKey: "env-1:thread-a", entries: ["a1", "a2"] };

  it("paints a remembered destination instead of the last-viewed thread", () => {
    rememberReadyThreadTimeline(held);
    rememberReadyThreadTimeline({ threadKey: "env-1:thread-b", entries: ["b1", "b2"] });
    expect(peekRememberedThreadTimeline<string[]>("env-1:thread-a")).toEqual(["a1", "a2"]);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual(["a1", "a2"]);
  });

  it("does not paint the last-viewed thread for a destination with nothing remembered", () => {
    rememberReadyThreadTimeline(held);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-2:thread-b",
        nextEntries: [],
      }),
    ).toEqual([]);
  });

  it("does not remember a timeline that still has handoff blob previews", () => {
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "预览",
            runId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "blob:handoff",
              },
            ],
          },
        },
      ]),
    ).toBe(true);
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "预览",
            runId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "https://cdn.example/a.png",
              },
            ],
          },
        },
      ]),
    ).toBe(false);
  });
});

describe("resolveComposerProviderSelection", () => {
  const catalogModels: ServerProvider["models"] = [
    { slug: "gemini-pro", name: "Gemini Pro", isCustom: false, capabilities: null },
  ];

  function entry(driver: string, instanceId = driver, overrides: Partial<ServerProvider> = {}) {
    return deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(instanceId),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: now,
        models: [],
        slashCommands: [],
        skills: [],
        ...overrides,
      },
    ])[0]!;
  }

  function importedThread(instanceId: ProviderInstanceId) {
    return makeThread({
      modelSelection: { instanceId, model: "default" },
      itemCount: 1,
    });
  }

  it.each([
    ["claudeAgent", "claude_work"],
    ["codex", "codex_work"],
    ["ollama", "local_models"],
  ])("keeps imported %s history selectable through its custom instance", (driver, instanceId) => {
    const importedEntry = entry(driver, instanceId);
    const entries = [entry(driver === "codex" ? "claudeAgent" : "codex"), importedEntry];
    const thread = importedThread(importedEntry.instanceId);
    const lockedProvider = deriveLockedProvider({
      thread,
      selectedProvider: entries[0]!.instanceId,
      threadProvider: thread.modelSelection.instanceId,
      providers: entries.map((entry) => entry.snapshot),
    });

    expect(thread.runtime).toBeNull();
    expect(lockedProvider).toBe(driver);
    expect(
      resolveComposerProviderSelection({
        entries,
        candidateInstanceIds: [thread.modelSelection.instanceId],
        lockedProvider,
        lockedInstanceId: thread.modelSelection.instanceId,
      }).selectedProviderEntry?.instanceId,
    ).toBe(importedEntry.instanceId);
  });

  it("keeps the session driver authoritative over instance and draft selections", () => {
    const selected = entry("claudeAgent", "claude_work");
    const sessionEntry = entry("ollama", "local_models");
    const thread = importedThread(selected.instanceId);

    expect(
      deriveLockedProvider({
        thread: {
          ...thread,
          runtime: {
            ...readySession,
            providerName: sessionEntry.driverKind,
            providerInstanceId: sessionEntry.instanceId,
          },
        },
        selectedProvider: selected.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: [selected.snapshot, sessionEntry.snapshot],
      }),
    ).toBe(sessionEntry.driverKind);
  });

  it.each(["missing", "disabled"] as const)(
    "does not move imported history to another driver when its instance is %s",
    (state) => {
      const imported = entry("claudeAgent", "claude_work", { enabled: false });
      const other = entry("codex");
      const entries = state === "missing" ? [other] : [other, imported];
      const thread = importedThread(imported.instanceId);
      const lockedProvider = deriveLockedProvider({
        thread,
        selectedProvider: other.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: entries.map((entry) => entry.snapshot),
      });

      expect(lockedProvider).not.toBeNull();
      expect(
        resolveComposerProviderSelection({
          entries,
          candidateInstanceIds: [other.instanceId, imported.instanceId],
          lockedProvider,
          lockedInstanceId: imported.instanceId,
        }).selectedProviderEntry,
      ).toBeUndefined();
    },
  );

  it("keeps a signed-out selection instead of silently switching providers", () => {
    const signedOutEntry = entry("antigravity", "google_work", {
      status: "error",
      auth: { status: "unauthenticated" },
      models: catalogModels,
    });
    const selection = resolveComposerProviderSelection({
      entries: [entry("codex"), signedOutEntry],
      candidateInstanceIds: [signedOutEntry.instanceId],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    expect(selection.selectedProviderEntry?.instanceId).toBe(signedOutEntry.instanceId);
    expect(
      evaluateProviderInstanceReadiness(selection.selectedProviderEntry?.snapshot, "gemini-pro")
        ?.reason ?? null,
    ).toBe("Antigravity 还没登录，无法发送消息。");
  });

  it("blocks a saved model that a ready catalog no longer lists", () => {
    const provider = entry("antigravity", "google_work", {
      status: "ready",
      models: catalogModels,
    }).snapshot;

    expect(
      evaluateProviderInstanceReadiness(provider, "saved-model-not-in-current-catalog")?.reason ??
        null,
    ).toBe("该 Antigravity 模型已不可用。请选择其他模型。");
    expect(evaluateProviderInstanceReadiness(provider, "gemini-pro")?.reason ?? null).toBeNull();
  });

  it("allows a saved native model to retry after a provider error without changing it", () => {
    const provider = entry("antigravity", "google_work", {
      status: "error",
      models: catalogModels,
    }).snapshot;

    expect(
      evaluateProviderInstanceReadiness(provider, "saved-model-not-in-current-catalog")?.reason ??
        null,
    ).toBeNull();
  });

  it("does not continue an existing Antigravity thread in another profile after deletion", () => {
    const missingInstanceId = ProviderInstanceId.make("google_work");
    const selection = resolveComposerProviderSelection({
      entries: [entry("antigravity")],
      candidateInstanceIds: [missingInstanceId],
      lockedProvider: ProviderDriverKind.make("antigravity"),
      lockedInstanceId: missingInstanceId,
    });

    expect(selection.selectedProviderEntry).toBeUndefined();
    expect(selection.unavailableProviderInstanceId).toBe(missingInstanceId);
  });

  it("keeps the session's continuation group when another instance was selected", () => {
    const sessionEntry = entry("antigravity", "google_work", {
      enabled: false,
      continuation: { groupKey: "work-profile" },
    });
    const anotherEntry = entry("antigravity", "google_personal", {
      continuation: { groupKey: "personal-profile" },
    });
    const selection = resolveComposerProviderSelection({
      entries: [sessionEntry, anotherEntry],
      candidateInstanceIds: [anotherEntry.instanceId, sessionEntry.instanceId],
      lockedProvider: ProviderDriverKind.make("antigravity"),
      lockedInstanceId: sessionEntry.instanceId,
    });

    expect(selection.selectedProviderEntry).toBeUndefined();
  });

  it("picks a signed-in agent for an initial draft when no agent is explicitly selected", () => {
    const unauthenticatedCodex = entry("codex", "codex", {
      status: "error",
      auth: { status: "unauthenticated" },
    });
    const authenticatedClaude = entry("claudeAgent", "claudeAgent", {
      status: "ready",
      auth: { status: "authenticated" },
    });

    const selection = resolveComposerProviderSelection({
      entries: [unauthenticatedCodex, authenticatedClaude],
      candidateInstanceIds: [null, undefined, NO_PROVIDER_MODEL_SELECTION.instanceId, undefined],
      lockedProvider: null,
      lockedInstanceId: null,
    });

    expect(selection.selectedProviderEntry?.instanceId).toBe(authenticatedClaude.instanceId);
  });

  it("prefers Replay for empty new drafts in dev mode without overriding user picks or non-dev defaults", () => {
    const codex = entry("codex", "codex", {
      status: "ready",
      auth: { status: "authenticated" },
    });
    const claude = entry("claudeAgent", "claudeAgent", {
      status: "ready",
      auth: { status: "authenticated" },
    });
    const devReplay = entry("acpRegistry", "devReplay", {
      displayName: "Replay (dev)",
      status: "ready",
      auth: { status: "unknown" },
    });
    const disabledReplay = entry("acpRegistry", "devReplay", {
      displayName: "Replay (dev)",
      enabled: false,
      status: "disabled",
      auth: { status: "unknown" },
    });

    expect(
      resolveComposerProviderSelection({
        entries: [codex, claude, devReplay],
        candidateInstanceIds: [null, undefined, NO_PROVIDER_MODEL_SELECTION.instanceId, undefined],
        lockedProvider: null,
        lockedInstanceId: null,
        preferDevReplay: true,
      }).selectedProviderEntry?.instanceId,
    ).toBe(devReplay.instanceId);

    // User manually chose Claude -> honor Claude even in dev mode.
    expect(
      resolveComposerProviderSelection({
        entries: [codex, claude, devReplay],
        candidateInstanceIds: [claude.instanceId],
        lockedProvider: null,
        lockedInstanceId: null,
        preferDevReplay: true,
      }).selectedProviderEntry?.instanceId,
    ).toBe(claude.instanceId);

    // Non-dev mode keeps Codex even if devReplay is present.
    expect(
      resolveComposerProviderSelection({
        entries: [codex, claude, devReplay],
        candidateInstanceIds: [null, undefined, NO_PROVIDER_MODEL_SELECTION.instanceId, undefined],
        lockedProvider: null,
        lockedInstanceId: null,
        preferDevReplay: false,
      }).selectedProviderEntry?.instanceId,
    ).toBe(codex.instanceId);
    expect(
      resolveComposerProviderSelection({
        entries: [codex, claude, devReplay],
        candidateInstanceIds: [null, undefined, NO_PROVIDER_MODEL_SELECTION.instanceId, undefined],
        lockedProvider: null,
        lockedInstanceId: null,
      }).selectedProviderEntry?.instanceId,
    ).toBe(codex.instanceId);

    // Disabled Replay in dev mode falls back to Codex.
    expect(
      resolveComposerProviderSelection({
        entries: [codex, claude, disabledReplay],
        candidateInstanceIds: [null, undefined, NO_PROVIDER_MODEL_SELECTION.instanceId, undefined],
        lockedProvider: null,
        lockedInstanceId: null,
        preferDevReplay: true,
      }).selectedProviderEntry?.instanceId,
    ).toBe(codex.instanceId);

    // Existing locked thread never switches to Replay.
    expect(
      resolveComposerProviderSelection({
        entries: [
          codex,
          { ...claude, snapshot: { ...claude.snapshot, enabled: false }, enabled: false },
          devReplay,
        ],
        candidateInstanceIds: [claude.instanceId],
        lockedProvider: ProviderDriverKind.make("claudeAgent"),
        lockedInstanceId: claude.instanceId,
        preferDevReplay: true,
      }).selectedProviderEntry,
    ).toBeUndefined();
  });
});

describe("checkout Git memory", () => {
  it("does not confuse an environment id containing the separator with a path", () => {
    rememberCheckoutIsRepo(EnvironmentId.make("env"), "a:b", false);
    expect(recallCheckoutIsRepo(EnvironmentId.make("env:a"), "b")).toBeUndefined();
  });
});

describe("worktree setup visibility", () => {
  const stage = (
    id: "fetch" | "checkout" | "submodules" | "setup-script" | "agent",
    status: "done" | "running" | "failed" | "pending",
  ) => ({
    id,
    status,
    startedAt: now,
    endedAt: status === "running" || status === "pending" ? null : now,
    percent: null,
    detail: null,
    tail: [],
  });
  const base = {
    threadId,
    phase: "running" as const,
    startedAt: now,
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [stage("checkout", "running"), stage("agent", "pending")],
    error: null,
    sequence: 1,
  };
  const settledDone = {
    ...base,
    phase: "done" as const,
    endedAt: now,
    stages: [stage("checkout", "done"), stage("setup-script", "done"), stage("agent", "done")],
  };

  it("uses streamed setup progress immediately without reverting to an older held snapshot", () => {
    const newest = { ...settledDone, sequence: 9 };
    const resolve = (latest: WorktreeSetupSnapshot | null, held: WorktreeSetupSnapshot | null) =>
      resolveWorktreeSetupProgress({
        threadId,
        localPreparing: false,
        runStatus: "running",
        latest,
        held,
      });
    expect(resolve(newest, base)).toEqual({ snapshot: newest, isPreparingWorktree: false });
    expect(resolve(base, newest)).toEqual({ snapshot: newest, isPreparingWorktree: false });
    const other = { ...base, threadId: ThreadId.make("another-thread") };
    expect(resolve(other, other)).toEqual({ snapshot: null, isPreparingWorktree: false });
  });
});

describe("waitForRevertedMessage", () => {
  const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t") };
  const messageId = MessageId.make("message-2");
  const requestId = CommandId.make("rollback-1");

  function projectionAtom() {
    const base = makeThreadProjectionFixture();
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const projection = {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          driver: "codex",
          providerInstanceId: base.thread.providerInstanceId,
          providerSessionId: ProviderSessionId.make("provider-session"),
          appThreadId: base.thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 4,
          handoffIds: [],
          forkedFrom: null,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
      runs: [1, 2, 3, 4].map((ordinal) => ({
        id: RunId.make(`run-${ordinal}`),
        threadId: base.thread.id,
        ordinal,
        providerInstanceId: base.thread.providerInstanceId,
        modelSelection: base.thread.modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message-${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: base.updatedAt,
        startedAt: base.updatedAt,
        completedAt: base.updatedAt,
        checkpointId: null,
        contextHandoffId: null,
      })),
      messages: [
        {
          id: messageId,
          threadId: base.thread.id,
          runId: RunId.make("run-2"),
          nodeId: null,
          role: "user",
          text: "second",
          attachments: [],
          streaming: false,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
    const state = Atom.make({ data: Option.some(projection) });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    return { state, projection };
  }

  afterEach(() => vi.restoreAllMocks());

  it("rejects with the projected reason when the rollback fails for good", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {});
    await Promise.resolve();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: { requestId, message: "The provider could not roll back." },
        },
      }),
    });

    await expect(waiting).rejects.toThrow("The provider could not roll back.");
  });

  it.each([
    ["same", "streamed"],
    ["replacement", "streamed"],
    ["replacement", "refetched"],
  ] as const)(
    "waits for the retained rollback suffix when the edited message and run are paged out (%s provider, %s)",
    async (providerIdentity, projectionSource) => {
      vi.useFakeTimers();
      const { state, projection } = projectionAtom();
      const latestRunId = RunId.make("latest-run-9");
      const latestRun = {
        ...projection.runs[3]!,
        id: latestRunId,
        ordinal: 9,
        userMessageId: MessageId.make("latest-message-9"),
        status: "cancelled" as const,
      };
      const bounded = {
        ...projection,
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 9,
        })),
        runs: [
          {
            ...latestRun,
            id: RunId.make("old-rewound-run-3"),
            userMessageId: MessageId.make("old-rewound-message-3"),
            ordinal: 3,
            status: "rolled_back" as const,
          },
          latestRun,
        ],
      };
      const oldProviderThread = bounded.providerThreads[0]!;
      const completedProviderThread = {
        ...oldProviderThread,
        ...(providerIdentity === "replacement"
          ? { id: ProviderThreadId.make("replacement-provider-thread"), firstRunOrdinal: null }
          : {}),
        lastRunOrdinal: null,
      };
      appAtomRegistry.set(state, { data: Option.some(bounded) });
      let outcome = "pending";
      const waiting = waitForRevertedMessage(threadRef, 0, requestId, async () => {}).then(
        () => {
          outcome = "reverted";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );

      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("pending");

        appAtomRegistry.set(state, {
          data: Option.some({
            ...bounded,
            thread: {
              ...bounded.thread,
              activeProviderThreadId:
                projectionSource === "refetched"
                  ? completedProviderThread.id
                  : oldProviderThread.id,
            },
            providerThreads:
              providerIdentity === "replacement"
                ? [oldProviderThread, completedProviderThread]
                : [completedProviderThread],
            runs: bounded.runs.map((run) =>
              run.id === latestRunId ? { ...run, status: "rolled_back" as const } : run,
            ),
          }),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("reverted");
        await waiting;
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("waits for the requested target when another client finishes a shallower rewind", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    let outcome = "pending";
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {}).then(
      () => {
        outcome = "reverted";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      // Our command is accepted while the earlier target-3 effect is still running.
      const shallowerRewind = {
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: requestId, rollbackFailure: null },
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 3,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 3 ? { ...run, status: "rolled_back" as const } : run,
        ),
      };
      appAtomRegistry.set(state, { data: Option.some(shallowerRewind) });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      appAtomRegistry.set(state, {
        data: Option.some({
          ...shallowerRewind,
          providerThreads: shallowerRewind.providerThreads.map((thread) => ({
            ...thread,
            lastRunOrdinal: 1,
          })),
          runs: shallowerRewind.runs.map((run) =>
            run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
          ),
        }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("reverted");
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects a stale edit already rewound by another client during attachment preparation", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: CommandId.make("other-client-rewind") },
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 1,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
        ),
      }),
    });
    const revert = vi.fn(async () => {});
    let outcome = "pending";
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, revert).then(
      () => {
        outcome = "reverted";
      },
      () => {
        outcome = "rejected";
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("rejected");
      expect(revert).not.toHaveBeenCalled();
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("mergeDirectPreviewAnnotation", () => {
  const annotation = (id: string) =>
    ({
      id,
      pageUrl: "http://localhost:5173/",
      pageTitle: null,
      comment: "tighten this",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: {
        dataUrl: "data:image/png;base64,AAAA",
        width: 10,
        height: 10,
        cropRect: { x: 0, y: 0, width: 10, height: 10 },
      },
      createdAt: "2026-10-16T00:00:00.000Z",
    }) as const;
  const image = (id: string) =>
    ({ id, type: "image", name: `${id}.png`, mimeType: "image/png", sizeBytes: 1 }) as never;

  it("drops the screenshot claim when the attachment cap is full", () => {
    const result = mergeDirectPreviewAnnotation({
      images: [],
      fileCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      previewAnnotations: [],
      direct: { annotation: annotation("a"), image: image("crop") },
    });
    expect(result.images).toEqual([]);
    expect(result.previewAnnotations[0]?.screenshot).toBeNull();
  });
});

describe("snapshotComposerSend", () => {
  const expired = {
    id: "ctx-expired",
    threadId,
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 4,
    lineEnd: 4,
    text: "",
    createdAt: now,
  };
  const live = { ...expired, id: "ctx-live", text: "pnpm test", lineStart: 9, lineEnd: 9 };

  it("drops expired terminal contexts from the contexts and from the prompt", () => {
    const snapshot = snapshotComposerSend({
      prompt: ensureInlineContextReferences("run", [
        terminalContextReference(expired),
        terminalContextReference(live),
      ]),
      images: [],
      files: [],
      terminalContexts: [expired, live],
      sendableTerminalContexts: [live],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      environmentContexts: [],
      replyTo: null,
    });

    expect(snapshot.terminalContexts).toEqual([live]);
    expect(snapshot.messageText).toBe(
      ensureInlineContextReferences("run", [terminalContextReference(live)]).trim(),
    );
  });

  it("sends a reply as a reference and restores it without one", () => {
    const replyTo = responseContextRecord({
      citation: {
        version: 1,
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("message-1"),
        text: "Done. I added clamp next to sum.",
        start: 0,
        end: 32,
        prefix: "",
        suffix: "",
      },
      itemId: TurnItemId.make("item-1"),
      subagents: [],
    });
    const reference = responseContextReference(replyTo);
    const snapshot = snapshotComposerSend({
      prompt: ensureInlineContextReferences("", [reference]) + " why there?",
      images: [],
      files: [],
      terminalContexts: [],
      sendableTerminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      environmentContexts: [],
      replyTo,
    });

    expect(snapshot.messageText).toContain(`t3-context://v1/response/${replyTo.contextId}`);
    expect(snapshot.draftText).toBe("why there?");
    expect(snapshot.replyTo).toBe(replyTo);
  });
});

describe("planComposerTurn", () => {
  const base = {
    messageText: "hello",
    sendQueuesBehindSetup: false,
    isServerThread: false,
    activeMessageCount: 0,
    sendEnvMode: "worktree" as const,
    worktreePath: null,
    activeThreadBranch: "main",
    resumeCompactionTokens: null,
    keepFullHistory: false,
    phase: "ready" as const,
    dispatchMode: "auto" as const,
    freshContext: false,
  };

  it("prepares a worktree from the selected branch on a new thread", () => {
    expect(planComposerTurn(base)).toMatchObject({
      missingWorktreeBaseBranch: false,
      baseBranchForWorktree: "main",
      shouldQueueBehindActiveRun: false,
    });
  });

  it("refuses a new worktree without a base branch", () => {
    expect(planComposerTurn({ ...base, activeThreadBranch: null })).toMatchObject({
      missingWorktreeBaseBranch: true,
      baseBranchForWorktree: null,
    });
  });

  it("queues behind a compaction of a stale session, except for /compact itself", () => {
    const stale = { ...base, resumeCompactionTokens: 120_000 };
    for (const messageText of ["hello", "/compactfoo"]) {
      expect(planComposerTurn({ ...stale, messageText })).toMatchObject({
        compactBeforeSend: true,
        turnDispatchMode: "queue",
        shouldQueueBehindActiveRun: true,
      });
    }
    for (const messageText of ["/COMPACT", "/compact keep the API notes", "/compact\n  tests"]) {
      expect(planComposerTurn({ ...stale, messageText })).toMatchObject({
        compactBeforeSend: false,
        turnDispatchMode: "auto",
        shouldQueueBehindActiveRun: false,
      });
    }
  });

  it("queues behind a running turn only when asked to", () => {
    const running = {
      ...base,
      isServerThread: true,
      activeMessageCount: 3,
      phase: "running" as const,
    };
    expect(planComposerTurn({ ...running, dispatchMode: "queue" }).shouldQueueBehindActiveRun).toBe(
      true,
    );
    expect(planComposerTurn({ ...running, dispatchMode: "steer" })).toMatchObject({
      shouldQueueBehindActiveRun: false,
      baseBranchForWorktree: null,
    });
    expect(
      planComposerTurn({ ...running, sendQueuesBehindSetup: true, dispatchMode: "steer" }),
    ).toMatchObject({
      turnDispatchMode: "steer",
      shouldQueueBehindActiveRun: true,
    });
    // A fresh session cannot join the running turn, and a stale one is not compacted first.
    expect(
      planComposerTurn({
        ...running,
        dispatchMode: "steer",
        freshContext: true,
        resumeCompactionTokens: 120_000,
      }),
    ).toMatchObject({
      compactBeforeSend: false,
      turnDispatchMode: "queue",
      shouldQueueBehindActiveRun: true,
    });
  });
});

describe("withMessageContext", () => {
  const context = { records: [] } as unknown as NonNullable<
    Parameters<typeof withMessageContext>[0]["context"]
  >;

  it("sends the context inline", () => {
    expect(withMessageContext({ text: "hi", context })).toEqual({ text: "hi", context });
  });

  it("sends the text alone without context", () => {
    expect(withMessageContext({ text: "hi", context: undefined })).toEqual({ text: "hi" });
  });
});

describe("boundAttachmentIds", () => {
  it("prefers the uploaded id and falls back to the local one", () => {
    expect(
      boundAttachmentIds([{ id: "upload-1" }, {}], [{ id: "local-1" }, { id: "local-2" }]),
    ).toEqual(["upload-1", "local-2"]);
  });
});

describe("deriveAvailableRevertTurnCounts", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const otherProviderThreadId = ProviderThreadId.make("other-provider-thread");

  function projection(input: { readonly providerSessionId: ProviderSessionId | null }) {
    const base = makeThreadProjectionFixture();
    const run = (ordinal: number) => ({
      id: RunId.make(`run-${ordinal}`),
      ordinal,
      activeAttemptId: `attempt-${ordinal}`,
    });
    const turn = (ordinal: number, attempt: number, threadId: ProviderThreadId) => ({
      id: `turn-${attempt}-${ordinal}`,
      runAttemptId: `attempt-${attempt}`,
      ordinal,
      providerThreadId: threadId,
    });
    return {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          providerInstanceId: base.thread.modelSelection.instanceId,
          providerSessionId: input.providerSessionId,
        },
      ],
      runs: [run(1), run(2), run(3)],
      attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, providerTurnId: null })),
      // Run 2's latest turn moved to another provider thread, so its checkpoint cannot restore
      // this conversation.
      providerTurns: [
        turn(1, 1, providerThreadId),
        turn(1, 2, providerThreadId),
        turn(2, 2, otherProviderThreadId),
        turn(1, 3, providerThreadId),
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
  }

  it("offers the thread start and runs whose latest turn is on the active provider thread", () => {
    const available = deriveAvailableRevertTurnCounts(
      projection({ providerSessionId: ProviderSessionId.make("session") }),
    );
    expect([...available].toSorted()).toEqual([0, 1, 3]);
  });

  it("offers nothing without a provider session to rewind", () => {
    expect(deriveAvailableRevertTurnCounts(projection({ providerSessionId: null })).size).toBe(0);
    expect(deriveAvailableRevertTurnCounts(null).size).toBe(0);
  });
});

describe("deriveThreadPendingBackgroundTasks", () => {
  const base = makeThreadProjectionFixture();
  const run = (ordinal: number, status: string) => ({
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    status,
  });
  const item = (ordinal: number, type: string, nativeId: string, input: string) => ({
    id: TurnItemId.make(`item-${nativeId}`),
    type,
    status: "running",
    title: null,
    runId: RunId.make(`run-${ordinal}`),
    nativeItemRef: { nativeId },
    input,
  });
  const projection = (overrides: object) =>
    ({ ...base, ...overrides }) as unknown as ReturnType<typeof makeThreadProjectionFixture>;

  it.each(["queued", "preparing", "running"])(
    "keeps an earlier run's background shell while a %s follow-up run has a foreground command",
    (followUpStatus) => {
      expect(
        deriveThreadPendingBackgroundTasks(
          projection({
            runs: [run(1, "completed"), run(2, followUpStatus)],
            turnItems: [
              item(1, "command_execution", "shell-1", "sleep 600"),
              item(2, "command_execution", "shell-2", "sleep 15"),
            ],
          }),
        ),
      ).toEqual([{ taskId: "shell-1", description: "sleep 600", kind: "command" }]);
    },
  );

  it("does not list a live run's child from the provider roster as background", () => {
    // The roster is not run-tied; Muse keys it by the child session id its rows carry.
    expect(
      deriveThreadPendingBackgroundTasks(
        projection({
          runs: [run(1, "completed"), run(2, "running")],
          providerThreads: [
            {
              id: "provider-thread-1",
              providerInstanceId: base.thread.providerInstanceId,
              pendingBackgroundTasks: [
                { taskId: "child-session-1", kind: "subagent" },
                { taskId: "child-session-2", kind: "subagent" },
              ],
            },
          ],
          turnItems: [
            { ...item(1, "subagent", "child-session-1", ""), prompt: "child 1" },
            { ...item(2, "subagent", "child-session-2", ""), prompt: "child 2" },
          ],
        }),
      ),
    ).toEqual([
      {
        taskId: "child-session-1",
        kind: "subagent",
        providerInstanceId: base.thread.providerInstanceId,
      },
    ]);
  });

  it("keeps an earlier run's roster-only monitor while a follow-up run executes", () => {
    // Claude completes the Monitor launch row on success; only the roster tracks the task.
    expect(
      deriveThreadPendingBackgroundTasks(
        projection({
          runs: [run(1, "completed"), run(2, "running")],
          providerThreads: [
            {
              id: "provider-thread-1",
              providerInstanceId: base.thread.providerInstanceId,
              pendingBackgroundTasks: [{ taskId: "b1htjkjev", kind: "monitor" }],
            },
          ],
          turnItems: [
            { ...item(1, "dynamic_tool", "toolu-monitor", ""), status: "completed" },
            item(2, "command_execution", "shell-2", "sleep 15"),
          ],
        }),
      ),
    ).toEqual([{ taskId: "b1htjkjev", kind: "monitor" }]);
  });

  it("keeps the provider roster while a follow-up run only waits in the queue", () => {
    expect(
      deriveThreadPendingBackgroundTasks(
        projection({
          runs: [run(1, "waiting"), run(2, "queued")],
          providerThreads: [
            {
              id: "provider-thread-1",
              providerInstanceId: base.thread.providerInstanceId,
              pendingBackgroundTasks: [{ taskId: "task-1", kind: "background_task" }],
            },
          ],
        }),
      ),
    ).toEqual([{ taskId: "task-1", kind: "background_task" }]);
  });
});

describe("Open in for the host environment", () => {
  it("shows both local environments when the primary has a separate WSL home", () => {
    const primaryEnvironmentId = EnvironmentId.make("wsl");
    const hostEnvironmentId = EnvironmentId.make("host");
    for (const [activeThreadEnvironmentId, visible] of [
      [primaryEnvironmentId, true],
      [hostEnvironmentId, true],
      [EnvironmentId.make("other"), false],
    ] as const) {
      expect(
        shouldShowOpenInPicker({
          activeProjectName: "Project",
          activeThreadEnvironmentId,
          primaryEnvironmentId,
          hostEnvironmentId,
          remoteOpenMode: "local-exec",
        }),
      ).toBe(visible);
    }
  });
});

describe("waitForRollbackOutcome", () => {
  const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t") };
  const requestId = CommandId.make("stop-and-rollback-1");

  function projectionAtom() {
    const projection = makeThreadProjectionFixture();
    const state = Atom.make({ data: Option.some(projection) });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    return { state, projection };
  }
  const setThread = (handle: ReturnType<typeof projectionAtom>, patch: Record<string, unknown>) =>
    appAtomRegistry.set(handle.state, {
      data: Option.some({
        ...handle.projection,
        thread: { ...handle.projection.thread, ...patch },
      } as never),
    });

  afterEach(() => vi.restoreAllMocks());

  it("resolves only when the completed id is the one this client sent", async () => {
    const handle = projectionAtom();
    let outcome = "pending";
    const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {}).then(
      () => {
        outcome = "completed";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );
    await Promise.resolve();
    setThread(handle, { rollbackCompletedRequestId: CommandId.make("someone-else") });
    await Promise.resolve();
    expect(outcome).toBe("pending");
    setThread(handle, { rollbackCompletedRequestId: requestId });
    await waiting;
    expect(outcome).toBe("completed");
  });

  it("rejects with the stored code when this request fails", async () => {
    const handle = projectionAtom();
    const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {});
    await Promise.resolve();
    setThread(handle, {
      rollbackFailure: { requestId, message: "no snapshot", code: "checkpoint-missing" },
    });
    await expect(waiting).rejects.toMatchObject({ code: "checkpoint-missing" });
  });

  it("keeps waiting through an unanswered stop while the rewind is held", async () => {
    const handle = projectionAtom();
    let settled = false;
    const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {}).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    setThread(handle, {
      pendingRollback: { requestId, turnCount: 1, restoreFiles: true, requestedAt: now },
      rollbackFailure: { requestId, message: "x", code: "interrupt-unresponsive" },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    setThread(handle, {
      pendingRollback: null,
      rollbackFailure: null,
      rollbackCompletedRequestId: requestId,
    });
    await waiting;
  });

  describe("when the held rewind disappears without a result", () => {
    const held = { requestId, turnCount: 1, restoreFiles: false, requestedAt: now };
    afterEach(() => vi.useRealTimers());

    it("ends within the settle window instead of the long timeout, and says it did not finish", async () => {
      vi.useFakeTimers();
      const handle = projectionAtom();
      const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {}, {
        settleMs: 5_000,
      });
      const result = waiting.then(
        () => "completed",
        (error: Error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(0);
      setThread(handle, { pendingRollback: held });
      // Another client cancels: the held rewind is simply gone.
      setThread(handle, { pendingRollback: null });
      await vi.advanceTimersByTimeAsync(4_999);
      let outcome = "pending";
      void result.then((value) => {
        outcome = value;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe("回退没有完成，可能已被取消。可以重新回退。");
    });

    it("ends at once when the held rewind goes while a run is still active, since it was cancelled", async () => {
      const handle = projectionAtom();
      const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {});
      await Promise.resolve();
      appAtomRegistry.set(handle.state, {
        data: Option.some({
          ...handle.projection,
          runs: [{ status: "running" }],
          thread: { ...handle.projection.thread, pendingRollback: held },
        } as never),
      });
      appAtomRegistry.set(handle.state, {
        data: Option.some({
          ...handle.projection,
          runs: [{ status: "running" }],
          thread: { ...handle.projection.thread, pendingRollback: null },
        } as never),
      });
      await expect(waiting).rejects.toMatchObject({ _tag: "RewindNotCompletedError" });
    });

    it("still completes when the queued rollback lands inside the settle window", async () => {
      vi.useFakeTimers();
      const handle = projectionAtom();
      const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {}, {
        settleMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      setThread(handle, { pendingRollback: held });
      setThread(handle, { pendingRollback: null });
      await vi.advanceTimersByTimeAsync(2_000);
      setThread(handle, { rollbackCompletedRequestId: requestId });
      await expect(waiting).resolves.toBeUndefined();
    });

    it("keeps the long timeout when the rewind was never seen held", async () => {
      vi.useFakeTimers();
      projectionAtom();
      const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {}, {
        settleMs: 5_000,
        timeoutMs: 120_000,
      });
      const result = waiting.then(
        () => "completed",
        (error: Error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(119_999);
      let outcome = "pending";
      void result.then((value) => {
        outcome = value;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe("等待会话回退超时。");
    });
  });

  describe("when the server marks cancelled and in-progress rewinds", () => {
    const held = { requestId, turnCount: 1, restoreFiles: false, requestedAt: now };
    afterEach(() => vi.useRealTimers());

    it("ends at once, as cancelled, when another client cancels the held rewind", async () => {
      // No run is active, which the grace-period path could not tell apart from a queued rewind.
      const handle = projectionAtom();
      const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {}, {
        markers: true,
      });
      await Promise.resolve();
      setThread(handle, { pendingRollback: held });
      setThread(handle, { pendingRollback: null, rollbackCancelledRequestId: requestId });
      await expect(waiting).rejects.toMatchObject({
        _tag: "RewindCancelledElsewhereError",
        message: "回退已取消。",
      });
    });

    it("waits without a deadline once the rewind is queued, then completes", async () => {
      vi.useFakeTimers();
      const handle = projectionAtom();
      let outcome = "pending";
      const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {}, {
        markers: true,
        settleMs: 5_000,
        timeoutMs: 8_000,
      }).then(
        () => {
          outcome = "completed";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      setThread(handle, { pendingRollback: held });
      setThread(handle, { pendingRollback: null, rollbackInProgressRequestId: requestId });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(outcome).toBe("pending");
      setThread(handle, {
        rollbackInProgressRequestId: null,
        rollbackCompletedRequestId: requestId,
      });
      await waiting;
      expect(outcome).toBe("completed");
    });

    it("does not wait out a grace period when the held rewind goes without any marker", async () => {
      const handle = projectionAtom();
      const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {}, {
        markers: true,
      });
      await Promise.resolve();
      setThread(handle, { pendingRollback: held });
      setThread(handle, { pendingRollback: null });
      await expect(waiting).rejects.toMatchObject({ _tag: "RewindNotCompletedError" });
    });

    it("keeps the grace period on a server without the capability", async () => {
      vi.useFakeTimers();
      const handle = projectionAtom();
      const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {}, {
        settleMs: 5_000,
      });
      const result = waiting.then(
        () => "completed",
        (error: Error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(0);
      setThread(handle, { pendingRollback: held });
      setThread(handle, { pendingRollback: null });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toBe("回退没有完成，可能已被取消。可以重新回退。");
    });
  });

  it("stops quietly when cancelled and ignores a completion that arrives later", async () => {
    const handle = projectionAtom();
    const controller = new AbortController();
    const waiting = waitForRollbackOutcome(threadRef, requestId, async () => {}, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "RewindCancelledError" });
    // Nothing is listening any more: a late completion or failure changes nothing.
    setThread(handle, { rollbackCompletedRequestId: requestId });
    setThread(handle, { rollbackFailure: { requestId, message: "late" } });
  });
});
