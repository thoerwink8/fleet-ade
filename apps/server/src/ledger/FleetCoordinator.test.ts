import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as CoordinatorTerm from "./coordinatorTerm.ts";
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
      expect((yield* terms.handover(CoordinatorTerm.FLEET_TERM_KEY, "node-b", 0))._tag).toBe(
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
