import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TelemetryOwner } from "./Identify.ts";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    readonly flush: Effect.Effect<void>;

    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

// Remote ingest is gone. Call sites stay so startup and websocket code do not grow a second path.
const make = Effect.succeed(
  AnalyticsService.of({
    record: Effect.fn("AnalyticsService.record")(() => Effect.void),
    flush: Effect.void,
    recordOwners: Effect.fn("AnalyticsService.recordOwners")(() => Effect.void),
  }),
);

export const layer = Layer.effect(AnalyticsService, make);
