import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as FleetClaims from "../../../ledger/FleetClaims.ts";
import * as PeerChallengeRegistry from "../../../peer/PeerChallengeRegistry.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const claimsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
  }),
).pipe(Layer.provideMerge(FleetClaims.layerForTest()));

const serverLayer = McpHttpServer.layerFleetClaimsToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(claimsLayer),
  Layer.provide(PeerChallengeRegistry.layer),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const linkedClient = (sessionId: string, environmentId?: string) =>
  ({
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: `client:${sessionId}`,
    thread: undefined,
    client: {
      sessionId,
      label: "Peer",
      access: "full-access" as const,
      linked: true,
      ...(environmentId === undefined ? {} : { environmentId }),
    },
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
  }) satisfies McpInvocationContext.McpInvocationScope;

const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.map(({ content }) =>
      JSON.parse(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const key = { repo: "example/one", issue: 7, taskId: "root" };

it.effect("旧客户端没有环境身份时，提示升级而不是重新链接", () =>
  Effect.gen(function* () {
    const result = yield* call("fleet_claim", linkedClient("old-session"), {
      ...key,
      idempotencyKey: "claim-a",
    });
    expect(result.code).toBe("invalid_request");
    expect(result.message).toContain("Update the linked environment");
  }).pipe(Effect.provide(serverLayer)),
);

it.effect("MCP 续租走完整装配，错误持有人拿到 not-owned，过期序列拿到 taken-over", () =>
  Effect.gen(function* () {
    const alice = linkedClient("session-a", "session-a");
    const bob = linkedClient("session-b", "session-b");

    const claimed = yield* call("fleet_claim", alice, { ...key, idempotencyKey: "claim-a" });
    expect(claimed.outcome).toBe("claimed");
    expect(claimed.claim.attempt).toBe(1);

    const renewed = yield* call("fleet_renew", alice, {
      ...key,
      attempt: 1,
      fencing: "1",
      idempotencyKey: "renew-a",
    });
    expect(renewed.outcome).toBe("renewed");

    const heartbeat = yield* call("fleet_heartbeat", alice, {
      sequence: 1,
      leases: [{ ...key, attempt: 1, fencing: "1" }],
    });
    expect(heartbeat.results[0].outcome).toBe("renewed");

    const wrongHolder = yield* call("fleet_heartbeat", bob, {
      sequence: 1,
      leases: [{ ...key, attempt: 1, fencing: "1" }],
    });
    expect(wrongHolder.results[0].outcome).toBe("not-owned");

    const released = yield* call("fleet_release", alice, {
      ...key,
      attempt: 1,
      fencing: "1",
      idempotencyKey: "release-a",
    });
    expect(released.outcome).toBe("released");

    const reclaimed = yield* call("fleet_claim", alice, { ...key, idempotencyKey: "claim-b" });
    expect(reclaimed.outcome).toBe("claimed");
    expect(reclaimed.claim.attempt).toBe(2);

    const stale = yield* call("fleet_heartbeat", alice, {
      sequence: 2,
      leases: [{ ...key, attempt: 1, fencing: "1" }],
    });
    expect(stale.results[0].outcome).toBe("taken-over");
  }).pipe(Effect.provide(serverLayer)),
);
