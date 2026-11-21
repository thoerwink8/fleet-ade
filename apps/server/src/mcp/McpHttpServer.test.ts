import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ProjectService from "../project/ProjectService.ts";
import * as FleetSummaryReporter from "../ledger/FleetSummaryReporter.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerConfig from "../config.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const coordinator = descriptorOf("environment-mcp-test", "Coordinator Test Node");
const threadId = ThreadId.make("thread-mcp-test");
const invocation = {
  environmentId,
  requestNamespace: "provider-session-mcp-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>(),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const layerPullRequestsTest = McpHttpServer.layerPullRequestsToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
      Layer.mock(PullRequestService.PullRequestService)({}),
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      NodeServices.layer,
      NodeCrypto.layer,
    ),
  ),
);

/** Records every span and the order spans start and end in, by span ID. */
const recordSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const order: Array<string> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      order.push(`start ${span.spanId}`);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        order.push(`end ${span.spanId}`);
      };
      return span;
    },
  });
  return { tracer, spans, order };
};

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const RecordingToolkit = Toolkit.make(
  OrchestratorToolkit.tools.delegate_task,
  OrchestratorToolkit.tools.t3_thread_read,
  OrchestratorToolkit.tools.t3_thread_wait,
  ProjectToolkit.tools.t3_project_update,
  ProjectToolkit.tools.t3_thread_launch,
);
const layerRecordingTools = (calls: Array<unknown>) => {
  const record = McpToolAccess.reads((params: unknown) =>
    Effect.sync(() => calls.push(params)).pipe(
      Effect.andThen(
        Effect.fail(new OrchestratorMcpFailure({ code: "thread_not_found", message: "Recorded." })),
      ),
    ),
  );
  return McpHttpServer.toolkitRegistration(
    RecordingToolkit,
    McpToolAccess.toLayer(RecordingToolkit, {
      delegate_task: record,
      t3_thread_read: record,
      t3_thread_wait: record,
      t3_project_update: record,
      t3_thread_launch: record,
    }),
  ).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(
      Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(FleetSummaryReporter.FleetSummaryReporter)({
          trackAdhoc: () => Effect.void,
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: process.cwd(),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        Layer.mock(DocumentText.DocumentText)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" }),
        NodeCrypto.layer,
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

it.effect("advertises the compact input schema for every registered tool", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools: Record<string, Tool.Any> = RecordingToolkit.tools;

    expect(server.tools.length).toBe(Object.keys(tools).length);
    for (const { tool } of server.tools) {
      expect(tool.inputSchema, tool.name).toEqual(advertisedJsonSchema(tools[tool.name]!));
    }
  }).pipe(Effect.provide(layerRecordingTools([]))),
);

it.effect("decodes null optional arguments the way it decodes omitted ones", () => {
  const calls: Array<unknown> = [];
  return Effect.gen(function* () {
    const thread = { threadId: "thread-null-arguments" };
    yield* callTool("t3_thread_read", thread);
    yield* callTool("t3_thread_read", { ...thread, afterPosition: null, view: null });
    yield* callTool("delegate_task", { task: "Inspect", target: {} });
    yield* callTool("delegate_task", { task: "Inspect", title: null, target: { model: null } });
    yield* callTool("t3_project_update", { projectId: "project-1", projectIcon: null });

    expect(calls).toHaveLength(5);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[3]).toEqual(calls[2]);
    expect(calls[4]).toStrictEqual({ projectId: "project-1", projectIcon: null });
  }).pipe(Effect.provide(layerRecordingTools(calls)));
});

it.effect("rejects arguments a tool does not declare instead of dropping them", () => {
  const calls: Array<unknown> = [];
  return Effect.gen(function* () {
    const launch = yield* Effect.flip(
      callTool("t3_thread_launch", { title: "Repro", scratch: true, prompt: "say hi" }),
    );
    const wait = yield* Effect.flip(
      callTool("t3_thread_wait", { threadId: "thread-excess-arguments", timeout: 5_000 }),
    );

    expect(calls).toEqual([]);
    expect(launch.message).toContain('Unknown argument "prompt"');
    expect(wait.message).toContain('Unknown argument "timeout"');
  }).pipe(Effect.provide(layerRecordingTools(calls)));
});

it.effect("accepts a nested key the merged advertised schema shows", () => {
  const calls: Array<unknown> = [];
  return Effect.gen(function* () {
    yield* Effect.exit(
      callTool("t3_thread_launch", {
        title: "Root",
        projectId: "project-1",
        message: "say hi",
        workspaceStrategy: { type: "root", baseRef: "main" },
      }),
    );

    expect(calls).toHaveLength(1);
  }).pipe(Effect.provide(layerRecordingTools(calls)));
});

it.effect(
  "clamps t3_thread_read page sizes above their maximum instead of rejecting the call",
  () => {
    const calls: Array<unknown> = [];
    return Effect.gen(function* () {
      const thread = { threadId: "thread-clamped-arguments" };
      // Codex never shows the model these bounds, so an over-large page must still read.
      yield* callTool("t3_thread_read", {
        ...thread,
        limit: 150,
        runLimit: 80,
        maxCharsPerItem: 60_000,
      });
      yield* callTool("t3_thread_read", {
        ...thread,
        limit: 100,
        runLimit: 50,
        maxCharsPerItem: 20_000,
      });
      yield* callTool("t3_thread_read", { ...thread, limit: 7, runLimit: 1, maxCharsPerItem: 1 });

      expect(calls).toEqual([
        { ...thread, limit: 100, runLimit: 50, maxCharsPerItem: 20_000 },
        { ...thread, limit: 100, runLimit: 50, maxCharsPerItem: 20_000 },
        { ...thread, limit: 7, runLimit: 1, maxCharsPerItem: 1 },
      ]);
    }).pipe(Effect.provide(layerRecordingTools(calls)));
  },
);

it.effect.each(["limit", "runLimit", "maxCharsPerItem"])(
  "still rejects a t3_thread_read %s below its minimum",
  (field) => {
    const calls: Array<unknown> = [];
    return Effect.gen(function* () {
      // Zero is a different request than one item, so it fails rather than answering another question.
      const rejected = yield* callTool("t3_thread_read", {
        threadId: "thread-below-minimum",
        [field]: 0,
      }).pipe(Effect.flip);

      expect(String(rejected)).toContain("greater than or equal to 1");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layerRecordingTools(calls)));
  },
);

it("keeps cross-tool routing out of the delegate_task description", () => {
  const description = OrchestratorToolkit.tools.delegate_task.description ?? "";
  expect(description).toContain("Start one child agent with only `task`");
  // Review rounds, follow-ups, and polling are routed in the system text.
  expect(description).not.toContain("t3_thread_send");
  expect(description).not.toContain("Do not poll");
  expect(description).not.toContain("Prefer native");
});

it.effect(
  "registers the pull request toolkit and surfaces a missing capability as a tool error",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "link_pull_request",
          "unlink_pull_request",
          "list_thread_pull_requests",
        ]),
      );
      const linkTool = server.tools.find(({ tool }) => tool.name === "link_pull_request");
      expect(linkTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(linkTool?.tool.annotations?.openWorldHint).toBe(false);
      expect(linkTool?.tool.description).toContain("Link a PR to this thread");
      expect(linkTool?.tool.description).toContain("settles the thread on merge");

      const denied = yield* server
        .callTool({ name: "list_thread_pull_requests", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        { type: "text", text: "MCP credential does not grant the pull-requests capability." },
      ]);
    }).pipe(Effect.provide(layerPullRequestsTest)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "providerTokenWithoutDots";
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const layerServer = McpHttpServer.layerMcpTransport(Layer.empty).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) =>
              Effect.succeed(
                presented === token
                  ? (scope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(layerServer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("answers 2026-07-28 discovery and keeps 2025-06-18 as the initialize fallback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "providerTokenWithoutDots";
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const ProbeToolkit = Toolkit.make(
        Tool.make("probe", {
          description: "Reports success.",
          success: Schema.Struct({ ok: Schema.Boolean }),
        }),
      );
      const layerServer = McpHttpServer.layerMcpTransport(
        McpHttpServer.toolkitRegistration(
          ProbeToolkit,
          McpToolAccess.toLayer(ProbeToolkit, {
            probe: McpToolAccess.reads(() => Effect.succeed({ ok: true })),
          }),
        ),
      ).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) =>
              Effect.succeed(
                presented === token
                  ? (scope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(layerServer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );

      const discoverResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"mcp-test","version":"1.0.0"}}}}`,
          "application/json",
        ),
      });
      expect(discoverResponse.status).toBe(200);
      const discovered = (yield* discoverResponse.json) as {
        result: { supportedVersions: ReadonlyArray<string> };
      };
      expect(discovered.result.supportedVersions).toEqual(
        expect.arrayContaining(["2026-07-28", "2025-06-18"]),
      );

      const toolsResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        body: HttpBody.text(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": { name: "mcp-test", version: "1.0.0" },
              },
            },
          }),
          "application/json",
        ),
      });
      expect(toolsResponse.status).toBe(200);
      const tools = (yield* toolsResponse.json) as {
        error?: unknown;
        result: { tools: ReadonlyArray<{ name: string }> };
      };
      expect(tools.error).toBeUndefined();
      expect(tools.result.tools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "probe" })]),
      );

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2099-01-01","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initializeResponse.status).toBe(200);
      const initialized = (yield* initializeResponse.json) as {
        result: { protocolVersion: string };
      };
      expect(initialized.result.protocolVersion).toBe("2025-06-18");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("admits provider and OAuth client credentials and points only clients at OAuth", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const providerToken = "providerTokenWithoutDots";
      const clientToken = "client-payload.client-signature";
      const providerScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const clientScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const seen: Array<McpInvocationContext.McpInvocationScope> = [];
      const ProbeToolkit = Toolkit.make(
        Tool.make("probe", {
          description: "Reports the caller.",
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
          dependencies: [McpInvocationContext.McpInvocationContext],
        }),
      );
      const serverLayer = McpHttpServer.layerMcpTransport(
        McpHttpServer.toolkitRegistration(
          ProbeToolkit,
          McpToolAccess.toLayer(ProbeToolkit, {
            probe: McpToolAccess.reads(() =>
              McpInvocationContext.McpInvocationContext.pipe(
                Effect.tap((scope) => Effect.sync(() => seen.push(scope))),
                Effect.as({ ok: true }),
              ),
            ),
          }),
        ),
      ).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.succeed(coordinator),
          }),
        ),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) =>
              Effect.succeed(
                token === providerToken
                  ? (providerScope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${clientToken}`
                  ? clientScope
                  : request.headers.authorization === "Bearer proof-unavailable"
                    ? ("identity_unavailable" as const)
                    : request.headers.authorization === "Bearer proof-conflict"
                      ? ("identity_conflict" as const)
                      : undefined,
              ),
          }),
        ),
      );
      const traced = recordSpans();
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
        Effect.withTracer(traced.tracer),
      );
      const httpClient = yield* HttpClient.HttpClient;
      const call = (token: string | undefined) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          if (initialize.status !== 200) return initialize;
          return yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"probe","arguments":{}}}`,
              "application/json",
            ),
          });
        });

      expect((yield* call(providerToken)).status).toBe(200);
      // The tool gets its own span, without its arguments, which starts once authentication has ended.
      const toolSpan = traced.spans.find((span) => span.name === "mcp.tool.probe");
      expect(Object.fromEntries(toolSpan?.attributes ?? [])).toEqual({
        "rpc.system": "mcp",
        "rpc.method": "tools/call",
        "mcp.tool.name": "probe",
      });
      const authSpan = traced.spans.find(
        (span) =>
          span.name === "McpHttpServer.authenticateRequest" && span.traceId === toolSpan?.traceId,
      );
      expect(authSpan).toBeDefined();
      expect(traced.order.slice(0, traced.order.indexOf(`start ${toolSpan?.spanId}`))).toContain(
        `end ${authSpan?.spanId}`,
      );
      expect((yield* call(clientToken)).status).toBe(200);
      expect(seen.map((scope) => scope.requestNamespace)).toEqual([
        "provider-session",
        "client:session-1",
      ]);
      const unavailable = yield* call("proof-unavailable");
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers["www-authenticate"]).toBeUndefined();
      // The verifying environment needs a link back to the requester.
      const unavailableText = yield* unavailable.text;
      expect(unavailableText).toContain('"peer_identity_unavailable"');
      expect(unavailableText).toContain("Coordinator Test Node");
      expect(unavailableText).toContain(environmentId);
      expect(unavailableText).toContain(
        "this environment needs a link back to the requesting environment",
      );
      const conflict = yield* call("proof-conflict");
      expect(conflict.status).toBe(503);
      const conflictText = yield* conflict.text;
      expect(conflictText).toContain('"peer_identity_conflict"');
      expect(conflictText).toContain("Coordinator Test Node");
      expect(conflictText).toContain(
        "this environment needs a link back to the requesting environment",
      );

      const missing = yield* call(undefined);
      expect(missing.status).toBe(401);
      expect(missing.headers["www-authenticate"]).toMatch(
        /^Bearer resource_metadata="http:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/,
      );

      const expiredClient = yield* call("stale-payload.stale-signature");
      expect(expiredClient.headers["www-authenticate"]).toContain("resource_metadata=");
      expect(expiredClient.headers["www-authenticate"]).toContain('error="invalid_token"');

      const spansBeforeRejection = traced.spans.length;
      const deadProvider = yield* call("deadProviderToken");
      expect(deadProvider.status).toBe(401);
      expect(deadProvider.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
      // A rejected credential is recorded on the auth span, and nothing is handled.
      const rejectedSpans = traced.spans.slice(spansBeforeRejection);
      expect(
        rejectedSpans
          .filter((span) => span.name === "McpHttpServer.authenticateRequest")
          .map((span) => span.events.map(([name]) => name)),
      ).toEqual([[expect.stringContaining("unknown_or_expired_token")]]);
      expect(
        rejectedSpans.filter(
          (span) => span.name.startsWith("mcp.tool.") || span.name.startsWith("McpServer."),
        ),
      ).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("accepts case-insensitive MCP bearer schemes and diagnoses rejected credentials", () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make(({ message }) => messages.push(message));
  const layerAuth = Layer.mergeAll(EnvironmentAuth.layer, McpSessionRegistry.layer).pipe(
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-auth-header-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const providerToken = issued.config.authorizationHeader.slice("Bearer ".length);
      const oauth = yield* auth.issueMcpClientSession({
        label: "MCP header test",
        access: "read-only",
        peerLink: false,
        client: { deviceType: "bot" },
      });
      yield* HttpRouter.serve(
        McpHttpServer.layerMcpTransport(Layer.empty).pipe(
          Layer.provide(
            McpOAuth.layerMcpClientAuthenticator.pipe(
              Layer.provide(Layer.mock(PeerMcpClient.PeerMcpClient)({})),
            ),
          ),
          Layer.provide(ServerSettings.layerTest()),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const initialize = (authorization?: string) =>
        httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-header-test","version":"1.0.0"}}}`,
            "application/json",
          ),
        });

      for (const scheme of ["Bearer", "bearer", "bEaReR"]) {
        for (const [kind, token] of [
          ["provider", providerToken],
          ["OAuth", oauth.token],
        ]) {
          const response = yield* initialize(`${scheme} ${token}`);
          expect.soft(response.status, `${kind} ${scheme}`).toBe(200);
        }
      }
      messages.length = 0;
      for (const [authorization, reason] of [
        [undefined, "missing_authorization_header"],
        [`Basic ${providerToken}`, "unsupported_scheme"],
        ["Bearer", "missing_bearer_token"],
        ["bEaReR ", "missing_bearer_token"],
        [`bearer ${providerToken.toUpperCase()}`, "unknown_or_expired_token"],
        [`bEaReR ${oauth.token.toUpperCase()}`, "unknown_or_expired_token"],
      ] as const) {
        const response = yield* initialize(authorization);
        expect(response.status).toBe(401);
        expect
          .soft(messages.at(-1))
          .toEqual(["rejected MCP request with an unusable credential", { reason }]);
        const body = yield* response.text;
        expect(body).not.toContain(providerToken);
        expect(body).not.toContain(oauth.token);
        expect(JSON.stringify(response.headers)).not.toContain(providerToken);
        expect(JSON.stringify(response.headers)).not.toContain(oauth.token);
      }
      yield* registry.revokeThread(threadId);
      yield* auth.revokeSession(oauth.sessionId);
      for (const token of [providerToken, oauth.token]) {
        expect((yield* initialize(`bearer ${token}`)).status).toBe(401);
      }
      expect(JSON.stringify(messages)).not.toContain(providerToken);
      expect(JSON.stringify(messages)).not.toContain(oauth.token);
      expect(JSON.stringify(messages)).not.toContain(providerToken.toUpperCase());
      expect(JSON.stringify(messages)).not.toContain(oauth.token.toUpperCase());
    }),
  ).pipe(
    Effect.provide(
      layerAuth.pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    ),
  );
});

it.effect("lists link tools for every scope and forwards calls to another environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "linksToken";
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: token,
        thread: {
          threadId: ThreadId.make("thread-links"),
          providerSessionId: token,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const LinksToolkit = Toolkit.make(
        Tool.make("links", {
          description: "Lists links.",
          success: Schema.Struct({ links: Schema.Number }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        }),
        Tool.make("where", {
          description: "Says where it ran.",
          parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
          success: Schema.Struct({ ranIn: Schema.String }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        }),
      );
      const serverLayer = McpHttpServer.layerMcpTransport(
        McpHttpServer.toolkitRegistration(
          LinksToolkit,
          McpToolAccess.toLayer(LinksToolkit, {
            links: McpToolAccess.reads(() => Effect.succeed({ links: 0 })),
            where: McpToolAccess.reads(() => Effect.succeed({ ranIn: "here" })),
          }),
        ),
      ).pipe(
        Layer.provide(ServerSettings.layerTest({ linkedEnvironmentsEnabled: false })),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) => Effect.succeed(presented === token ? scope : undefined),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      };
      const initialize = yield* httpClient.post("/mcp", {
        headers,
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const rpc = (method: string, params: object) =>
        httpClient
          .post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
              "application/json",
            ),
          })
          .pipe(Effect.flatMap((response) => response.json));
      const listed = () =>
        rpc("tools/list", {}).pipe(
          Effect.map((body) =>
            (body as { result: { tools: ReadonlyArray<{ name: string }> } }).result.tools.map(
              (tool) => tool.name,
            ),
          ),
        );
      const ranIn = (where: EnvironmentId) =>
        rpc("tools/call", { name: "where", arguments: { environmentId: where } }).pipe(
          Effect.map(
            (body) =>
              (
                body as {
                  result: {
                    isError?: boolean;
                    structuredContent?: unknown;
                    content: ReadonlyArray<{ text: string }>;
                  };
                }
              ).result,
          ),
        );
      const elsewhere = EnvironmentId.make("environment-elsewhere");

      expect(yield* listed()).toEqual(["links", "where"]);
      // Linked environments stay on: the call goes on to the forwarding, which this server lacks.
      expect(yield* ranIn(elsewhere)).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("无法访问关联的环境") }],
      });
      expect((yield* ranIn(environmentId)).structuredContent).toEqual({ ranIn: "here" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("lists pull request watch tools only to threads that are not delegated children", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scopeFor = (
        token: string,
        subagent: boolean,
      ): McpInvocationContext.McpThreadInvocationScope => ({
        environmentId,
        requestNamespace: token,
        thread: {
          threadId: ThreadId.make(`thread-${token}`),
          providerSessionId: token,
          providerInstanceId: ProviderInstanceId.make("codex"),
          subagent,
        },
        client: undefined,
        capabilities: new Set(["pull-requests"]),
        issuedAt: 1,
      });
      const scopes = new Map([
        ["parentToken", scopeFor("parentToken", false)],
        ["childToken", scopeFor("childToken", true)],
      ]);
      const serverLayer = McpHttpServer.layerMcpTransport(
        McpHttpServer.layerPullRequestsToolkit,
      ).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) => Effect.succeed(scopes.get(token)),
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            McpToolAccessTestkit.liveThreadsLayer,
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
            Layer.mock(PullRequestService.PullRequestService)({}),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const listedTools = (token: string) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          const listed = yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
              "application/json",
            ),
          });
          const body = (yield* listed.json) as {
            readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
          };
          return body.result.tools.map((tool) => tool.name);
        });

      const parentTools = yield* listedTools("parentToken");
      const childTools = yield* listedTools("childToken");
      expect(parentTools).toEqual(
        expect.arrayContaining(["link_pull_request", "watch_pull_request", "unwatch_pull_request"]),
      );
      expect(childTools).toContain("link_pull_request");
      expect(childTools).not.toContain("watch_pull_request");
      expect(childTools).not.toContain("unwatch_pull_request");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "narrows an OAuth client's modes to the T3-Mode-Limit it sends, and never widens them",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const clientToken = "client-payload.client-signature";
        const clientScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          requestNamespace: "client:linked",
          thread: undefined,
          client: { sessionId: "linked", label: "T3 Code · laptop", access: "auto" },
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        // Starts a thread at the modes the gate hands it, so the outcome is those modes.
        const StartsToolkit = Toolkit.make(
          Tool.make("starts", {
            description: "Reports the modes a started thread would run with.",
            parameters: Schema.Struct({
              runtimeMode: Schema.optional(RuntimeMode),
              interactionMode: Schema.optional(ProviderInteractionMode),
            }),
            success: Schema.Struct({ modes: Schema.String }),
            failure: OrchestratorMcpFailure,
            failureMode: "return",
            dependencies: [
              McpInvocationContext.McpInvocationContext,
              ThreadManagementService.ThreadManagementService,
            ],
          }),
        );
        const serverLayer = McpHttpServer.layerMcpTransport(
          McpHttpServer.toolkitRegistration(
            StartsToolkit,
            McpToolAccess.toLayer(StartsToolkit, {
              starts: McpToolAccess.startsThreads(
                (input) => input,
                (_, modes) =>
                  Effect.succeed({ modes: `${modes.runtimeMode}/${modes.interactionMode}` }),
                "stamped",
              ),
            }),
          ),
        ).pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: () => Effect.undefined,
            }),
          ),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator, {
              authenticate: (request) =>
                Effect.succeed(
                  request.headers.authorization === `Bearer ${clientToken}`
                    ? clientScope
                    : undefined,
                ),
            }),
          ),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const httpClient = yield* HttpClient.HttpClient;
        const decodeOutcome = Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              result: Schema.Struct({
                content: Schema.Array(Schema.Struct({ text: Schema.String })),
              }),
            }),
          ),
        );
        const decodeText = Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Union([
              Schema.Struct({ modes: Schema.String }),
              Schema.Struct({ code: Schema.String }),
            ]),
          ),
        );
        /** Starts a thread as the client, with `limit` as T3-Mode-Limit; the HTTP status or the outcome. */
        const start = (limit: string | undefined, args: Record<string, string> = {}) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${clientToken}`,
              ...(limit === undefined ? {} : { "t3-mode-limit": limit }),
            };
            const initialize = yield* httpClient.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
                "application/json",
              ),
            });
            if (initialize.status !== 200) return initialize.status;
            const response = yield* httpClient.post("/mcp", {
              headers: {
                ...headers,
                "mcp-session-id": initialize.headers["mcp-session-id"]!,
                "mcp-protocol-version": "2025-06-18",
              },
              body: HttpBody.text(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/call",
                  params: { name: "starts", arguments: args },
                }),
                "application/json",
              ),
            });
            const body = yield* decodeOutcome(yield* response.text);
            const outcome = yield* decodeText(
              body.result.content.map((part) => part.text).join(""),
            );
            return "code" in outcome ? outcome.code : outcome.modes;
          });

        // Approved for auto: without the header the client keeps its ceiling.
        expect(yield* start(undefined)).toBe("auto/default");
        // The header narrows both modes, and asking above it is refused.
        expect(yield* start("approval-required/plan")).toBe("approval-required/plan");
        expect(yield* start("approval-required/plan", { runtimeMode: "auto" })).toBe(
          "runtime_mode_escalation_denied",
        );
        expect(yield* start("auto-accept-edits/plan", { interactionMode: "default" })).toBe(
          "interaction_mode_escalation_denied",
        );
        // A broader header changes nothing: the approved ceiling still holds.
        expect(yield* start("full-access/default")).toBe("auto/default");
        expect(yield* start("full-access/default", { runtimeMode: "full-access" })).toBe(
          "runtime_mode_escalation_denied",
        );
        // A malformed header is refused before anything runs.
        expect(yield* start("auto")).toBe(400);
        expect(yield* start("auto/default/extra")).toBe(400);
        expect(yield* start("root/default")).toBe(400);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("lists optional tools to a deferring client only after tool_search loads them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scopeFor = (token: string): McpInvocationContext.McpThreadInvocationScope => ({
        environmentId,
        requestNamespace: token,
        thread: {
          threadId: ThreadId.make(`thread-${token}`),
          providerSessionId: token,
          providerInstanceId: ProviderInstanceId.make("copilot"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      });
      const scopes = new Map([
        ["deferringToken", scopeFor("deferringToken")],
        ["otherToken", scopeFor("otherToken")],
      ]);
      const tool = (name: string, description: string) =>
        Tool.make(name, {
          description,
          success: Schema.Struct({}),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        });
      const OptionalToolkit = Toolkit.make(
        tool("delegate_task", "Delegates a task."),
        tool("sample_tool", "A sample optional tool."),
        tool("schedule_task", "Schedules a task."),
      );
      const reads = McpToolAccess.reads(() => Effect.succeed({}));
      const serverLayer = McpHttpServer.layerMcpTransport(
        Layer.mergeAll(
          McpHttpServer.toolkitRegistration(
            OptionalToolkit,
            McpToolAccess.toLayer(OptionalToolkit, {
              delegate_task: reads,
              sample_tool: reads,
              schedule_task: reads,
            }),
          ),
          McpHttpServer.layerToolSearch,
        ),
      ).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) => Effect.succeed(scopes.get(token)),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const session = (token: string, deferred: boolean) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            ...(deferred ? { "t3-tool-exposure": "deferred" } : {}),
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          const rpc = (method: string, params: object) =>
            httpClient
              .post("/mcp", {
                headers: {
                  ...headers,
                  "mcp-session-id": initialize.headers["mcp-session-id"]!,
                  "mcp-protocol-version": "2025-06-18",
                },
                body: HttpBody.text(
                  JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
                  "application/json",
                ),
              })
              .pipe(
                Effect.flatMap((response) => response.text),
                // tool_search answers over SSE, after its list_changed notification.
                Effect.map((text): unknown =>
                  text
                    .split("\n")
                    .filter((line) => line.startsWith("data: ") || line.startsWith("{"))
                    .map((line) => JSON.parse(line.replace(/^data: /u, "")) as { id?: number })
                    .find((message) => message.id === 2),
                ),
              );
          return {
            listed: rpc("tools/list", {}).pipe(
              Effect.map((body) =>
                (body as { result: { tools: ReadonlyArray<{ name: string }> } }).result.tools
                  .map((listed) => listed.name)
                  .sort(),
              ),
            ),
            call: (name: string, args: object) =>
              rpc("tools/call", { name, arguments: args }).pipe(
                Effect.map((body) => (body as { result: { structuredContent?: unknown } }).result),
              ),
          };
        });

      const deferring = yield* session("deferringToken", true);
      const other = yield* session("otherToken", false);
      expect(yield* deferring.listed).toEqual(["delegate_task", "tool_search"]);
      expect(yield* other.listed).toEqual(["delegate_task", "sample_tool", "schedule_task"]);
      // Unlisted tools stay callable.
      expect((yield* deferring.call("schedule_task", {})).structuredContent).toEqual({});

      expect((yield* deferring.call("tool_search", { query: "sample" })).structuredContent).toEqual(
        { tools: [{ name: "sample_tool", description: "A sample optional tool." }] },
      );
      expect(yield* deferring.listed).toEqual(["delegate_task", "sample_tool", "tool_search"]);
      expect(yield* other.listed).toEqual(["delegate_task", "sample_tool", "schedule_task"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
