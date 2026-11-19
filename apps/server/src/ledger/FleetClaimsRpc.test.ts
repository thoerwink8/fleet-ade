import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  FleetClaimClaimResult,
  FleetClaimHeartbeatResult,
  FleetClaimLeaseResult,
  type FleetClaimClaimInput,
  type FleetClaimHeartbeatInput,
  type FleetClaimLeaseInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
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
).pipe(Layer.provideMerge(FleetClaims.layerForTest()));

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

const heartbeat = (
  client: PeerMcpClient.PeerMcpClient["Service"],
  input: FleetClaimHeartbeatInput,
) =>
  client.call({
    environmentId: coordinator.environmentId,
    tool: "fleet_heartbeat",
    arguments: input,
    limits,
    success: FleetClaimHeartbeatResult,
  });

const claimInput = (repo: string, taskId: string, idempotencyKey: string) => ({
  repo,
  issue: 7,
  taskId,
  idempotencyKey,
});

it.effect("两台互连环境通过真实 RPC 共享协调者租约并使用签名会话身份", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* servePeer(
        coordinator,
        McpHttpServer.layerFleetClaimsToolkit.pipe(Layer.provide(claimsLayer)),
      );
      const aContext = yield* layerLinkingEnvironment(nodeA).pipe(Layer.build);
      const bContext = yield* layerLinkingEnvironment(nodeB).pipe(Layer.build);
      const aLinks = Context.get(aContext, PeerLinks.PeerLinks);
      const bLinks = Context.get(bContext, PeerLinks.PeerLinks);
      const aClient = Context.get(aContext, PeerMcpClient.PeerMcpClient);
      const bClient = Context.get(bContext, PeerMcpClient.PeerMcpClient);
      yield* linkTo(aLinks, peer);
      yield* linkTo(bLinks, peer);

      const held = yield* claim(aClient, claimInput("example/one", "root", "a-root"));
      expect(held.outcome).toBe("claimed");
      expect(held.claim?.holder).not.toBe("node-a");
      expect(held.claim?.holderEnvironment).toBe(held.claim?.holder);
      expect((yield* claim(bClient, claimInput("example/one", "root", "b-root"))).outcome).toBe(
        "already-held",
      );
      const child = yield* claim(bClient, claimInput("example/one", "child-1", "b-child"));
      expect(child.outcome).toBe("claimed");
      expect(child.claim?.holder).not.toBe("node-b");
      expect(child.claim?.holder).not.toBe(held.claim?.holder);
      expect((yield* claim(bClient, claimInput("other/repo", "root", "b-other"))).outcome).toBe(
        "claimed",
      );

      expect(
        (yield* release(aClient, {
          ...claimInput("example/one", "root", "a-release"),
          attempt: held.claim!.attempt,
          fencing: held.claim!.fencing,
        })).outcome,
      ).toBe("released");
      expect(
        (yield* claim(bClient, claimInput("example/one", "root", "b-root-2"))).claim?.attempt,
      ).toBe(2);

      const beat = yield* heartbeat(aClient, {
        sequence: 1,
        leases: [
          {
            repo: "example/one",
            issue: 7,
            taskId: "child-1",
            attempt: child.claim!.attempt,
            fencing: child.claim!.fencing,
          },
          {
            repo: "example/one",
            issue: 7,
            taskId: "released-root",
            attempt: 2,
            fencing: "2",
          },
        ],
      });
      expect(beat.results.map((item) => item.outcome)).toEqual(["not-owned", "not-claimed"]);
      const own = yield* heartbeat(bClient, {
        sequence: 1,
        leases: [
          {
            repo: "example/one",
            issue: 7,
            taskId: "child-1",
            attempt: child.claim!.attempt,
            fencing: child.claim!.fencing,
          },
        ],
      });
      expect(own.results[0]?.outcome).toBe("renewed");
      expect(own.results[0]?.claim?.holderEnvironment).toBe(own.results[0]?.claim?.holder);

      const peerSession = (yield* peer.linkedSessions).find(
        (session) => session.client.label === "T3 Code · Node B",
      );
      expect(peerSession).toBeDefined();
      yield* peer.auth.revokeSession(peerSession!.sessionId);
      const denied = yield* claim(
        bClient,
        claimInput("example/one", "child-2", "after-session-invalidation"),
      ).pipe(Effect.flip);
      expect(denied.code).toBe("capability_denied");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("协调者按服务端时钟判定过期租约的心跳", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* servePeer(
        coordinator,
        McpHttpServer.layerFleetClaimsToolkit.pipe(Layer.provide(claimsLayer)),
      );
      const aContext = yield* layerLinkingEnvironment(nodeA).pipe(Layer.build);
      const aLinks = Context.get(aContext, PeerLinks.PeerLinks);
      const aClient = Context.get(aContext, PeerMcpClient.PeerMcpClient);
      yield* linkTo(aLinks, peer);

      const held = yield* claim(aClient, claimInput("example/one", "root", "a-root"));
      expect(held.outcome).toBe("claimed");
      yield* TestClock.adjust("91 seconds");
      const late = yield* heartbeat(aClient, {
        sequence: 1,
        leases: [
          {
            repo: "example/one",
            issue: 7,
            taskId: "root",
            attempt: held.claim!.attempt,
            fencing: held.claim!.fencing,
          },
        ],
      });
      expect(late.results[0]?.outcome).toBe("expired");
      const taken = yield* claim(aClient, claimInput("example/one", "root", "a-root-2"));
      expect(taken.outcome).toBe("claimed");
      expect(taken.claim?.attempt).toBe(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
