import { type FleetClaimHeartbeatInput, type FleetClaimHeartbeatResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetClaims from "./FleetClaims.ts";
import * as FleetHeartbeat from "./FleetHeartbeat.ts";

/** Sends one machine heartbeat to this coordinator's fleet ledger. */
export const layer = Layer.effect(
  FleetHeartbeat.FleetHeartbeatTransport,
  Effect.gen(function* () {
    const claims = yield* FleetClaims.FleetClaims;
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const environmentId = yield* environment.getEnvironmentId;
    const send = (
      input: FleetClaimHeartbeatInput,
    ): Effect.Effect<FleetClaimHeartbeatResult, FleetHeartbeat.FleetHeartbeatUnconfirmed> =>
      claims
        .heartbeat(environmentId, input)
        .pipe(
          Effect.mapError(
            () => new FleetHeartbeat.FleetHeartbeatUnconfirmed({ reason: "unavailable" }),
          ),
        );
    return FleetHeartbeat.FleetHeartbeatTransport.of({ send });
  }),
);
