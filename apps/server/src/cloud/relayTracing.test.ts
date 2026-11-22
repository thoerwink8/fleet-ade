import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import { relayLayer } from "./relayTracing.ts";

const tracesTo = (tracingConfig: Parameters<typeof relayLayer>[1]) =>
  Effect.service(RelayTracing.RelayClientTracer).pipe(
    Effect.provide(
      relayLayer(
        { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
        tracingConfig,
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-tracing-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
    Effect.map(Option.isSome),
  );

it.effect("traces the relay only when a trace endpoint is configured", () =>
  Effect.gen(function* () {
    assert.isTrue(
      yield* tracesTo({
        tracesUrl: "https://traces.example.com",
        tracesDataset: "relay",
        tracesToken: "token",
      }),
    );
    assert.isFalse(yield* tracesTo(null));
  }),
);
