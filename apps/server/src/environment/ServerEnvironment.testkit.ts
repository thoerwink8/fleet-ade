import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "./ServerEnvironment.ts";

/** A stable identity for tests that build orchestration layers by hand. */
export const layerTestIdentity = (environmentId: string) =>
  Layer.succeed(
    ServerEnvironment.ServerEnvironmentIdentity,
    ServerEnvironment.ServerEnvironmentIdentity.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentId)),
    }),
  );
