import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as PeerChallengeRegistry from "./peer/PeerChallengeRegistry.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PeerMcpClient from "./peer/PeerMcpClient.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { layerFleetSummaryReporter } from "./server.ts";

it.effect("the reporter's peer client shares its challenge registry with MCP proof handling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = EnvironmentId.make("coordinator");
      const registryContext = yield* Layer.build(PeerChallengeRegistry.layer);
      const registry = Context.get(registryContext, PeerChallengeRegistry.PeerChallengeRegistry);
      const digester = yield* Digest.Digest;
      const digest = Base64Url.encode(
        yield* digester.digest(Digest.sha256, new TextEncoder().encode("fixture")),
      );
      const consumed: boolean[] = [];
      let requests = 0;
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests++;
          const challenge = request.headers[PeerMcpClient.PEER_CHALLENGE_HEADER];
          if (challenge !== undefined)
            consumed.push(yield* registry.consume(challenge, target, digest));
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              requests === 3
                ? JSON.stringify({ result: { content: [{ type: "text", text: "{}" }] } })
                : "",
              {
                status: requests === 2 ? 202 : 200,
                headers: requests === 1 ? { "mcp-session-id": "session" } : {},
              },
            ),
          );
        }),
      );
      const shared = layerFleetSummaryReporter.pipe(
        Layer.provide(Layer.succeed(PeerChallengeRegistry.PeerChallengeRegistry, registry)),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.provide(
          Layer.mock(PeerLinks.PeerLinks)({
            resolve: () =>
              Effect.succeed({
                link: {
                  environmentId: target,
                  label: "Coordinator",
                  urls: ["https://peer.example"],
                  access: "auto",
                  linkedAt: DateTime.makeUnsafe(0),
                  expiresAt: DateTime.makeUnsafe(1),
                  lastReachedAt: null,
                  lastError: null,
                },
                url: "https://peer.example",
                token: "fixture",
              }),
            recordOutcome: () => Effect.void,
          }),
        ),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
        ),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "fleet-server-wiring-" })),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const context = yield* Layer.build(shared);
      yield* Context.get(context, PeerMcpClient.PeerMcpClient).call({
        environmentId: target,
        tool: "fleet_summary_report",
        arguments: {},
        limits: { runtimeMode: "approval-required", interactionMode: "default" },
        success: Schema.Struct({}),
      });
      expect(consumed).toEqual([true]);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
