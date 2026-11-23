import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeNet from "node:net";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { isBannedHost } from "./theirServices.scan.ts";

function hostFromSocketArgs(args: readonly unknown[]): string | undefined {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "object" && first !== null) {
    const record = first as { hostname?: unknown; host?: unknown; servername?: unknown };
    for (const value of [record.hostname, record.host, record.servername]) {
      if (typeof value === "string" && value.length > 0) return value.split("%")[0];
    }
  }
  return typeof args[1] === "string" ? args[1] : undefined;
}

// ESM namespace exports of node:http are read-only. Node HTTP, including fetch,
// still opens a net.Socket, so the prototype is the one place to watch.
function watchOutbound(note: (host: string) => void): () => void {
  const connect = NodeNet.Socket.prototype.connect;
  NodeNet.Socket.prototype.connect = function (this: NodeNet.Socket, ...args: unknown[]) {
    const host = hostFromSocketArgs(args);
    if (host) note(host);
    if (host && isBannedHost(host)) {
      queueMicrotask(() => this.destroy());
      return this;
    }
    return connect.apply(this, args as Parameters<NodeNet.Socket["connect"]>);
  };
  return () => {
    NodeNet.Socket.prototype.connect = connect;
  };
}

it.effect("startup and opening a session do not contact their hosts", () =>
  Effect.gen(function* () {
    const hits: string[] = [];
    const restore = watchOutbound((host) => {
      if (isBannedHost(host)) hits.push(host);
    });
    yield* Effect.gen(function* () {
      const config = yield* Effect.promise(() => import("./cloud/publicConfig.ts"));
      const emptyConfig = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));
      yield* config.hostedAppUrlConfig.pipe(Effect.provide(emptyConfig), Effect.exit);

      const [
        { CodexProviderCapabilitiesV2 },
        { OrchestratorV2 },
        { layer: projectionLayer },
        { layerFromAdapters },
        { layerWithRegistry },
        { layerMemory },
      ] = yield* Effect.all([
        Effect.promise(() => import("./orchestration-v2/Adapters/CodexAdapterV2.ts")),
        Effect.promise(() => import("./orchestration-v2/Orchestrator.ts")),
        Effect.promise(() => import("./orchestration-v2/ProjectionStore.ts")),
        Effect.promise(() => import("./orchestration-v2/ProviderAdapterRegistry.ts")),
        Effect.promise(() => import("./orchestration-v2/testkit/ProviderReplayHarness.ts")),
        Effect.promise(() => import("./persistence/Sqlite.ts")),
      ]);
      const instanceId = ProviderInstanceId.make("codex");
      const adapter = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("No provider process needed for metadata commands"),
      } as ProviderAdapter.ProviderAdapterV2["Service"];
      const databaseLayer = layerMemory;
      const layer = Layer.mergeAll(
        databaseLayer,
        projectionLayer.pipe(Layer.provide(databaseLayer)),
        layerWithRegistry({ name: "their-services" }, layerFromAdapters([adapter]), {
          databaseLayer,
          runEffectWorker: false,
        }),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:their-services"),
          threadId: ThreadId.make("thread:their-services"),
          projectId: ProjectId.make("project:their-services"),
          title: "Session",
          modelSelection: { instanceId, model: "grok" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.ensuring(Effect.sync(restore)));
    assert.deepStrictEqual(hits, []);
  }),
);
