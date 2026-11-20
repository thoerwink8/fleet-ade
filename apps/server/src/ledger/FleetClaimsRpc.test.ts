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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { descriptorOf, linkTo, servePeer } from "../peer/PeerLinks.testkit.ts";
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

const serveApart = (descriptor: typeof coordinator) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) =>
      servePeer(
        descriptor,
        McpHttpServer.layerFleetClaimsToolkit.pipe(Layer.provide(claimsLayer)),
      ).pipe(Effect.provideContext(server)),
    ),
  );

it.effect("两台互连环境通过真实 RPC 共享协调者租约并使用签名会话身份", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* servePeer(
        coordinator,
        McpHttpServer.layerFleetClaimsToolkit.pipe(Layer.provide(claimsLayer)),
      );
      const a = yield* serveApart(nodeA);
      const b = yield* serveApart(nodeB);
      const aClient = a.client;
      const bClient = b.client;
      // The executor first authenticates to the coordinator. The reciprocal
      // link can then prove the coordinator's identity over that existing link.
      yield* linkTo(a.links, peer);
      const initialClaim = yield* claim(
        aClient,
        claimInput("example/one", "initial", "initial-unidentified"),
      ).pipe(Effect.flip);
      expect(initialClaim.code).toBe("orchestration_error");
      yield* linkTo(peer.links, a);
      const reciprocalClaim = yield* peer.client.call({
        environmentId: nodeA.environmentId,
        tool: "fleet_claim",
        arguments: claimInput("example/one", "reciprocal", "coordinator-claim"),
        limits,
        success: FleetClaimClaimResult,
      });
      expect(reciprocalClaim.claim?.holderEnvironment).toBe(coordinator.environmentId);
      // An unrelated hinted link has no authenticated return path and is not identified.
      yield* linkTo(b.links, a);
      const unrelatedClaim = yield* bClient
        .call({
          environmentId: nodeA.environmentId,
          tool: "fleet_claim",
          arguments: claimInput("example/one", "unrelated", "unidentified-claim"),
          limits,
          success: FleetClaimClaimResult,
        })
        .pipe(Effect.flip);
      expect(unrelatedClaim.code).toBe("orchestration_error");
      yield* linkTo(b.links, peer);
      yield* linkTo(peer.links, b);

      const held = yield* claim(aClient, claimInput("example/one", "root", "a-root"));
      expect(held.outcome).toBe("claimed");
      expect(held.claim?.holder).not.toBe("node-a");
      expect(held.claim?.holderEnvironment).toBe("node-a");
      expect((yield* claim(bClient, claimInput("example/one", "root", "b-root"))).outcome).toBe(
        "already-held",
      );
      const child = yield* claim(bClient, claimInput("example/one", "child-1", "b-child"));
      expect(child.outcome).toBe("claimed");
      expect(child.claim?.holderEnvironment).toBe("node-b");
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
      expect(own.results[0]?.claim?.holderEnvironment).toBe("node-b");

      const peerSession = (yield* peer.linkedSessions).find(
        (session) => session.sessionId === child.claim?.holder,
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
      const a = yield* serveApart(nodeA);
      yield* linkTo(a.links, peer);
      yield* linkTo(peer.links, a);
      const aClient = a.client;

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
