import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const NetworkLine = Schema.Literals(["auto", "direct", "custom"]);
export type NetworkLine = typeof NetworkLine.Type;

export const AgentNetworkLine = Schema.Literals(["follow", "direct", "custom"]);
export type AgentNetworkLine = typeof AgentNetworkLine.Type;

export const NetworkRouteSource = Schema.Literals([
  "system",
  "custom",
  "direct",
  "unavailable",
  "rejected",
]);
export type NetworkRouteSource = typeof NetworkRouteSource.Type;

export const NetworkProbeFailure = Schema.Literals(["connect", "timeout", "certificate"]);
export type NetworkProbeFailure = typeof NetworkProbeFailure.Type;

export const AgentNetworkOverride = Schema.Struct({
  line: AgentNetworkLine.pipe(Schema.withDecodingDefault(Effect.succeed("follow" as const))),
  proxyUrl: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  noProxy: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type AgentNetworkOverride = typeof AgentNetworkOverride.Type;

export const NetworkSettings = Schema.Struct({
  line: NetworkLine.pipe(Schema.withDecodingDefault(Effect.succeed("auto" as const))),
  proxyUrl: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  noProxy: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  extraCaCertPath: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  agentOverrides: Schema.Record(Schema.String, AgentNetworkOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type NetworkSettings = typeof NetworkSettings.Type;

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = Schema.decodeSync(NetworkSettings)({});

export const NetworkProbeResult = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  ok: Schema.Boolean,
  status: Schema.NullOr(Schema.Number),
  failure: Schema.NullOr(NetworkProbeFailure),
  detail: Schema.String,
  elapsedMs: Schema.Number,
});
export type NetworkProbeResult = typeof NetworkProbeResult.Type;

export const ServerNetworkInput = Schema.Struct({
  probe: Schema.optional(Schema.Boolean),
});
export type ServerNetworkInput = typeof ServerNetworkInput.Type;

export const ServerNetworkResult = Schema.Struct({
  proxyUrl: Schema.NullOr(Schema.String),
  source: NetworkRouteSource,
  detail: Schema.String,
  noProxy: Schema.String,
  probes: Schema.Array(NetworkProbeResult),
});
export type ServerNetworkResult = typeof ServerNetworkResult.Type;
