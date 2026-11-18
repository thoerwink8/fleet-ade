import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  FleetClaimClaimResult,
  FleetClaimLeaseResult,
  type FleetClaimClaimInput,
  type FleetClaimLeaseInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as FleetClaims from "./FleetClaims.ts";

const coordinator = descriptorOf("coordinator", "Coordinator");
const nodeA = descriptorOf("node-a", "Node A");
const nodeB = descriptorOf("node-b", "Node B");
const limits = { runtimeMode: "auto" as const, interactionMode: "default" as const };

const claimsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one'), ('other', 'repo')`;
  }),
).pipe(Layer.provideMerge(FleetClaims.layerForTest));

const threadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: () => Effect.succeed(null),
});

const claim = (client: PeerMcpClient.PeerMcpClient["Service"], input: FleetClaimClaimInput) =>
  client.call({
    environmentId: coordinator.environmentId,
    tool: "fleet_claim",
    arguments: input,
    limits,
    success: FleetClaimClaimResult,
  });

const release = (client: PeerMcpClient.PeerMcpClient["Service"], input: FleetClaimLeaseInput) =>
  client.call({
    environmentId: coordinator.environmentId,
    tool: "fleet_release",
    arguments: input,
    limits,
    success: FleetClaimLeaseResult,
  });

const claimInput = (repo: string, taskId: string, holder: string, idempotencyKey: string) => ({
  fleetId: "fleet-a",
  repo,
  issue: 7,
  taskId,
  holder,
  idempotencyKey,
});

it.effect("两台互连环境通过真实 RPC 共享协调者租约并拒绝撤销节点", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* servePeer(
        coordinator,
        McpHttpServer.layerFleetClaimsToolkit.pipe(
          Layer.provide(claimsLayer),
          Layer.provide(threadsLayer),
        ),
      );
      const aContext = yield* layerLinkingEnvironment(nodeA).pipe(Layer.build);
      const bContext = yield* layerLinkingEnvironment(nodeB).pipe(Layer.build);
      const aLinks = Context.get(aContext, PeerLinks.PeerLinks);
      const bLinks = Context.get(bContext, PeerLinks.PeerLinks);
      const aClient = Context.get(aContext, PeerMcpClient.PeerMcpClient);
      const bClient = Context.get(bContext, PeerMcpClient.PeerMcpClient);
      yield* linkTo(aLinks, peer);
      yield* linkTo(bLinks, peer);

      const held = yield* claim(aClient, claimInput("example/one", "root", "node-a", "a-root"));
      expect(held.outcome).toBe("claimed");
      expect(
        (yield* claim(bClient, claimInput("example/one", "root", "node-b", "b-root"))).outcome,
      ).toBe("already-held");
      expect(
        (yield* claim(bClient, claimInput("example/one", "child-1", "node-b", "b-child"))).outcome,
      ).toBe("claimed");
      expect(
        (yield* claim(bClient, claimInput("other/repo", "root", "node-b", "b-other"))).outcome,
      ).toBe("claimed");

      expect(
        (yield* release(aClient, {
          ...claimInput("example/one", "root", "node-a", "a-release"),
          attempt: held.claim!.attempt,
          fencing: held.claim!.fencing,
        })).outcome,
      ).toBe("released");
      expect(
        (yield* claim(bClient, claimInput("example/one", "root", "node-b", "b-root-2"))).claim
          ?.attempt,
      ).toBe(2);

      const revoked = (yield* peer.linkedSessions).find(
        (session) => session.client.label === "T3 Code · Node B",
      );
      expect(revoked).toBeDefined();
      yield* peer.auth.revokeSession(revoked!.sessionId);
      const denied = yield* claim(
        bClient,
        claimInput("example/one", "child-2", "node-b", "revoked"),
      ).pipe(Effect.flip);
      expect(denied.code).toBe("capability_denied");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
