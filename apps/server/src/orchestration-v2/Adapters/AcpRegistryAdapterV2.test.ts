import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  RunAttemptId,
  RunId,
  type ModelSelection,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ServerSettings from "../../serverSettings.ts";
import type { AcpRegistryLiveConfiguration } from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { t3AcpPromptWithInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { AcpRegistryAdapterV2Driver } from "@t3tools/provider-acp-registry/server";
import {
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
  acpRegistryProbeResult,
} from "@t3tools/provider-acp-registry/testing";

const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

const layerInjectedRuntimeCatalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
  resolve: () => Effect.die("the runtime is injected"),
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
  layerRegistry,
  ServerSettings.layerTest(),
);

const REGISTRY_ROOT_SESSION = "registry-session";

/** Replay frames from a neutral ACP Registry agent on ACP v2. */
const registryFrames = {
  open: [
    { type: "expect_outbound", frame: { kind: "request", method: "initialize", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "initialize",
        result: {
          protocolVersion: 2,
          info: { name: "acp-registry-fixture", version: "1.0.0" },
          capabilities: { session: {} },
          authMethods: [],
        },
      },
    },
    { type: "expect_outbound", frame: { kind: "request", method: "session/new", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "session/new",
        result: { sessionId: REGISTRY_ROOT_SESSION },
      },
    },
  ],
  update: (sessionId: string, sessionUpdate: Record<string, unknown>) => ({
    type: "emit_inbound",
    frame: {
      kind: "notification",
      method: "session/update",
      params: { sessionId, update: sessionUpdate },
    },
  }),
  childState: (parent: string, child: string, state: string) =>
    registryFrames.update(parent, {
      sessionUpdate: "subagent_update",
      sessionId: child,
      state: { state },
    }),
  prompt: (ordinal: number) => [
    {
      type: "expect_outbound",
      frame: { kind: "request", method: "session/prompt", params: "<any>" },
    },
    registryFrames.update(REGISTRY_ROOT_SESSION, {
      sessionUpdate: "user_message",
      messageId: `user-${ordinal}`,
      content: [{ type: "text", text: "test prompt" }],
    }),
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "session/prompt",
        result: { messageId: `user-${ordinal}` },
      },
    },
    registryFrames.update(REGISTRY_ROOT_SESSION, {
      sessionUpdate: "state_update",
      state: "running",
    }),
  ],
  idle: (stopReason: string) =>
    registryFrames.update(REGISTRY_ROOT_SESSION, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason,
    }),
  closeRequest: {
    type: "expect_outbound",
    frame: {
      kind: "request",
      method: "session/close",
      params: { sessionId: REGISTRY_ROOT_SESSION },
    },
  },
  closed: {
    type: "emit_inbound",
    frame: { kind: "response", method: "session/close", result: {} },
  },
};
const openRegistryReplaySession = Effect.fn("openRegistryReplaySession")(function* (
  entries: ReadonlyArray<unknown>,
  replayGate?: ProviderReplayGate,
  continuationEnabled = true,
  agentId = "registry-agent",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-acp-registry-lifecycle-",
  });
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: ACP_REGISTRY_PROVIDER,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: "acp-registry-lifecycle",
      entries: entries as never,
    },
    ACP_REGISTRY_PROVIDER,
  );
  const offers: Array<ProviderContinuationRequest> = [];
  const offered = yield* Queue.unbounded<void>();
  const continuationRequests = {
    offer: (request: ProviderContinuationRequest) =>
      Effect.sync(() => {
        offers.push(request);
      }).pipe(Effect.andThen(Queue.offer(offered, undefined)), Effect.asVoid),
  };
  const instanceId = ProviderInstanceId.make("acp-registry-lifecycle");
  let onTermination: NonNullable<
    AcpSessionRuntime.AcpSessionRuntimeOptions["onTermination"]
  > = () => Effect.die("Runtime has not started");
  const replayRuntime = makeAcpReplayRuntime({
    transcript,
    statusPath: path.join(replayDir, "status.json"),
    scriptPath: yield* path.fromFileUrl(
      new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
    ),
    childProcessSpawner,
    fileSystem,
    ...(replayGate === undefined ? {} : { replayGate }),
  });
  const adapterOptions = {
    selfInvocation: yield* resolveSelfInvocation(),
    instanceId,
    settings: yield* decodeAcpRegistryAdapterSettings({ agentId }),
    environment: {},
    ...(continuationEnabled ? { continuationRequests } : {}),
    makeRuntime: (runtimeInput: Parameters<typeof replayRuntime>[0]) => {
      onTermination = runtimeInput.onTermination;
      return replayRuntime(runtimeInput);
    },
  };
  const adapter = yield* makeAcpRegistryAdapterV2(adapterOptions).pipe(
    Effect.provide(layerInjectedRuntimeCatalog),
  );
  const threadId = ThreadId.make("thread-acp-registry-lifecycle");
  const modelSelection = { instanceId, model: "default" } as const;
  const runtimeMode = "approval-required";
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: replayDir,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-acp-registry-lifecycle"),
    modelSelection,
    runtimePolicy,
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => replayGate?.releaseAll()));
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const turnInput = (
    ordinal: number,
    options: { readonly continuation?: boolean } = {},
  ): ProviderAdapter.ProviderAdapterV2TurnInput => ({
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project-acp-registry-lifecycle"),
      title: "ACP Registry Agent",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make(`run-acp-registry-lifecycle-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-acp-registry-lifecycle-${ordinal}`),
    rootNodeId: NodeId.make(`node-acp-registry-lifecycle-${ordinal}`),
    providerThread,
    message: {
      ...(options.continuation === true
        ? { createdBy: "agent" as const, creationSource: "provider" as const }
        : { createdBy: "user" as const, creationSource: "web" as const }),
      messageId: MessageId.make(`message-acp-registry-lifecycle-${ordinal}`),
      text: "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  });
  const until = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (predicate(event)) return seen;
      }
    });
  const throughMarker = (title: string) =>
    until(
      (event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.nativeMetadata?.title === title,
    );
  return {
    runtime,
    providerThread,
    turnInput,
    until,
    throughMarker,
    offers,
    offered,
    terminate: () =>
      onTermination(
        new EffectAcpErrors.AcpTransportError({
          detail: "Injected fixture process exit",
          cause: "test",
        }),
      ),
  };
});

const registryRootSession = REGISTRY_ROOT_SESSION;
const acpFrames = registryFrames;
const openAcpReplaySession = openRegistryReplaySession;

describe("AcpRegistryAdapterV2", () => {
  it("preserves and sanitizes structured ACP errors without exposing arbitrary defects", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded (model: registry-agent).",
    });
    assert.deepEqual(acpRegistryPromptFailure("registry-agent", limit), {
      class: "provider_error",
      message: limit.errorMessage,
      code: "-31001",
      retryable: null,
    });
    assert.equal(
      acpRegistryPromptFailure("registry-agent", new Error("private defect")).message,
      "Provider turn failed.",
    );
    const rejected = acpRegistryPromptFailure(
      "any-agent",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Request rejected. api_key=private-key https://example.test/?token=secret",
      }),
    );
    assert.include(rejected.message, "Request rejected.");
    assert.notInclude(rejected.message, "private-key");
    assert.notInclude(rejected.message, "token=secret");
  });

  describe("the agent's own pickers", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const permissionModeOption = (currentValue: string) => ({
      id: "permission-mode",
      name: "Permission mode",
      category: "mode",
      type: "select",
      currentValue,
      options: ["ask", "auto"].map((value) => ({ value, name: value })),
    });

    const openWithStoredPicks = Effect.fn("openWithStoredPicks")(function* (input: {
      readonly setup: unknown;
      readonly pickFrames: ReadonlyArray<Frame>;
      readonly agentId?: string;
      readonly customModels?: ReadonlyArray<string>;
      readonly storedModel?: string;
      readonly storedModePick?: string;
      readonly turnModels?: ReadonlyArray<string>;
      readonly rejectedModel?: string;
      readonly storedOptions?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
      readonly failsConfiguration?: boolean;
      readonly liveConfiguration?: AcpRegistryLiveConfiguration;
    }) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Scope release gives the replay agent at most a second to exit, so the status
      // read below waits for the agent itself instead of racing its last write.
      const agentExits: Array<Effect.Effect<void>> = [];
      const childProcessSpawner = ChildProcessSpawner.make((command) =>
        spawner
          .spawn(command)
          .pipe(
            Effect.tap((handle) =>
              Effect.sync(() => agentExits.push(Effect.ignore(handle.exitCode))),
            ),
          ),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-stored-picks-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-picks",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.pickFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-stored-picks");
      let published: AcpRegistryLiveConfiguration | undefined;
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: input.agentId ?? "fixture-agent",
          authMethodId: "test",
          customModels: input.customModels ?? [],
        }),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          customModels: input.customModels,
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerInjectedRuntimeCatalog,
            Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
              withForegroundStartup: (_startupKey, effect) => effect,
              getLiveConfiguration: () =>
                Effect.sync(() => Option.fromUndefinedOr(published ?? input.liveConfiguration)),
              publishLiveConfiguration: (_instanceId, configuration) =>
                Effect.sync(() => {
                  published = configuration;
                }),
            }),
          ),
        ),
      );
      const threadId = ThreadId.make("thread-acp-registry-stored-picks");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: replayDir,
      });
      const stored: ModelSelection = {
        instanceId,
        model: input.storedModel ?? "default",
        ...(input.storedModePick === undefined
          ? {}
          : { options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick }] }),
        ...(input.storedOptions === undefined ? {} : { options: input.storedOptions }),
      };
      const configurations: Array<AcpRegistryLiveConfiguration | undefined> = [];
      yield* Effect.gen(function* () {
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-stored-picks"),
          modelSelection: stored,
          runtimePolicy,
        });
        configurations.push(published);
        if (input.turnModels === undefined) return;
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: stored,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        let current = stored;
        for (const [index, model] of input.turnModels.entries()) {
          const target: ModelSelection = { instanceId, model };
          const plan = yield* adapter.planSelectionTransition({
            current,
            target,
            sessionCapabilities: runtime.providerSession.capabilities,
          });
          assert.equal(plan.type, "apply_on_next_turn");
          yield* runtime.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now,
              ordinal: index + 1,
              modelSelection: target,
            }),
          );
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "turn.terminal") {
                  assert.equal(event.status, "completed", event.failure?.message);
                }
              }),
            ),
          );
          configurations.push(published);
          current = target;
        }
      }).pipe(
        Effect.match({
          onFailure: (error) => {
            if (input.failsConfiguration === true) return;
            assert.isDefined(input.rejectedModel);
            assert.equal(
              makeProviderFailure({ cause: error }).message,
              `The agent did not accept the model "${input.rejectedModel}". Choose another model for this provider, then retry.`,
            );
          },
          onSuccess: () => {
            assert.isUndefined(input.rejectedModel);
            assert.notEqual(input.failsConfiguration, true, "configuration should have failed");
          },
        }),
        Effect.scoped,
      );
      yield* Effect.all(agentExits, { discard: true });
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
      return { configurations };
    });

    it.effect("switches an agent that only advertises modes with session/set_mode", () =>
      openWithStoredPicks({
        setup: {
          modes: {
            currentModeId: "default",
            availableModes: ["default", "autoEdit"].map((id) => ({ id, name: id })),
          },
        },
        pickFrames: [
          outbound("session/set_mode", { sessionId: "agent-session", modeId: "autoEdit" }),
          answer("session/set_mode", {}),
        ],
        storedModePick: "autoEdit",
      }).pipe(Effect.provide(layerTest)),
    );

    it.effect("switches a mode config option under its own id", () =>
      openWithStoredPicks({
        setup: { configOptions: [permissionModeOption("ask")] },
        pickFrames: [
          outbound("session/set_config_option", {
            sessionId: "agent-session",
            configId: "permission-mode",
            value: "auto",
          }),
          answer("session/set_config_option", { configOptions: [permissionModeOption("auto")] }),
        ],
        storedModePick: "auto",
      }).pipe(Effect.provide(layerTest)),
    );

    const modelOption = (id: string, currentValue: string, grouped = false) => ({
      id,
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: grouped
        ? [{ group: "models", name: "Models", options: [{ value: "default", name: "Default" }] }]
        : [{ value: "auto", name: "Auto" }],
    });
    const configOptionUpdate = (configOptions: ReadonlyArray<unknown>): Frame => ({
      type: "emit_inbound",
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: "agent-session",
          update: { sessionUpdate: "config_option_update", configOptions },
        },
      },
    });
    const prompt = (...updates: ReadonlyArray<Frame>): ReadonlyArray<Frame> => [
      outbound("session/prompt"),
      ...updates,
      answer("session/prompt", { stopReason: "end_turn" }),
    ];
    const setModel = (modelId: string): ReadonlyArray<Frame> => [
      outbound("session/set_model", { sessionId: "agent-session", modelId }),
      answer("session/set_model", {}),
    ];

    it.effect(
      "discovers session models and switches through live model configuration changes",
      () =>
        Effect.gen(function* () {
          const flatOption = (current: string) => modelOption("live-model", current);
          const groupedOption = (current: string) =>
            modelOption("replacement-model", current, true);
          const { configurations } = yield* openWithStoredPicks({
            setup: {
              models: {
                currentModelId: "hermes",
                availableModels: ["hermes", "auto", "default"].map((modelId) => ({
                  modelId,
                  name: modelId,
                })),
              },
            },
            customModels: ["custom-model"],
            storedModel: "default",
            turnModels: [
              "hermes",
              "custom-model",
              "auto",
              "default",
              "hermes",
              "custom-model",
              "auto",
              "custom-model",
              "default",
              "hermes",
            ],
            pickFrames: [
              ...setModel("default"),
              ...setModel("hermes"),
              ...prompt(),
              ...setModel("custom-model"),
              ...prompt(),
              ...setModel("auto"),
              ...prompt(),
              ...setModel("default"),
              ...prompt(),
              ...setModel("hermes"),
              ...prompt(configOptionUpdate([flatOption("hermes")])),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "live-model",
                value: "custom-model",
              }),
              answer("session/set_config_option", { configOptions: [flatOption("custom-model")] }),
              ...prompt(),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "live-model",
                value: "auto",
              }),
              answer("session/set_config_option", { configOptions: [flatOption("auto")] }),
              ...prompt(configOptionUpdate([groupedOption("auto")])),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "replacement-model",
                value: "custom-model",
              }),
              answer("session/set_config_option", {
                configOptions: [groupedOption("custom-model")],
              }),
              ...prompt(),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "replacement-model",
                value: "default",
              }),
              answer("session/set_config_option", { configOptions: [groupedOption("default")] }),
              ...prompt(configOptionUpdate([])),
              ...setModel("hermes"),
              ...prompt(),
            ],
          });
          assert.deepEqual(
            configurations.map((configuration) => ({
              models: configuration?.models.map((model) => model.id),
              current: configuration?.currentModelId,
            })),
            [
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["hermes", "auto", "default"], current: "hermes" },
              { models: ["hermes", "auto", "default"], current: null },
              { models: ["hermes", "auto", "default"], current: "auto" },
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["auto"], current: null },
              { models: ["auto"], current: null },
              { models: ["default"], current: null },
              { models: ["default"], current: null },
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["hermes", "auto", "default"], current: "hermes" },
            ],
          );
        }).pipe(Effect.provide(layerTest)),
    );

    it.effect.each([
      "config",
      "legacy",
      "updated-config",
      "removed-config",
      "configuration-update",
      "unavailable-before-configuration",
    ] as const)(
      "rejects an unavailable explicit model in a %s catalog before inference",
      (catalog) => {
        const duringTurn = catalog === "updated-config" || catalog === "removed-config";
        const duringConfiguration = catalog === "configuration-update";
        const changesOptions =
          duringConfiguration || catalog === "unavailable-before-configuration";
        const model = duringTurn || duringConfiguration ? "hermes" : "missing";
        const restrictedOption = {
          ...modelOption("model", "other"),
          options: [{ value: "other", name: "Other" }],
        };
        return openWithStoredPicks({
          setup: {
            ...(catalog === "legacy" || catalog === "removed-config"
              ? {
                  models: {
                    currentModelId: "other",
                    availableModels: [{ modelId: "other", name: "Other" }],
                  },
                }
              : {}),
            configOptions:
              catalog === "legacy"
                ? []
                : [
                    {
                      ...modelOption("model", "hermes"),
                      options: [{ value: "hermes", name: "Hermes" }],
                    },
                    ...(changesOptions ? [permissionModeOption("ask")] : []),
                  ],
          },
          storedModel: model,
          ...(duringTurn ? { turnModels: [model, model] } : {}),
          ...(changesOptions ? { storedModePick: "auto" } : {}),
          rejectedModel: model,
          pickFrames: duringTurn
            ? prompt(configOptionUpdate(catalog === "removed-config" ? [] : [restrictedOption]))
            : duringConfiguration
              ? [
                  outbound("session/set_config_option", {
                    sessionId: "agent-session",
                    configId: "permission-mode",
                    value: "auto",
                  }),
                  answer("session/set_config_option", {
                    configOptions: [restrictedOption, permissionModeOption("auto")],
                  }),
                ]
              : [],
        }).pipe(Effect.provide(layerTest));
      },
    );

    // regression: #19519 models come from session model state, not a hardcoded list
    it.effect("keeps unadvertised default and auto selections agent-controlled", () =>
      Effect.gen(function* () {
        const { configurations } = yield* openWithStoredPicks({
          setup: {
            models: {
              currentModelId: "hermes",
              availableModels: ["hermes", "other"].map((modelId) => ({ modelId, name: modelId })),
            },
          },
          storedModel: "default",
          turnModels: ["auto", "default", "other", "default", "auto", "default", "auto"],
          pickFrames: [
            ...prompt(),
            ...prompt(),
            ...setModel("other"),
            ...prompt(
              configOptionUpdate([
                {
                  ...modelOption("live-model", "other"),
                  options: [{ value: "other", name: "Other" }],
                },
              ]),
            ),
            ...prompt(),
            ...prompt(),
            ...prompt(
              configOptionUpdate([
                {
                  ...modelOption("replacement-model", "other", true),
                  options: [
                    {
                      group: "models",
                      name: "Models",
                      options: [{ value: "other", name: "Other" }],
                    },
                  ],
                },
              ]),
            ),
            ...prompt(),
          ],
        });
        assert.deepEqual(
          configurations.map((configuration) => configuration?.currentModelId),
          ["hermes", "hermes", "hermes", "other", "other", "other", "other", "other"],
        );
      }).pipe(Effect.provide(layerTest)),
    );
    it.effect(
      "fails configuration when an option write errors for a reason other than refusal",
      () => {
        const sessionModel = (currentValue: string) => ({
          ...modelOption("model", currentValue),
          options: ["default", "named"].map((value) => ({ value, name: value })),
        });
        const thinking = {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "low",
          options: ["low", "high"].map((value) => ({ value, name: value })),
        };
        return openWithStoredPicks({
          setup: { configOptions: [sessionModel("default")] },
          storedModel: "named",
          storedOptions: [
            { id: "thinking", value: "high" },
            { id: "unavailable", value: "x" },
          ],
          failsConfiguration: true,
          pickFrames: [
            outbound("session/set_config_option", {
              sessionId: "agent-session",
              configId: "model",
              value: "named",
            }),
            answer("session/set_config_option", {
              configOptions: [sessionModel("named"), thinking],
            }),
            outbound("session/set_config_option", {
              sessionId: "agent-session",
              configId: "thinking",
              value: "high",
            }),
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/set_config_option",
                error: { code: -32603, message: "Internal error" },
              },
            },
          ],
        }).pipe(Effect.provide(layerTest));
      },
    );
    const modelOptions = [
      { id: "fast", name: "Fast", category: "model", type: "boolean", currentValue: false },
      {
        id: " ",
        name: "Unnamed",
        category: "model",
        type: "select",
        currentValue: "unaddressable",
        options: [{ value: "unaddressable", name: "Unaddressable" }],
      },
      {
        id: "provider",
        name: "Provider",
        category: "model",
        type: "select",
        currentValue: "gateway",
        options: [
          {
            group: "hosted",
            name: "Hosted",
            options: [
              { value: "gateway", name: "Gateway" },
              { value: "codex", name: "Codex" },
            ],
          },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "later-model",
        options: [{ value: "later-model", name: "Later model" }],
      },
    ] as const;

    it.effect("opens a model from the catalog by writing the first usable model select", () =>
      Effect.gen(function* () {
        const setup = { sessionId: "agent-session", configOptions: modelOptions };
        const catalog = acpRegistryProbeResult(ProviderInstanceId.make("acp-registry-mode-pick"), {
          initializeResult: { protocolVersion: 1 },
          sessionSetupResult: {
            ...setup,
            // The catalog uses the normalized groupId; ACP v1 sends group on the wire.
            configOptions: modelOptions.map((option) =>
              option.id === "provider"
                ? {
                    ...option,
                    options: [{ ...option.options[0], groupId: option.options[0].group }],
                  }
                : option,
            ),
          },
        });
        assert.deepEqual(catalog.models, [
          { id: "gateway", name: "Gateway", description: null },
          { id: "codex", name: "Codex", description: null },
        ]);
        assert.equal(catalog.currentModelId, "gateway");
        const model = catalog.models[1]?.id;
        assert.isDefined(model);
        const opened = yield* openWithStoredPicks({
          setup,
          pickFrames: [
            outbound("session/set_config_option", {
              sessionId: "agent-session",
              configId: "provider",
              value: "codex",
            }),
            answer("session/set_config_option", {
              configOptions: modelOptions.map((option) =>
                option.id === "provider" ? { ...option, currentValue: "codex" } : option,
              ),
            }),
          ],
          storedModel: model,
        });
        assert.equal(opened.configurations.at(-1)?.currentModelId, "codex");
      }).pipe(Effect.provide(layerTest)),
    );
  });

  it.effect("appends omp stdio MCP servers on create and resume without dropping HTTP", () =>
    Effect.gen(function* () {
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* (yield* Path.Path).fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const endpoint = "http://127.0.0.1:43123/mcp";
      const extra = {
        name: "notes",
        command: "C:/tools/notes-mcp",
        args: ["serve"],
        env: [{ name: "NOTES_ADDR", value: "127.0.0.1:9" }],
      };
      let sessionOrdinal = 0;
      const sessionMcpServers = Effect.fn("sessionMcpServers")(function* (
        config: Record<string, unknown>,
        agentEnvironment: Record<string, string> = {},
      ) {
        const requests: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
        sessionOrdinal += 1;
        const instanceId = ProviderInstanceId.make(`acp-omp-stdio-${sessionOrdinal}`);
        const threadId = ThreadId.make(`thread-acp-omp-stdio-${sessionOrdinal}`);
        const mcpSession = {
          environmentId: EnvironmentId.make(`environment-acp-omp-stdio-${sessionOrdinal}`),
          threadId,
          providerSessionId: `mcp-session-acp-omp-stdio-${sessionOrdinal}`,
          providerInstanceId: instanceId,
          endpoint,
        };
        yield* mcpSessions.set({ ...mcpSession, authorizationHeader: "Bearer opened-token" });
        const adapter = yield* makeAcpRegistryAdapterV2({
          selfInvocation,
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings(config),
          environment: {},
          nativeLogging: () => ({
            requestLogger: (event) =>
              Effect.sync(() => {
                if (event.status === "started") requests.push(event);
              }),
          }),
        }).pipe(
          Effect.provide(
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: () =>
                Effect.succeed({
                  distribution: "local" as const,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    env: { T3_ACP_SESSION_LIFECYCLE: "1", ...agentEnvironment },
                  },
                }),
            }),
          ),
        );
        const modelSelection = { instanceId, model: "default" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            `provider-session-acp-omp-stdio-${sessionOrdinal}`,
          ),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* mcpSessions.set({ ...mcpSession, authorizationHeader: "Bearer rotated-token" });
        yield* runtime.resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: ACP_REGISTRY_PROVIDER,
              nativeId: "mock-session-2",
              strength: "strong",
            },
          },
        });
        const sent = (method: string) => {
          const payload = requests.find((event) => event.method === method)?.payload;
          return typeof payload === "object" && payload !== null
            ? Reflect.get(payload, "mcpServers")
            : undefined;
        };
        return { new: sent("session/new"), load: sent("session/load") };
      });
      const stdio = (authorization: string) => [
        {
          name: "t3-code",
          command: selfInvocation.command,
          args: [...selfInvocationArgs(selfInvocation, ["acp-mcp-bridge"])],
          env: [
            { name: "ELECTRON_RUN_AS_NODE", value: "1" },
            { name: "T3_ACP_MCP_ENDPOINT", value: endpoint },
            { name: "T3_ACP_MCP_AUTHORIZATION", value: authorization },
          ],
        },
      ];
      const acp = [{ type: "acp", name: "t3-code", serverId: "t3-code" }];
      const omp = { source: "local", commandPath: "omp", commandArgs: ["acp"] };

      assert.deepEqual(yield* sessionMcpServers(omp), {
        new: stdio("Bearer opened-token"),
        load: stdio("Bearer rotated-token"),
      });
      assert.deepEqual(yield* sessionMcpServers({ ...omp, stdioMcpServers: [extra] }), {
        new: [...stdio("Bearer opened-token"), extra],
        load: [...stdio("Bearer rotated-token"), extra],
      });
      assert.deepEqual(
        yield* sessionMcpServers({ ...omp, stdioMcpServers: [extra] }, { T3_ACP_MCP_HTTP: "1" }),
        {
          new: [...stdio("Bearer opened-token"), extra],
          load: [...stdio("Bearer rotated-token"), extra],
        },
      );
      assert.deepEqual(
        yield* sessionMcpServers(
          { ...omp, stdioMcpServers: [extra] },
          { T3_ACP_MCP_HTTP: "1", T3_ACP_MCP_ACP: "1" },
        ),
        {
          new: [...acp, extra],
          load: [...acp, extra],
        },
      );
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("the agent process env names the thread it serves", () =>
    Effect.gen(function* () {
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* (yield* Path.Path).fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const endpoint = "http://127.0.0.1:43123/mcp";
      const instanceId = ProviderInstanceId.make("acp-registry-thread-env");
      const threadId = ThreadId.make("thread-acp-registry-thread-env");
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-registry-thread-env"),
        threadId,
        providerSessionId: "mcp-session-acp-registry-thread-env",
        providerInstanceId: instanceId,
        endpoint,
        authorizationHeader: "Bearer thread-env-token",
      });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnEnvironments: Array<Record<string, unknown> | undefined> = [];
      const capturingSpawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (command._tag === "StandardCommand") spawnEnvironments.push(command.options.env);
        }).pipe(Effect.andThen(spawner.spawn(command))),
      );
      const withCapturedSpawns = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capturingSpawner),
        );
      const adapter = yield* withCapturedSpawns(
        makeAcpRegistryAdapterV2({
          selfInvocation,
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId: "omp" }),
          environment: {},
        }).pipe(
          Effect.provide(
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: () =>
                Effect.succeed({
                  distribution: "local" as const,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                  },
                }),
            }),
          ),
        ),
      );
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* withCapturedSpawns(
        adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-registry-thread-env"),
          modelSelection,
          runtimePolicy,
        }),
      );
      yield* withCapturedSpawns(runtime.ensureThread({ threadId, modelSelection, runtimePolicy }));
      const agentEnvironment = spawnEnvironments.find(
        (environment) => environment?.T3_ACP_SESSION_LIFECYCLE === "1",
      );
      assert.isDefined(agentEnvironment, "the agent itself must have been spawned");
      assert.equal(agentEnvironment?.T3CODE_THREAD_ID, "thread-acp-registry-thread-env");
      assert.equal(agentEnvironment?.T3_ACP_MCP_ENDPOINT, endpoint);
      assert.equal(agentEnvironment?.T3_ACP_MCP_AUTHORIZATION, "Bearer thread-env-token");
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("replaces streamed root tool output with a later content list", () =>
    Effect.gen(function* () {
      const text = (value: string) => [{ type: "content", content: { type: "text", text: value } }];
      const session = yield* openAcpReplaySession([
        ...acpFrames.open,
        ...acpFrames.prompt(1),
        acpFrames.update(registryRootSession, {
          sessionUpdate: "tool_call_update",
          toolCallId: "root-tool",
          title: "Stream",
          status: "in_progress",
          content: text("one"),
        }),
        acpFrames.update(registryRootSession, {
          sessionUpdate: "tool_call_content_chunk",
          toolCallId: "root-tool",
          content: { type: "content", content: { type: "text", text: "two" } },
        }),
        acpFrames.update(registryRootSession, {
          sessionUpdate: "tool_call_update",
          toolCallId: "root-tool",
          status: "completed",
          content: text("replacement"),
        }),
        acpFrames.update(registryRootSession, {
          sessionUpdate: "tool_call_content_chunk",
          toolCallId: "root-tool",
          content: { type: "content", content: { type: "text", text: "-more" } },
        }),
        acpFrames.update(registryRootSession, {
          sessionUpdate: "tool_call_content_chunk",
          toolCallId: "root-tool",
          content: {
            type: "diff",
            changes: [{ operation: "add", path: "/a.txt" }],
            patch: { format: "git_patch", text: "PATCH" },
          },
        }),
        acpFrames.update(registryRootSession, {
          sessionUpdate: "session_info_update",
          title: "tools complete",
        }),
        acpFrames.idle("end_turn"),
        acpFrames.closeRequest,
        acpFrames.closed,
      ]);
      yield* session.runtime.startTurn(session.turnInput(1));
      const events = yield* session.throughMarker("tools complete");
      const outputs = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.nativeItemRef?.nativeId === "root-tool" &&
        "output" in event.turnItem
          ? [event.turnItem.output]
          : [],
      );
      assert.deepEqual(outputs, [
        text("one"),
        text("onetwo"),
        text("replacement"),
        text("replacement-more"),
        { type: "Text", text: "replacement-morePATCH" },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps stopped tools interrupted when a late output chunk arrives", () =>
    Effect.gen(function* () {
      const session = yield* openAcpReplaySession(
        [
          ...acpFrames.open,
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "session/prompt", params: "<any>" },
          },
          acpFrames.update(registryRootSession, {
            sessionUpdate: "tool_call_update",
            toolCallId: "stopped-tool",
            title: "Stopped tool",
            kind: "execute",
            status: "in_progress",
          }),
          acpFrames.update(registryRootSession, {
            sessionUpdate: "session_info_update",
            title: "before cancel",
          }),
          {
            type: "expect_outbound",
            frame: {
              kind: "notification",
              method: "session/cancel",
              params: { sessionId: registryRootSession },
            },
          },
          acpFrames.update(registryRootSession, {
            sessionUpdate: "tool_call_update",
            toolCallId: "stopped-tool",
            status: "failed",
          }),
          acpFrames.update(registryRootSession, {
            sessionUpdate: "tool_call_update",
            toolCallId: "stopped-tool",
            content: [{ type: "content", content: { type: "text", text: "stopping" } }],
          }),
          acpFrames.update(registryRootSession, {
            sessionUpdate: "tool_call_content_chunk",
            toolCallId: "stopped-tool",
            content: { type: "content", content: { type: "text", text: "late" } },
          }),
          acpFrames.update(registryRootSession, {
            sessionUpdate: "session_info_update",
            title: "late output",
          }),
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/prompt",
              result: { stopReason: "cancelled" },
            },
          },
          acpFrames.update(registryRootSession, {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "cancelled",
          }),
          acpFrames.closeRequest,
          acpFrames.closed,
        ],
        undefined,
        false,
        "registry-agent",
      );
      const starting = yield* session.runtime
        .startTurn(session.turnInput(1))
        .pipe(Effect.forkScoped);
      const started = yield* session.throughMarker("before cancel");
      const running = started.findLast((event) => event.type === "provider_turn.updated");
      if (running?.type !== "provider_turn.updated") throw new Error("Missing active turn");
      const closing = yield* session.runtime
        .interruptTurn({
          providerThread: session.providerThread,
          providerTurnId: running.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
      const events = yield* session.until((event) => event.type === "turn.terminal");
      yield* Fiber.join(closing);
      yield* Fiber.join(starting);
      const tools = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.nativeItemRef?.nativeId?.endsWith("stopped-tool")
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        tools.map((item) => item.status),
        ["interrupted", "interrupted", "interrupted"],
      );
      const lastTool = tools.at(-1);
      assert.equal(
        lastTool !== undefined && "output" in lastTool ? lastTool.output : undefined,
        "stoppinglate",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["before", "after"] as const)(
    "reconciles a full prompt echo %s acknowledgment",
    (ordering) =>
      Effect.gen(function* () {
        const runtimeInstructions = {
          type: "text",
          text: buildRuntimeInstructions({ harness: "acpRegistry", model: "default" }),
        };
        const promptBlocks = (ordinal: number) => [
          {
            type: "text",
            text:
              ordinal === 1
                ? t3AcpPromptWithInstructions({
                    prompt: "test prompt",
                    state: { interactionMode: "default", hasT3Mcp: false },
                  })
                : "test prompt",
          },
          ...(ordinal === 1 ? [runtimeInstructions] : []),
        ];
        const echo = (messageId: string, content: ReadonlyArray<unknown>) =>
          acpFrames.update(registryRootSession, {
            sessionUpdate: "user_message",
            messageId,
            content,
          });
        const promptText = (ordinal: number) =>
          promptBlocks(ordinal)
            .map((block) => block.text)
            .join("\n");
        const frames = (ordinal: number) => {
          const [request, , acknowledgment] = acpFrames.prompt(ordinal);
          const matching = echo(`echo-${ordinal}`, promptBlocks(ordinal));
          return [
            request,
            echo("different-blocks", [
              {
                type: "text",
                text: promptText(ordinal),
                annotations: { audience: ["user"] },
              },
            ]),
            ...(ordering === "before" ? [matching, acknowledgment] : [acknowledgment, matching]),
            acpFrames.update(registryRootSession, {
              sessionUpdate: "user_message_chunk",
              messageId: `echo-${ordinal}`,
              content: { type: "text", text: "updated echo" },
            }),
            echo(`echo-${ordinal}`, [{ type: "text", text: "updated echo" }]),
            echo("second-id", promptBlocks(ordinal)),
            echo("unmatched", [{ type: "text", text: "Continue the review." }]),
            acpFrames.idle("end_turn"),
          ];
        };
        const session = yield* openAcpReplaySession(
          [...acpFrames.open, ...frames(1), ...frames(2), acpFrames.closeRequest, acpFrames.closed],
          undefined,
          false,
        );
        for (const ordinal of [1, 2]) {
          yield* session.runtime.startTurn(session.turnInput(ordinal));
          const events = yield* session.until((event) => event.type === "turn.terminal");
          const messages = events.flatMap((event) =>
            event.type === "message.updated" && event.message.role === "user"
              ? [event.message]
              : [],
          );
          const items = events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "user_message"
              ? [event.turnItem]
              : [],
          );
          const expected = new Set([promptText(ordinal), "Continue the review."]);
          assert.deepEqual(new Set(messages.map((message) => message.text)), expected);
          assert.equal(new Set(messages.map((message) => message.id)).size, 3);
          assert.equal(new Set(items.map((item) => item.id)).size, 3);
          for (const id of ["different-blocks", "second-id", "unmatched"]) {
            assert.isTrue(
              items.some((item) => item.nativeItemRef?.nativeId?.endsWith(`:user:message:${id}`)),
              `${id} remains visible`,
            );
          }
        }
      }).pipe(Effect.provide(layerTest)),
  );
});
