import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2AppThreadLineage,
  type ServerLifecycleStreamEvent,
} from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

const makeStartupTestDependencies = Effect.fn("makeStartupTestDependencies")(function* (input: {
  readonly autoBootstrapProjectFromCwd: boolean;
  readonly projectId: ProjectId;
  readonly events: ServerLifecycleStreamEvent[];
  readonly readyPublished?: Deferred.Deferred<void>;
  readonly failProjectBootstrap?: boolean;
  readonly onBootstrap?: () => void;
  readonly activeShells?: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly lineage: Pick<OrchestrationV2AppThreadLineage, "relationshipToParent" | "sideChat">;
  }>;
}) {
  const recovery = {
    terminalizedRuns: 0,
    stoppedSessions: 0,
    closedRequests: 0,
    retiredEffects: 0,
    requeuedEffects: 0,
  };
  const imports = { importedThreadCount: 0, importedMessageCount: 0 };
  return Layer.mergeAll(
    NodeCrypto.layer,
    Path.layer,
    Layer.mock(ServerConfig.ServerConfig)({
      ...(yield* ServerConfig.deriveServerPaths("/bootstrap-project", undefined).pipe(
        Effect.provide(Path.layer),
      )),
      baseDir: "/bootstrap-project",
      logLevel: "Error",
      traceMinLevel: "Info",
      traceTimingEnabled: false,
      traceBatchWindowMs: 200,
      traceMaxBytes: 1024,
      traceMaxFiles: 1,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      otelEnvironment: OtelEnvironment.none,
      staticDir: undefined,
      devAllowedOrigins: [],
      desktopBootstrapToken: undefined,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      mode: "web",
      cwd: "/bootstrap-project",
      host: "localhost",
      port: 3773,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "browser",
      autoBootstrapProjectFromCwd: input.autoBootstrapProjectFromCwd,
    }),
    Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
    Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
      pendingThreadCount: Effect.succeed(0),
      reconcileShells: Effect.succeed(imports),
      importPendingTranscripts: Effect.succeed(imports),
    }),
    Layer.mock(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)({
      recover: Effect.succeed(recovery),
      prepareForShutdown: Effect.void,
      reconcile: () => Effect.succeed(recovery),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({ recoverDelegatedTasks: Effect.void }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ shutdown: Effect.void }),
    Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: () => Effect.never }),
    Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
      publish: (event) =>
        Effect.gen(function* () {
          const published = { ...event, sequence: input.events.length + 1 };
          input.events.push(published);
          if (published.type === "ready" && input.readyPublished) {
            yield* Deferred.succeed(input.readyPublished, undefined);
          }
          return published;
        }),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      start: Effect.void,
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("bootstrap-environment"),
        label: "Test environment",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      }),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(ProjectService.ProjectService)({
      bootstrap: () => {
        input.onBootstrap?.();
        return input.failProjectBootstrap
          ? Effect.die("project bootstrap failed")
          : Effect.succeed({
              created: true,
              project: {
                id: input.projectId,
                title: "项目",
                workspaceRoot: "/bootstrap-project",
                repositoryIdentity: null,
                faviconPath: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                deletedAt: null,
                defaultModelSelection: null,
              },
            });
      },
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      countThreads: () => Effect.succeed(input.activeShells?.length ?? 0),
      listActiveShellIndex: () => Effect.succeed((input.activeShells ?? []) as never),
    }),
    Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
      managed: false,
      protocol: undefined,
      prepareTrial: () => Effect.undefined,
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    FileSystem.layerNoop({}),
    Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
    Layer.mock(ExternalLauncher.ExternalLauncher)({}),
    Layer.mock(HttpServer.HttpServer)({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
    }),
  );
});

it.effect("bootstraps the cwd project without creating an empty thread on a fresh directory", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("bootstrap-project");
    const events: ServerLifecycleStreamEvent[] = [];
    const readyPublished = yield* Deferred.make<void>();
    let bootstrapCalls = 0;

    const dependencies = yield* makeStartupTestDependencies({
      autoBootstrapProjectFromCwd: true,
      projectId,
      events,
      readyPublished,
      onBootstrap: () => {
        bootstrapCalls += 1;
      },
      activeShells: [],
    });

    yield* Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      yield* startup.markHttpListening;
      const ready = yield* Effect.exit(startup.awaitCommandReady);
      yield* Deferred.await(readyPublished);

      assert.equal(Exit.isSuccess(ready), true);
      assert.equal(bootstrapCalls, 1);

      const welcome = events.find((event) => event.type === "welcome");
      assert.isDefined(welcome);
      if (welcome?.type === "welcome") {
        assert.equal(welcome.payload.bootstrapProjectId, projectId);
        assert.isUndefined(welcome.payload.bootstrapThreadId);
      }
      assert.isDefined(events.find((event) => event.type === "ready"));
    }).pipe(
      Effect.provide(ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(dependencies))),
      Effect.provideService(ServerActivation, Effect.never),
    );
  }),
);

it.effect("fails command readiness without publishing welcome when project bootstrap fails", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("bootstrap-project");
    const events: ServerLifecycleStreamEvent[] = [];

    const dependencies = yield* makeStartupTestDependencies({
      autoBootstrapProjectFromCwd: true,
      projectId,
      events,
      failProjectBootstrap: true,
    });

    yield* Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      yield* startup.markHttpListening;
      const ready = yield* Effect.exit(startup.awaitCommandReady);

      assert.equal(Exit.isFailure(ready), true);
      assert.isUndefined(events.find((event) => event.type === "welcome"));
    }).pipe(
      Effect.provide(ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(dependencies))),
      Effect.provideService(ServerActivation, Effect.never),
    );
  }),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.gen(function* () {
    const gate = yield* ServerRuntimeStartup.makeCommandGate;
    const count = yield* Ref.make(0);
    const queued = yield* gate
      .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
      .pipe(Effect.forkScoped);

    yield* Effect.yieldNow;
    assert.equal(yield* Ref.get(count), 0);
    yield* gate.signalCommandReady;
    assert.equal(yield* Fiber.join(queued), 1);
  }),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.gen(function* () {
    const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
    const failure = yield* Deferred.make<void, never>();

    const queuedCommandFiber = yield* commandGate
      .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
      .pipe(Effect.forkScoped);

    yield* commandGate.failCommandReady(
      new ServerRuntimeStartup.ServerRuntimeStartupError({
        mode: "web",
        host: "127.0.0.1",
        port: 3773,
        cause: new Error("test startup failure"),
      }),
    );

    const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
    assert.equal(error.message, "Server runtime startup failed before command readiness.");
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

it.effect(
  "resolves bootstrapThreadId to an existing listed thread on the cwd project without creating another",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("bootstrap-project");
      const otherProjectId = ProjectId.make("other-project");
      const existingThreadId = ThreadId.make("existing-thread");
      const events: ServerLifecycleStreamEvent[] = [];

      const dependencies = yield* makeStartupTestDependencies({
        autoBootstrapProjectFromCwd: true,
        projectId,
        events,
        activeShells: [
          {
            id: ThreadId.make("other-project-thread"),
            projectId: otherProjectId,
            lineage: { relationshipToParent: null, sideChat: false } as never,
          },
          {
            id: ThreadId.make("subagent-thread"),
            projectId,
            lineage: { relationshipToParent: "subagent", sideChat: false } as never,
          },
          {
            id: existingThreadId,
            projectId,
            lineage: { relationshipToParent: null, sideChat: false } as never,
          },
        ],
      });

      yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
        const ready = yield* Effect.exit(startup.awaitCommandReady);

        assert.equal(Exit.isSuccess(ready), true);
        const welcome = events.find((event) => event.type === "welcome");
        assert.isDefined(welcome);
        if (welcome?.type === "welcome") {
          assert.equal(welcome.payload.bootstrapProjectId, projectId);
          assert.equal(welcome.payload.bootstrapThreadId, existingThreadId);
        }
      }).pipe(
        Effect.provide(ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(dependencies))),
        Effect.provideService(ServerActivation, Effect.never),
      );
    }),
);

it.effect("omits bootstrapThreadId when the cwd project only has unlisted threads", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("bootstrap-project");
    const events: ServerLifecycleStreamEvent[] = [];

    const dependencies = yield* makeStartupTestDependencies({
      autoBootstrapProjectFromCwd: true,
      projectId,
      events,
      activeShells: [
        {
          id: ThreadId.make("subagent-thread"),
          projectId,
          lineage: { relationshipToParent: "subagent", sideChat: false } as never,
        },
        {
          id: ThreadId.make("side-chat-thread"),
          projectId,
          lineage: { relationshipToParent: null, sideChat: true } as never,
        },
      ],
    });

    yield* Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      yield* startup.markHttpListening;
      const ready = yield* Effect.exit(startup.awaitCommandReady);

      assert.equal(Exit.isSuccess(ready), true);
      const welcome = events.find((event) => event.type === "welcome");
      assert.isDefined(welcome);
      if (welcome?.type === "welcome") {
        assert.equal(welcome.payload.bootstrapProjectId, projectId);
        assert.isUndefined(welcome.payload.bootstrapThreadId);
      }
    }).pipe(
      Effect.provide(ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(dependencies))),
      Effect.provideService(ServerActivation, Effect.never),
    );
  }),
);

it.effect("skips project bootstrap when autoBootstrapProjectFromCwd is false", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("bootstrap-project");
    const events: ServerLifecycleStreamEvent[] = [];
    let bootstrapCalls = 0;

    const dependencies = yield* makeStartupTestDependencies({
      autoBootstrapProjectFromCwd: false,
      projectId,
      events,
      onBootstrap: () => {
        bootstrapCalls += 1;
      },
    });

    yield* Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      yield* startup.markHttpListening;
      const ready = yield* Effect.exit(startup.awaitCommandReady);

      assert.equal(Exit.isSuccess(ready), true);
      assert.equal(bootstrapCalls, 0);
      const welcome = events.find((event) => event.type === "welcome");
      assert.isDefined(welcome);
      if (welcome?.type === "welcome") {
        assert.isUndefined(welcome.payload.bootstrapProjectId);
        assert.isUndefined(welcome.payload.bootstrapThreadId);
      }
    }).pipe(
      Effect.provide(ServerRuntimeStartup.layerWithOptions().pipe(Layer.provide(dependencies))),
      Effect.provideService(ServerActivation, Effect.never),
    );
  }),
);
