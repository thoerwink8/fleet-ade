import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as FleetClaims from "./ledger/FleetClaims.ts";
import * as ClaimLease from "./pipeline/claimLease.ts";
import * as FleetSummary from "./ledger/FleetSummary.ts";
import * as FleetSummaryReporter from "./ledger/FleetSummaryReporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { layerFleetSummaryReporter } from "./server.ts";

it.effect(
  "the server reporter composition constructs with its real fleet and identity dependencies",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shared = Layer.mergeAll(
          layerFleetSummaryReporter,
          FleetSummary.layer,
          FleetClaims.layer,
          ClaimLease.layerLive,
        ).pipe(
          Layer.provideMerge(FleetSummary.layer),
          Layer.provideMerge(ServerEnvironment.layerIdentity),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
          ),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "fleet-server-wiring-" })),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        );
        const context = yield* Layer.build(shared);
        const reporter = Context.get(context, FleetSummaryReporter.FleetSummaryReporter);
        yield* reporter.start();
        yield* reporter.trackAdhoc(
          ThreadId.make("missing-thread"),
          yield* Context.get(context, ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId,
        );
        yield* TestClock.adjust("5 seconds");
        const events = yield* Stream.runCollect(
          (yield* Context.get(context, FleetSummary.FleetSummary).subscribe({})).pipe(
            Stream.take(1),
          ),
        );
        expect(events[0]?.type).toBe("snapshot");
      }),
    ),
);
