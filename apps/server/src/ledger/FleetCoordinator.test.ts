import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  FleetClaimClaimResult,
  FleetTermExchangeResult,
  type FleetClaimClaimInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import {
  descriptorOf,
  type ServedPeer,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as CoordinatorTerm from "./coordinatorTerm.ts";
import * as FleetClaims from "./FleetClaims.ts";
import * as FleetCoordinator from "./FleetCoordinator.ts";

const nodeA = descriptorOf("node-a", "Node A");
const nodeB = descriptorOf("node-b", "Node B");

/**
 * This machine's coordinator service next to its own peer links: the parts a
 * handover drives are the real link, the real HTTP peer, and the real ledger.
 */
const coordinatorWithLinks = (descriptor: typeof nodeA, filename = ":memory:") =>
  FleetCoordinator.layerForTest(filename).pipe(
    Layer.provideMerge(layerLinkingEnvironment(descriptor)),
    Layer.build,
  );
it.effect("同任期冲突的警告带上交换的调用方机器", () => {
  const warnings: Array<{ readonly message: string; readonly annotations: unknown }> = [];
  const captureWarnings = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel !== "Warn") return;
    const parts = message as ReadonlyArray<unknown>;
    warnings.push({ message: String(parts[0]), annotations: parts[1] });
  });
  return Effect.gen(function* () {
    const context = yield* coordinatorWithLinks(nodeA);
    const coordinator = Context.get(context, FleetCoordinator.FleetCoordinator);
    const terms = Context.get(context, CoordinatorTerm.CoordinatorTerm);
    yield* terms.observe(CoordinatorTerm.FLEET_TERM_KEY, 5, "node-z");

    const reply = yield* coordinator.exchange(
      { environmentId: "node-b" },
      { term: 5, coordinatorId: EnvironmentId.make("node-a") },
    );
    expect(reply).toEqual({ term: 5, coordinatorId: "node-z" });
    expect(warnings).toEqual([
      {
        message: "coordinator term contended at equal term",
        annotations: {
          storedCoordinatorId: "node-z",
          observedCoordinatorId: "node-a",
          callerEnvironmentId: "node-b",
          term: 5,
          outcome: "stale",
        },
      },
    ]);
  }).pipe(Effect.provide(Logger.layer([captureWarnings], { mergeWithExisting: false })));
});

it.effect("交给目标机时推送失败返回未确认并把目标记入待重推名单", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* coordinatorWithLinks(nodeA);
      const coordinator = Context.get(context, FleetCoordinator.FleetCoordinator);
      const links = Context.get(context, PeerLinks.PeerLinks);
      const terms = Context.get(context, CoordinatorTerm.CoordinatorTerm);
      const b = yield* servePeer(
        nodeB,
        McpHttpServer.layerFleetCoordinatorToolkit.pipe(
          Layer.provide(FleetCoordinator.layerForTest()),
        ),
      );
      yield* linkTo(links, b);
      // The coordinator record already sits on the target; only its push is owed.
      expect((yield* terms.handover(CoordinatorTerm.FLEET_TERM_KEY, "node-b", 0, null))._tag).toBe(
        "current",
      );
      const session = (yield* b.linkedSessions)[0];
      expect(session).toBeDefined();
      yield* b.auth.revokeSession(session!.sessionId);

      const result = yield* coordinator.handover(EnvironmentId.make("node-b"));
      expect(result).toEqual({
        outcome: "handed-over-unconfirmed",
        term: 1,
        coordinatorId: "node-b",
      });
      expect(yield* coordinator.pendingPush).toEqual(["node-b"]);
      expect(yield* coordinator.current).toEqual({ term: 1, coordinatorId: "node-b" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const nodeC = descriptorOf("node-c", "Node C");
const nodeE = descriptorOf("node-e", "Node E");

/** The coordinator service a served machine would run, wired to its own links and client. */
const coordinatorOnPeer = (peer: ServedPeer, filename = ":memory:") =>
  FleetCoordinator.layerForTest(filename).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(PeerLinks.PeerLinks, peer.links),
        Layer.succeed(PeerMcpClient.PeerMcpClient, peer.client),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Ref.get(peer.descriptor).pipe(
            Effect.map((current) => current.environmentId),
          ),
          getDescriptor: Ref.get(peer.descriptor),
        }),
      ),
    ),
    Layer.build,
  );

const claimsToolkitLayer = (filename: string, fleetId: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT OR IGNORE INTO repos (owner, name) VALUES ('example', 'one')`;
    }),
  ).pipe(Layer.provideMerge(FleetClaims.layerForTest(filename, fleetId)));

const serveMachine = (descriptor: typeof nodeA, filename: string) =>
  Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
    Effect.flatMap((server) =>
      servePeer(
        descriptor,
        Layer.mergeAll(
          McpHttpServer.layerFleetClaimsToolkit.pipe(
            Layer.provide(claimsToolkitLayer(filename, descriptor.environmentId)),
          ),
          McpHttpServer.layerFleetCoordinatorToolkit.pipe(
            Layer.provide(FleetCoordinator.layerForTest(filename)),
          ),
        ),
      ).pipe(Effect.provideContext(server)),
    ),
  );

const tempLedger = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fleet-takeover-" });
  return path.join(directory, "ledger.sqlite");
});

const writeTerm = (filename: string, term: number, coordinatorId: string) =>
  Effect.gen(function* () {
    const context = yield* CoordinatorTerm.layer.pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename })),
      Layer.build,
    );
    return yield* Context.get(context, CoordinatorTerm.CoordinatorTerm).observe(
      CoordinatorTerm.FLEET_TERM_KEY,
      term,
      coordinatorId,
    );
  });

const readTerm = (filename: string) =>
  Effect.gen(function* () {
    const context = yield* CoordinatorTerm.layer.pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename })),
      Layer.build,
    );
    return yield* Context.get(context, CoordinatorTerm.CoordinatorTerm).read(
      CoordinatorTerm.FLEET_TERM_KEY,
    );
  });

const claimAt = (
  client: ServedPeer["client"],
  environmentId: (typeof nodeA)["environmentId"],
  taskId: string,
  idempotencyKey: string,
) =>
  client.call({
    environmentId,
    tool: "fleet_claim",
    arguments: {
      repo: "example/one",
      issue: 7,
      taskId,
      idempotencyKey,
    } satisfies FleetClaimClaimInput,
    limits: { runtimeMode: "auto" as const, interactionMode: "default" as const },
    success: FleetClaimClaimResult,
  });

const exchangeOnce = (
  client: ServedPeer["client"],
  environmentId: (typeof nodeA)["environmentId"],
  term: number,
  coordinatorId: (typeof nodeA)["environmentId"],
) =>
  client.call({
    environmentId,
    tool: "fleet_term_exchange",
    arguments: { term, coordinatorId },
    limits: { runtimeMode: "auto" as const, interactionMode: "default" as const },
    success: FleetTermExchangeResult,
  });

it.effect("旧协调者不可达时接管先要确认，force 后写到已知最大任期加一", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const aLedger = yield* tempLedger;
      const bLedger = yield* tempLedger;
      const cLedger = yield* tempLedger;
      expect((yield* writeTerm(aLedger, 5, "node-a"))._tag).toBe("current");
      expect((yield* writeTerm(bLedger, 5, "node-a"))._tag).toBe("current");
      // The fleet's largest known term lives on a third machine.
      expect((yield* writeTerm(cLedger, 7, "node-a"))._tag).toBe("current");
      const bMachine = yield* serveMachine(nodeB, bLedger);
      const cMachine = yield* serveMachine(nodeC, cLedger);
      const aMachine = yield* serveMachine(nodeA, aLedger);
      yield* linkTo(bMachine.links, aMachine);
      yield* linkTo(aMachine.links, bMachine);
      yield* linkTo(cMachine.links, aMachine);
      yield* linkTo(aMachine.links, cMachine);
      // The coordinator stops answering B and C: revoked sessions fail every
      // linked call the same way an unreachable machine does, without retrying.
      for (const session of yield* aMachine.linkedSessions) {
        yield* aMachine.auth.revokeSession(session.sessionId);
      }
      yield* linkTo(bMachine.links, cMachine);
      yield* linkTo(cMachine.links, bMachine);
      const bContext = yield* coordinatorOnPeer(bMachine, bLedger);
      const bCoordinator = Context.get(bContext, FleetCoordinator.FleetCoordinator);

      const refused = yield* bCoordinator.takeover({ force: false });
      expect(refused).toEqual({ outcome: "needs-confirmation", term: 7, coordinatorId: "node-a" });
      // Only learned terms land: nothing in the row is a takeover write.
      expect(yield* readTerm(bLedger)).toEqual({ term: 7, coordinatorId: "node-a" });

      const taken = yield* bCoordinator.takeover({ force: true });
      expect(taken).toEqual({ outcome: "taken-over", term: 8, coordinatorId: "node-b" });
      expect(yield* readTerm(bLedger)).toEqual({ term: 8, coordinatorId: "node-b" });
      expect(yield* readTerm(cLedger)).toEqual({ term: 8, coordinatorId: "node-b" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("三机分区各自强制接管后交换收敛到最大 ID，输的一方领单被拒", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const aLedger = yield* tempLedger;
      const bLedger = yield* tempLedger;
      const cLedger = yield* tempLedger;
      expect((yield* writeTerm(aLedger, 7, "node-a"))._tag).toBe("current");
      expect((yield* writeTerm(bLedger, 7, "node-a"))._tag).toBe("current");
      expect((yield* writeTerm(cLedger, 7, "node-a"))._tag).toBe("current");
      const bMachine = yield* serveMachine(nodeB, bLedger);
      const cMachine = yield* serveMachine(nodeC, cLedger);
      const aMachine = yield* serveMachine(nodeA, aLedger);
      yield* linkTo(bMachine.links, aMachine);
      yield* linkTo(aMachine.links, bMachine);
      yield* linkTo(cMachine.links, aMachine);
      yield* linkTo(aMachine.links, cMachine);
      // The coordinator stops answering B and C: revoked sessions fail every
      // linked call the same way an unreachable machine does, without retrying.
      for (const session of yield* aMachine.linkedSessions) {
        yield* aMachine.auth.revokeSession(session.sessionId);
      }
      // Partition: B and C cannot reach each other, so each force-takes.
      const bContext = yield* coordinatorOnPeer(bMachine, bLedger);
      const cContext = yield* coordinatorOnPeer(cMachine, cLedger);
      const bCoordinator = Context.get(bContext, FleetCoordinator.FleetCoordinator);
      const cCoordinator = Context.get(cContext, FleetCoordinator.FleetCoordinator);
      expect(yield* bCoordinator.takeover({ force: true })).toEqual({
        outcome: "taken-over",
        term: 8,
        coordinatorId: "node-b",
      });
      expect(yield* cCoordinator.takeover({ force: true })).toEqual({
        outcome: "taken-over",
        term: 8,
        coordinatorId: "node-c",
      });

      // The partition heals: one pairwise exchange converges both.
      yield* linkTo(bMachine.links, cMachine);
      yield* linkTo(cMachine.links, bMachine);
      const bTerm = yield* readTerm(bLedger);
      const reply = yield* exchangeOnce(
        bMachine.client,
        nodeC.environmentId,
        bTerm.term,
        EnvironmentId.make(bTerm.coordinatorId!),
      );
      expect(reply).toEqual({ term: 8, coordinatorId: "node-c" });
      yield* writeTerm(bLedger, reply.term, reply.coordinatorId!);
      expect(yield* readTerm(bLedger)).toEqual({ term: 8, coordinatorId: "node-c" });
      expect(yield* readTerm(cLedger)).toEqual({ term: 8, coordinatorId: "node-c" });

      const eMachine = yield* serveMachine(nodeE, ":memory:");
      yield* linkTo(eMachine.links, bMachine);
      yield* linkTo(bMachine.links, eMachine);
      yield* linkTo(eMachine.links, cMachine);
      yield* linkTo(cMachine.links, eMachine);
      const denied = yield* claimAt(
        eMachine.client,
        nodeB.environmentId,
        "loser-task",
        "e-loser",
      ).pipe(Effect.flip);
      expect(denied.code).toBe("orchestration_error");
      expect(denied.message).toContain("not the fleet coordinator");
      const claimed = yield* claimAt(
        eMachine.client,
        nodeC.environmentId,
        "winner-task",
        "e-winner",
      );
      expect(claimed.outcome).toBe("claimed");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("旧协调者可达时接管走在线交出，两边收敛到新任期", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const aLedger = yield* tempLedger;
      const bLedger = yield* tempLedger;
      expect((yield* writeTerm(aLedger, 3, "node-a"))._tag).toBe("current");
      expect((yield* writeTerm(bLedger, 3, "node-a"))._tag).toBe("current");
      const aMachine = yield* serveMachine(nodeA, aLedger);
      const bMachine = yield* serveMachine(nodeB, bLedger);
      yield* linkTo(bMachine.links, aMachine);
      yield* linkTo(aMachine.links, bMachine);
      const bContext = yield* coordinatorOnPeer(bMachine, bLedger);
      const bCoordinator = Context.get(bContext, FleetCoordinator.FleetCoordinator);

      const taken = yield* bCoordinator.takeover({ force: false });
      expect(taken).toEqual({ outcome: "taken-over", term: 4, coordinatorId: "node-b" });
      expect(yield* readTerm(aLedger)).toEqual({ term: 4, coordinatorId: "node-b" });
      expect(yield* readTerm(bLedger)).toEqual({ term: 4, coordinatorId: "node-b" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
