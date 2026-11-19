import type { FleetSummaryWriteResult } from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  type ExecutionEnvironmentDescriptor,
  FleetClaimClaimResult,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
  EnvironmentId,
  FleetSummaryReportInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as FleetClaims from "./FleetClaims.ts";
import * as FleetSummary from "./FleetSummary.ts";
import * as FleetSummaryReporter from "./FleetSummaryReporter.ts";

const coordinator = descriptorOf("coordinator", "Coordinator");
const nodeA = descriptorOf("node-a", "Node A");
const nodeB = descriptorOf("node-b", "Node B");
const limits = { runtimeMode: "auto" as const, interactionMode: "default" as const };
const at = DateTime.makeUnsafe(1_700_000_000_000);
const decodeSummaryReport = Schema.decodeUnknownEffect(FleetSummaryReportInput);
const decodePeerResult = <A>(schema: Schema.Decoder<A>, result: FleetSummaryWriteResult) =>
  Schema.decodeEffect(schema)(result);

const claimsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
  }),
).pipe(Layer.provideMerge(FleetClaims.layerForTest()));

const fakeEvent = (threadId: ThreadId, type: string) =>
  ({ threadId, type }) as OrchestrationV2DomainEvent;

const shell = (
  threadId: ThreadId,
  status: OrchestrationV2ThreadShell["status"],
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: threadId,
  projectId: "project-1" as OrchestrationV2ThreadShell["projectId"],
  title: `Shell ${threadId}`,
  providerInstanceId: ProviderInstanceId.make("test-instance"),
  modelSelection: { instanceId: ProviderInstanceId.make("test-instance"), model: "test" },
  runtimeMode: "auto",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status,
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});

/**
 * One linking environment: its reporter, peer client, and links. The layer is
 * built inside the caller's scope.
 */
const linkingEnvironment = (
  node: ExecutionEnvironmentDescriptor,
  shells: Ref.Ref<Map<ThreadId, OrchestrationV2ThreadShell>>,
) =>
  Effect.gen(function* () {
    const reporterDeps = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (threadId: ThreadId) =>
          Effect.map(Ref.get(shells), (map) => map.get(threadId) ?? null),
      }),
    );
    const context = yield* FleetSummaryReporter.layer.pipe(
      Layer.provideMerge(reporterDeps),
      Layer.provideMerge(layerLinkingEnvironment(node)),
      Layer.build,
    );
    return {
      reporter: Context.get(context, FleetSummaryReporter.FleetSummaryReporter),
      client: Context.get(context, PeerMcpClient.PeerMcpClient),
      links: Context.get(context, PeerLinks.PeerLinks),
    };
  });

it.effect("两台互连环境通过真实 MCP 上报各自摘要行，改动只推该行", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const summaryContext = yield* FleetSummary.layerForTest().pipe(Layer.build);
      const coordinatorSummary = Context.get(summaryContext, FleetSummary.FleetSummary);
      yield* Context.get(summaryContext, SqlClient.SqlClient)`
        INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
      yield* Context.get(summaryContext, SqlClient.SqlClient)`
        INSERT INTO node_claims (fleet_id, repo, issue, task_id, claimed_by, holder_environment,
          lease_until, executor, state, fencing, attempt, claim_idempotency_key)
        VALUES
          ('coordinator', 'example/one', 7, 'a-task', 'session-a', 'node-a',
            '2999-01-01T00:00:00.000Z', 'fleet', 'running', '1', 1, 'fixture-a'),
          ('coordinator', 'example/one', 7, 'b-task', 'session-b', 'node-b',
            '2999-01-01T00:00:00.000Z', 'fleet', 'running', '1', 1, 'fixture-b')`;
      const peer = yield* servePeer(
        coordinator,
        Layer.mergeAll(
          McpHttpServer.layerFleetClaimsToolkit.pipe(Layer.provide(claimsLayer)),
          McpHttpServer.layerFleetSummaryToolkit.pipe(
            Layer.provide(Layer.succeedContext(summaryContext)),
          ),
        ),
      );

      const aShells = yield* Ref.make(new Map<ThreadId, OrchestrationV2ThreadShell>());
      const bShells = yield* Ref.make(new Map<ThreadId, OrchestrationV2ThreadShell>());
      const a = yield* linkingEnvironment(nodeA, aShells);
      const b = yield* linkingEnvironment(nodeB, bShells);
      yield* linkTo(a.links, peer);
      yield* linkTo(b.links, peer);

      const taskThreadA = ThreadId.make("thread-a-task");
      const adhocThreadA = ThreadId.make("thread-a-adhoc");
      const taskThreadB = ThreadId.make("thread-b-task");
      const adhocThreadB = ThreadId.make("thread-b-adhoc");

      const claimA = yield* a.client.call({
        environmentId: coordinator.environmentId,
        tool: "fleet_claim",
        arguments: { repo: "example/one", issue: 7, taskId: "a-task", idempotencyKey: "a-1" },
        limits,
        success: FleetClaimClaimResult,
      });
      expect(claimA.outcome).toBe("claimed");
      const claimB = yield* b.client.call({
        environmentId: coordinator.environmentId,
        tool: "fleet_claim",
        arguments: { repo: "example/one", issue: 7, taskId: "b-task", idempotencyKey: "b-1" },
        limits,
        success: FleetClaimClaimResult,
      });
      expect(claimB.outcome).toBe("claimed");
      const holderA = claimA.claim!.holderEnvironment!;
      const holderB = claimB.claim!.holderEnvironment!;
      yield* Context.get(summaryContext, SqlClient.SqlClient)`
        UPDATE node_claims SET holder_environment = ${holderA} WHERE task_id = 'a-task'`;
      yield* Context.get(summaryContext, SqlClient.SqlClient)`
        UPDATE node_claims SET holder_environment = ${holderB} WHERE task_id = 'b-task'`;
      yield* a.reporter.trackTask(taskThreadA, claimA.claim!);
      yield* b.reporter.trackTask(taskThreadB, claimB.claim!);
      yield* a.reporter.trackAdhoc(adhocThreadA, coordinator.environmentId);
      yield* b.reporter.trackAdhoc(adhocThreadB, coordinator.environmentId);

      yield* Ref.set(
        aShells,
        new Map([
          [
            taskThreadA,
            shell(taskThreadA, "running", {
              title: "A".repeat(240),
              lastError: "E".repeat(240),
              latestVisibleMessage: {
                text: "P".repeat(100_000) + "TRANSCRIPT_SENTINEL_DIFF",
              } as OrchestrationV2ThreadShell["latestVisibleMessage"],
            }),
          ],
          [
            adhocThreadA,
            shell(adhocThreadA, "waiting", {
              title: "A 的随手活",
              pendingRuntimeRequest: {
                id: "request-1" as never,
                kind: "user_input",
                createdAt: at,
              },
            }),
          ],
        ]),
      );
      yield* Ref.set(
        bShells,
        new Map([
          [taskThreadB, shell(taskThreadB, "completed", { title: "B 的任务" })],
          [adhocThreadB, shell(adhocThreadB, "running", { title: "B 的随手活" })],
        ]),
      );

      for (const [reporter, threadId] of [
        [a.reporter, taskThreadA],
        [a.reporter, adhocThreadA],
        [b.reporter, taskThreadB],
        [b.reporter, adhocThreadB],
      ] as const) {
        yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      }

      const snapshots = yield* Stream.runCollect(
        (yield* coordinatorSummary.subscribe({})).pipe(Stream.take(1)),
      );
      const rows = snapshots.flatMap((event) => (event.type === "snapshot" ? event.rows : []));
      expect(
        rows.map((row) => `${row.environmentId}:${row.taskId ?? row.threadId}`).toSorted(),
      ).toEqual(
        [
          `${holderA}:a-task`,
          `${holderA}:${adhocThreadA}`,
          `${holderB}:b-task`,
          `${holderB}:${adhocThreadB}`,
        ].toSorted(),
      );
      const byId = new Map(rows.map((row) => [row.taskId ?? row.threadId, row] as const));
      expect(byId.get("a-task")?.phase).toBe("working");
      expect(byId.get(adhocThreadA)?.needsYou).toBe(true);
      expect(byId.get(adhocThreadA)?.phase).toBe("stuck");
      expect(byId.get("b-task")?.phase).toBe("done");
      const snapshotRevision = snapshots[0]?.type === "snapshot" ? snapshots[0].revision : 0;
      expect(byId.get("a-task")).toMatchObject({
        title: "A".repeat(200),
        reason: "E".repeat(200),
        lastProgress: "P".repeat(120),
      });
      expect(JSON.stringify(rows)).not.toContain("TRANSCRIPT_SENTINEL_DIFF");
      expect(JSON.stringify(byId.get("a-task")).length).toBeLessThan(1500);
      yield* a.reporter.handle(fakeEvent(taskThreadA, "run.updated"));
      const unchanged = yield* Stream.runCollect(
        (yield* coordinatorSummary.subscribe({})).pipe(Stream.take(1)),
      );
      expect(unchanged[0]?.type === "snapshot" ? unchanged[0].revision : -1).toBe(snapshotRevision);

      const live = yield* coordinatorSummary.subscribe({ cursor: snapshotRevision });
      yield* Ref.update(aShells, (map) => {
        const next = new Map(map);
        next.set(taskThreadA, shell(taskThreadA, "completed", { title: "A 的任务" }));
        return next;
      });
      yield* a.reporter.handle(fakeEvent(taskThreadA, "run.updated"));
      const liveEvents = yield* Stream.runCollect(live.pipe(Stream.take(1)));
      expect(liveEvents[0]?.type).toBe("upsert");
      if (liveEvents[0]?.type === "upsert") {
        expect(liveEvents[0].row.taskId).toBe("a-task");
        expect(liveEvents[0].row.phase).toBe("done");
        expect(liveEvents[0].row.environmentId).toBe(holderA);
      }

      const live2 = yield* coordinatorSummary.subscribe({
        cursor: liveEvents[0]?.type === "upsert" ? liveEvents[0].revision : snapshotRevision,
      });
      yield* a.reporter.handle(fakeEvent(adhocThreadA, "thread.deleted"));
      const tombstones = yield* Stream.runCollect(live2.pipe(Stream.take(1)));
      expect(tombstones[0]?.type).toBe("tombstone");
      if (tombstones[0]?.type === "tombstone") {
        expect(tombstones[0].key.threadId).toBe(adhocThreadA);
        expect(tombstones[0].key.environmentId).toBe(holderA);
      }
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("没有协调者链接的 track 只留状态，handle 不发任何请求", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const shells = yield* Ref.make(
        new Map([[ThreadId.make("orphan"), shell(ThreadId.make("orphan"), "running")]]),
      );
      const node = yield* linkingEnvironment(nodeA, shells);
      yield* node.reporter.trackAdhoc(ThreadId.make("orphan"), coordinator.environmentId);
      // 未 linkTo：resolve 失败被吞，handle 正常返回。
      yield* node.reporter.handle(fakeEvent(ThreadId.make("orphan"), "run.updated"));
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "registration publishes bounded fields; failed writes and tombstones remain pending",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const summaryContext = yield* FleetSummary.layerForTest().pipe(Layer.build);
        const summary = Context.get(summaryContext, FleetSummary.FleetSummary);
        const threadId = ThreadId.make("delivery-regression");
        const current = shell(threadId, "failed", {
          title: "T".repeat(240),
          lastError: "E".repeat(240),
          latestVisibleMessage: {
            text: "P".repeat(180),
          } as OrchestrationV2ThreadShell["latestVisibleMessage"],
        });
        const failure = yield* Ref.make<"invalid_request" | "orchestration_error" | null>(
          "invalid_request",
        );
        const reporterContext = yield* FleetSummaryReporter.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadShell: () => Effect.succeed(current),
              }),
              Layer.mock(PeerMcpClient.PeerMcpClient)({
                call: (request) =>
                  Effect.gen(function* () {
                    const code = yield* Ref.get(failure);
                    if (code !== null)
                      return yield* new OrchestratorMcpFailure({ code, message: "unavailable" });
                    const input = yield* decodeSummaryReport(request.arguments).pipe(Effect.orDie);
                    const result = yield* summary.report("executor", input).pipe(Effect.orDie);
                    return yield* decodePeerResult(request.success, result).pipe(Effect.orDie);
                  }),
              }),
            ),
          ),
          Layer.build,
        );
        const reporter = Context.get(reporterContext, FleetSummaryReporter.FleetSummaryReporter);
        const snapshot = () =>
          Effect.gen(function* () {
            const events = yield* Stream.runCollect(
              (yield* summary.subscribe({})).pipe(Stream.take(1)),
            );
            const event = events[0];
            if (event?.type !== "snapshot") throw new Error("Expected snapshot");
            return event;
          });

        yield* reporter.trackAdhoc(threadId, EnvironmentId.make("coordinator"));
        expect((yield* snapshot()).rows).toEqual([]);
        yield* Ref.set(failure, null);
        // The unchanged shell must still be eligible after a rejected send.
        yield* reporter.handle(fakeEvent(threadId, "run.updated"));
        const sent = yield* snapshot();
        expect(sent.rows).toHaveLength(1);
        expect(sent.rows[0]).toMatchObject({
          title: "T".repeat(200),
          reason: "E".repeat(200),
          lastProgress: "P".repeat(120),
          phase: "done",
        });
        yield* reporter.handle(fakeEvent(threadId, "run.updated"));
        expect((yield* snapshot()).revision).toBe(sent.revision);

        yield* Ref.set(failure, "orchestration_error");
        yield* reporter.untrack(threadId);
        expect((yield* snapshot()).rows).toHaveLength(1);
        yield* Ref.set(failure, null);
        yield* reporter.untrack(threadId);
        expect((yield* snapshot()).rows).toEqual([]);
        // A successful tombstone really unregisters; a later event cannot resurrect it.
        yield* reporter.handle(fakeEvent(threadId, "run.updated"));
        expect((yield* snapshot()).rows).toEqual([]);

        // Registration itself publishes an existing shell without waiting for another event.
        yield* reporter.trackAdhoc(threadId, EnvironmentId.make("coordinator"));
        expect((yield* snapshot()).rows).toHaveLength(1);
      }),
    ),
);
