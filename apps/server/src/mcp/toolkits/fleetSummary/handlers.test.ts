import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as FleetSummary from "../../../ledger/FleetSummary.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const serverLayer = McpHttpServer.layerFleetSummaryToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(FleetSummary.layerForTest()),
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

const clientScope = (linked: boolean, environmentId?: string) =>
  ({
    environmentId: EnvironmentId.make("coordinator"),
    requestNamespace: "client:summary-session",
    thread: undefined,
    client: {
      sessionId: "summary-session",
      label: "Peer",
      access: "full-access" as const,
      linked,
      ...(environmentId === undefined ? {} : { environmentId }),
    },
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
  }) satisfies McpInvocationContext.McpInvocationScope;

const call = (scope: McpInvocationContext.McpInvocationScope, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "fleet_summary_report", arguments: args })),
    Effect.map(({ content }) =>
      JSON.parse(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const report = {
  type: "upsert-adhoc",
  threadId: "shared-thread",
  title: "Summary",
  sessionRun: "running",
  reason: "working",
  needsYou: false,
  lastProgress: "Building",
};

it.effect("fleet_summary_report denies unlinked callers without writing a summary", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const result = yield* call(clientScope(false, "environment-a"), report);
    expect(result.code).toBe("capability_denied");
    expect(yield* sql`SELECT environment_id FROM fleet_summary_rows`).toEqual([]);
    expect(yield* sql`SELECT revision FROM fleet_summary_meta WHERE id = 1`).toEqual([
      { revision: 0 },
    ]);
  }).pipe(Effect.provide(serverLayer)),
);

it.effect("fleet_summary_report denies linked callers without an environment identity", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const result = yield* call(clientScope(true), report);
    expect(result.code).toBe("capability_denied");
    expect(result.message).toBe("Linked environment required.");
    expect(yield* sql`SELECT environment_id FROM fleet_summary_rows`).toEqual([]);
    expect(yield* sql`SELECT revision FROM fleet_summary_meta WHERE id = 1`).toEqual([
      { revision: 0 },
    ]);
  }).pipe(Effect.provide(serverLayer)),
);

it.effect("fleet_summary_report identifies lease rejection for remote reporters", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
    const result = yield* call(clientScope(true, "environment-a"), {
      ...report,
      type: "upsert-task",
      repo: "example/one",
      issue: 7,
      taskId: "root",
      fencing: "old-fencing",
    });
    expect(result).toMatchObject({
      code: "invalid_request",
      message: "fleet-summary:lease-required",
    });
    expect(yield* sql`SELECT environment_id FROM fleet_summary_rows`).toEqual([]);
  }).pipe(Effect.provide(serverLayer)),
);

it.effect(
  "fleet_summary_report uses server-scoped identity for writes and cannot spoof another environment",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const victim = yield* call(clientScope(true, "environment-b"), report);
      expect(victim.changed).toBe(true);

      const spoofedWrite = yield* Effect.exit(
        call(clientScope(true, "environment-a"), {
          ...report,
          environmentId: "environment-b",
        }),
      );
      expect(spoofedWrite._tag).toBe("Failure");
      expect(JSON.stringify(spoofedWrite)).toContain("InvalidParams");
      expect(yield* sql`SELECT environment_id, title FROM fleet_summary_rows`).toEqual([
        { environment_id: "environment-b", title: "Summary" },
      ]);

      const result = yield* call(clientScope(true, "environment-a"), {
        ...report,
        title: "Caller summary",
      });
      expect(result.changed).toBe(true);
      expect(
        yield* sql`SELECT environment_id, title FROM fleet_summary_rows ORDER BY environment_id`,
      ).toEqual([
        { environment_id: "environment-a", title: "Caller summary" },
        { environment_id: "environment-b", title: "Summary" },
      ]);

      const spoofedDelete = yield* Effect.exit(
        call(clientScope(true, "environment-a"), {
          type: "delete-adhoc",
          threadId: report.threadId,
          environmentId: "environment-b",
        }),
      );
      expect(spoofedDelete._tag).toBe("Failure");
      expect(JSON.stringify(spoofedDelete)).toContain("InvalidParams");
      expect(
        yield* sql`SELECT environment_id, title FROM fleet_summary_rows ORDER BY environment_id`,
      ).toEqual([
        { environment_id: "environment-a", title: "Caller summary" },
        { environment_id: "environment-b", title: "Summary" },
      ]);

      const deletion = yield* call(clientScope(true, "environment-a"), {
        type: "delete-adhoc",
        threadId: report.threadId,
      });
      expect(deletion.changed).toBe(true);
      expect(yield* sql`SELECT environment_id, title FROM fleet_summary_rows`).toEqual([
        { environment_id: "environment-b", title: "Summary" },
      ]);
    }).pipe(Effect.provide(serverLayer)),
);
