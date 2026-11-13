import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

it.layer(AnalyticsService.layer)("AnalyticsService", (it) => {
  it.effect("does not send recorded events anywhere", () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("server.started", { surface: "test" });
      yield* analytics.recordOwners([], "server");
      yield* analytics.flush;
    }),
  );
});
