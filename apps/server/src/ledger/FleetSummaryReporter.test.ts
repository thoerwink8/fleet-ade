import type { FleetSummaryWriteResult } from "@t3tools/contracts";
import { FleetSummaryError } from "@t3tools/contracts";
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
  phaseFromSessionRun,
  FleetSummaryReportInput,
  OrchestratorMcpFailure,
  FleetClaimHeartbeatResult,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import type { ServedPeer } from "../peer/PeerLinks.testkit.ts";
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
const decodeHeartbeatResult = <A>(schema: Schema.Decoder<A>, sequence: unknown) =>
  Schema.decodeEffect(schema)({ sequence, results: [] });
const decodeHeartbeat = Schema.decodeUnknownEffect(FleetClaimHeartbeatResult);

const claimsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
  }),
).pipe(Layer.provideMerge(FleetClaims.layerForTest()));

const localReporterDependencies = Layer.mergeAll(
  Layer.mock(FleetSummary.FleetSummary)({}),
  Layer.mock(FleetClaims.FleetClaims)({}),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("local-test")),
  }),
);

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
  peer?: ServedPeer,
) =>
  Effect.gen(function* () {
    const reporterDeps = Layer.mergeAll(
      Scheduler.layer,
      localReporterDependencies,
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (threadId: ThreadId) =>
          Effect.map(Ref.get(shells), (map) => map.get(threadId) ?? null),
      }),
    );
    const context = yield* FleetSummaryReporter.layerForTest().pipe(
      Layer.provideMerge(reporterDeps),
      Layer.provideMerge(
        peer === undefined
          ? layerLinkingEnvironment(node)
          : Layer.merge(
              Layer.succeed(PeerMcpClient.PeerMcpClient, peer.client),
              Layer.succeed(PeerLinks.PeerLinks, peer.links),
            ),
      ),
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
      const serveApart = (node: ExecutionEnvironmentDescriptor) =>
        Layer.build(Layer.fresh(NodeHttpServer.layerTest)).pipe(
          Effect.flatMap((server) =>
            servePeer(
              node,
              McpHttpServer.layerFleetClaimsToolkit.pipe(Layer.provide(claimsLayer)),
            ).pipe(Effect.provideContext(server)),
          ),
        );
      const peerA = yield* serveApart(nodeA);
      const peerB = yield* serveApart(nodeB);

      const aShells = yield* Ref.make(new Map<ThreadId, OrchestrationV2ThreadShell>());
      const bShells = yield* Ref.make(new Map<ThreadId, OrchestrationV2ThreadShell>());
      const a = yield* linkingEnvironment(nodeA, aShells, peerA);
      const b = yield* linkingEnvironment(nodeB, bShells, peerB);
      yield* linkTo(a.links, peer);
      yield* linkTo(peer.links, peerA);
      yield* linkTo(b.links, peer);
      yield* linkTo(peer.links, peerB);

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

      const updates = yield* coordinatorSummary.subscribe({ cursor: 0 });
      const received = yield* Effect.forkChild(Stream.runCollect(updates.pipe(Stream.take(4))));
      for (const [reporter, threadId] of [
        [a.reporter, taskThreadA],
        [a.reporter, adhocThreadA],
        [b.reporter, taskThreadB],
        [b.reporter, adhocThreadB],
      ] as const) {
        yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      }
      yield* Fiber.join(received);

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

      // node-b stops heartbeating; only its rows turn stale.
      yield* Context.get(summaryContext, SqlClient.SqlClient)`
        INSERT INTO fleet_environment_heartbeats (environment_id, last_seen) VALUES
          (${holderA}, '2999-01-01T00:00:00.000Z'),
          (${holderB}, '1970-01-01T00:00:00.000Z')`;
      yield* TestClock.adjust("100 seconds");
      yield* coordinatorSummary.sweepStale;
      const staleSnapshot = yield* Stream.runCollect(
        (yield* coordinatorSummary.subscribe({})).pipe(Stream.take(1)),
      );
      const staleRows = staleSnapshot.flatMap((event) =>
        event.type === "snapshot" ? event.rows : [],
      );
      expect(staleRows.find((row) => row.taskId === "a-task")?.stale).toBe(false);
      expect(staleRows.find((row) => row.taskId === "b-task")?.stale).toBe(false);
      expect(staleRows.find((row) => row.threadId === adhocThreadB)).toMatchObject({
        stale: true,
        staleReason: "environment offline",
      });
      yield* Context.get(summaryContext, SqlClient.SqlClient)`
        UPDATE fleet_environment_heartbeats SET last_seen = '2999-01-01T00:00:00.000Z'
        WHERE environment_id = ${holderB}`;
      yield* coordinatorSummary.sweepStale;
      const recovered = yield* Stream.runCollect(
        (yield* coordinatorSummary.subscribe({})).pipe(Stream.take(1)),
      );
      expect(
        recovered
          .flatMap((event) => (event.type === "snapshot" ? event.rows : []))
          .every((row) => !row.stale),
      ).toBe(true);

      // Ad hoc rows disappear on completion; task rows age past retention.
      yield* Ref.update(bShells, (map) => {
        const next = new Map(map);
        next.set(adhocThreadB, shell(adhocThreadB, "completed", { title: "B 的随手活" }));
        return next;
      });
      yield* b.reporter.handle(fakeEvent(adhocThreadB, "run.updated"));
      const doneCursor = yield* Stream.runCollect(
        (yield* coordinatorSummary.subscribe({})).pipe(Stream.take(1)),
      );
      const cleanupLive = yield* coordinatorSummary.subscribe({
        cursor: doneCursor[0]?.type === "snapshot" ? doneCursor[0].revision : 0,
      });
      yield* TestClock.adjust("25 hours");
      yield* coordinatorSummary.cleanupDone;
      const cleanupEvents = yield* Stream.runCollect(cleanupLive.pipe(Stream.take(2)));
      expect(cleanupEvents.every((event) => event.type === "tombstone")).toBe(true);
      expect(
        cleanupEvents
          .map((event) => (event.type === "tombstone" ? event.key.threadId : ""))
          .toSorted(),
      ).toEqual([taskThreadA, taskThreadB].toSorted());
      const empty = yield* Stream.runCollect(
        (yield* coordinatorSummary.subscribe({})).pipe(Stream.take(1)),
      );
      expect(empty.flatMap((event) => (event.type === "snapshot" ? event.rows : []))).toEqual([]);
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
        const current = shell(threadId, "running", {
          title: "T".repeat(240),
          lastError: "E".repeat(240),
          latestVisibleMessage: {
            text: "P".repeat(180),
          } as OrchestrationV2ThreadShell["latestVisibleMessage"],
        });
        const currentShell = yield* Ref.make(current);
        const heartbeats = yield* Ref.make<
          Array<{ environmentId: string; arguments: Record<string, unknown> }>
        >([]);
        const failure = yield* Ref.make<"invalid_request" | "orchestration_error" | null>(
          "invalid_request",
        );
        const reporterContext = yield* FleetSummaryReporter.layerForTest().pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
              localReporterDependencies,
              Scheduler.layer,
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadShell: () => Ref.get(currentShell),
                listActiveShellIndex: () => Effect.succeed([]),
              }),
              Layer.mock(PeerMcpClient.PeerMcpClient)({
                call: (request) =>
                  Effect.gen(function* () {
                    if (request.tool === "fleet_heartbeat") {
                      yield* Ref.update(heartbeats, (items) => [
                        ...items,
                        { environmentId: request.environmentId, arguments: request.arguments },
                      ]);
                      return yield* decodeHeartbeatResult(
                        request.success,
                        request.arguments.sequence,
                      ).pipe(Effect.orDie);
                    }
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
        yield* reporter.start();
        yield* TestClock.adjust("5 seconds");
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
        yield* TestClock.adjust("5 seconds");
        const sent = yield* snapshot();
        expect(sent.rows).toHaveLength(1);
        expect(sent.rows[0]).toMatchObject({
          title: "T".repeat(200),
          reason: "E".repeat(200),
          lastProgress: "P".repeat(120),
          phase: "working",
        });
        yield* reporter.handle(fakeEvent(threadId, "run.updated"));
        expect((yield* snapshot()).revision).toBe(sent.revision);
        // A missed event still converges from the current projection on the next tick.
        yield* Ref.set(currentShell, { ...current, title: "Changed without an event" });
        yield* TestClock.adjust("5 seconds");
        expect((yield* snapshot()).rows[0]?.title).toBe("Changed without an event");

        yield* Ref.set(failure, "orchestration_error");
        yield* reporter.handle(fakeEvent(threadId, "thread.archived"));
        expect((yield* snapshot()).rows).toHaveLength(1);
        yield* Ref.set(failure, null);
        yield* TestClock.adjust("5 seconds");
        expect((yield* snapshot()).rows).toEqual([]);
        // A successful tombstone really unregisters; a later event cannot resurrect it.
        yield* reporter.handle(fakeEvent(threadId, "run.updated"));
        expect((yield* snapshot()).rows).toEqual([]);

        // Registration itself publishes an existing shell without waiting for another event.
        yield* reporter.trackAdhoc(threadId, EnvironmentId.make("coordinator"));
        yield* TestClock.adjust("30 seconds");
        expect((yield* Ref.get(heartbeats)).at(-1)).toMatchObject({
          environmentId: "coordinator",
          arguments: { leases: [] },
        });
        expect((yield* snapshot()).rows).toHaveLength(1);

        // A leased task renews its claim on every heartbeat.
        const coordinatorSql = Context.get(summaryContext, SqlClient.SqlClient);
        yield* coordinatorSql`INSERT INTO repos (owner, name) VALUES ('example', 'one')`;
        yield* coordinatorSql`
          INSERT INTO node_claims (fleet_id, repo, issue, task_id, claimed_by, holder_environment,
            lease_until, executor, state, fencing, attempt, claim_idempotency_key)
          VALUES ('coordinator', 'example/one', 7, 't-1', 'session-a', 'executor',
            '2999-01-01T00:00:00.000Z', 'fleet', 'running', '2', 2, 'fixture')`;
        const taskThread = ThreadId.make("leased-task");
        yield* Ref.set(currentShell, shell(taskThread, "running", { title: "Leased" }));
        yield* reporter.trackTask(taskThread, {
          fleetId: "coordinator",
          repo: "example/one",
          issue: 7,
          taskId: "t-1",
          holder: "session-a",
          attempt: 2,
          fencing: "2",
          leaseUntil: "2999-01-01T00:00:00.000Z",
        });
        yield* TestClock.adjust("30 seconds");
        const lastBeat = (yield* Ref.get(heartbeats)).at(-1);
        expect(lastBeat?.arguments.leases).toEqual([
          { repo: "example/one", issue: 7, taskId: "t-1", attempt: 2, fencing: "2" },
        ]);
      }),
    ),
);

it.effect("file-backed registrations survive reconstruction and update the original row", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fleet-reporter-" });
      const filename = path.join(directory, "ledger.sqlite");
      const threadId = ThreadId.make("persisted-registration");
      const current = yield* Ref.make(shell(threadId, "running"));
      const calls = yield* Ref.make<Array<FleetSummaryReportInput>>([]);
      const fail = yield* Ref.make(false);
      const initialSent = yield* Deferred.make<void>();
      const summaryContext = yield* FleetSummary.layerForTest().pipe(Layer.build);
      const summary = Context.get(summaryContext, FleetSummary.FleetSummary);
      const summarySql = Context.get(summaryContext, SqlClient.SqlClient);
      const deps = Layer.mergeAll(
        Scheduler.layer,
        localReporterDependencies,
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Ref.get(current),
          listActiveShellIndex: () => Effect.succeed([]),
        }),
        Layer.mock(PeerMcpClient.PeerMcpClient)({
          call: (request) =>
            Effect.gen(function* () {
              if (yield* Ref.get(fail))
                return yield* new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "offline",
                });
              const input = yield* decodeSummaryReport(request.arguments).pipe(Effect.orDie);
              yield* Ref.update(calls, (items) => [...items, input]);
              const result = yield* summary.report("executor", input).pipe(Effect.orDie);
              yield* Deferred.succeed(initialSent, undefined);
              return yield* decodePeerResult(request.success, result).pipe(Effect.orDie);
            }),
        }),
      );
      const build = () =>
        FleetSummaryReporter.layerForTest(filename).pipe(
          Layer.provide(deps),
          Layer.fresh,
          Layer.build,
        );
      // Each build has a fresh service; only the file carries registrations across scopes.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* build();
          const reporter = Context.get(context, FleetSummaryReporter.FleetSummaryReporter);
          yield* reporter.trackAdhoc(threadId, EnvironmentId.make("coordinator"));
          yield* Deferred.await(initialSent);
          yield* reporter.handle(fakeEvent(threadId, "run.updated"));
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* build();
          const reporter = Context.get(context, FleetSummaryReporter.FleetSummaryReporter);
          yield* reporter.handle(fakeEvent(threadId, "run.updated"));
          expect(yield* Ref.get(calls)).toHaveLength(1);
          yield* Ref.set(current, shell(threadId, "running", { title: "Changed after restart" }));
          yield* reporter.handle(fakeEvent(threadId, "run.updated"));
          expect(yield* Ref.get(calls)).toHaveLength(2);
          expect((yield* Ref.get(calls))[1]).toMatchObject({
            type: "upsert-adhoc",
            threadId,
            title: "Changed after restart",
          });
          expect(yield* summarySql`SELECT thread_id, title FROM fleet_summary_rows`).toEqual([
            { thread_id: threadId, title: "Changed after restart" },
          ]);
          yield* Ref.set(fail, true);
          yield* reporter.untrack(threadId);
        }),
      );
      yield* Ref.set(fail, false);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reporter = Context.get(yield* build(), FleetSummaryReporter.FleetSummaryReporter);
          yield* reporter.start();
          yield* TestClock.adjust("5 seconds");
          expect((yield* Ref.get(calls)).at(-1)).toMatchObject({ type: "delete-adhoc", threadId });
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("a failed event subscription is reopened instead of silently stopping", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscriptions = yield* Ref.make(0);
      const streamDomainEvents = Stream.suspend(() =>
        Stream.unwrap(
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(subscriptions, (n) => n + 1);
            return count === 1 ? Stream.die("controlled subscription failure") : Stream.never;
          }),
        ),
      );
      const context = yield* FleetSummaryReporter.layerForTest().pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            localReporterDependencies,
            Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            Layer.mock(PeerMcpClient.PeerMcpClient)({}),
          ),
        ),
        Layer.build,
      );
      yield* Context.get(context, FleetSummaryReporter.FleetSummaryReporter).start();
      yield* TestClock.adjust("5 seconds");
      expect(yield* Ref.get(subscriptions)).toBeGreaterThanOrEqual(2);
    }),
  ),
);

it.effect(
  "self-coordination registers locally, heartbeats itself, and sweeps ad hoc sessions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selfId = EnvironmentId.make("self");
        const summaryContext = yield* FleetSummary.layerForTest(
          "file:fleet-self?mode=memory&cache=shared",
        ).pipe(Layer.build);
        const summary = Context.get(summaryContext, FleetSummary.FleetSummary);
        const claimsContext = yield* FleetClaims.layerForTest(
          "file:fleet-self?mode=memory&cache=shared",
          selfId,
        ).pipe(Layer.build);
        const localThread = ThreadId.make("local-thread");
        const live = yield* Ref.make(true);
        const peerCalls = yield* Ref.make(0);
        const reporterContext = yield* FleetSummaryReporter.layerForTest().pipe(
          Layer.provide(
            Layer.mergeAll(
              Scheduler.layer,
              Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(selfId),
              }),
              Layer.succeedContext(summaryContext),
              Layer.succeedContext(claimsContext),
              Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadShell: () =>
                  Effect.map(Ref.get(live), (value) =>
                    shell(localThread, value ? "running" : "idle"),
                  ),
                listActiveShellIndex: () =>
                  Effect.map(Ref.get(live), (mayBeLive) => [
                    { id: localThread, mayBeLive } as ProjectionStore.ActiveShellIndexEntry,
                  ]),
              }),
              Layer.mock(PeerLinks.PeerLinks)({
                list: Effect.succeed([] as ReadonlyArray<PeerLinkSummary>),
              }),
              Layer.mock(PeerMcpClient.PeerMcpClient)({
                call: () => Ref.updateAndGet(peerCalls, (n) => n + 1).pipe(Effect.as({})),
              }),
            ),
          ),
          Layer.build,
        );
        const reporter = Context.get(reporterContext, FleetSummaryReporter.FleetSummaryReporter);
        yield* reporter.start();
        yield* TestClock.adjust("30 seconds");

        // The local thread became an ad hoc row in this environment's own summary.
        const events = yield* Stream.runCollect(
          (yield* summary.subscribe({})).pipe(Stream.take(1)),
        );
        if (events[0]?.type !== "snapshot") throw new Error("Expected snapshot");
        expect(events[0].rows).toEqual([
          expect.objectContaining({
            environmentId: selfId,
            threadId: localThread,
            phase: "working",
          }),
        ]);
        // It heartbeated itself, so its row never sweeps stale while the server lives.
        yield* TestClock.adjust("10 minutes");
        yield* summary.sweepStale;
        const later = yield* Stream.runCollect((yield* summary.subscribe({})).pipe(Stream.take(1)));
        if (later[0]?.type !== "snapshot") throw new Error("Expected snapshot");
        expect(later[0].rows[0]?.stale).toBe(false);
        // Nothing was routed over a peer link.
        expect(yield* Ref.get(peerCalls)).toBe(0);

        // A shell update flows to the self row too.
        yield* reporter.handle(fakeEvent(localThread, "run.updated"));
        const updated = yield* Stream.runCollect(
          (yield* summary.subscribe({})).pipe(Stream.take(1)),
        );
        if (updated[0]?.type !== "snapshot") throw new Error("Expected snapshot");
        expect(updated[0].rows).toHaveLength(1);
        yield* Ref.set(live, false);
        yield* reporter.handle(fakeEvent(localThread, "run.updated"));
        const ended = yield* Stream.runCollect((yield* summary.subscribe({})).pipe(Stream.take(1)));
        if (ended[0]?.type !== "snapshot") throw new Error("Expected snapshot");
        expect(ended[0].rows).toEqual([]);
        yield* TestClock.adjust("5 seconds");
        const afterSweep = yield* Stream.runCollect(
          (yield* summary.subscribe({})).pipe(Stream.take(1)),
        );
        if (afterSweep[0]?.type !== "snapshot") throw new Error("Expected snapshot");
        expect(afterSweep[0].rows).toEqual([]);
      }),
    ),
);

it.effect("converting an ad hoc registration deletes it before publishing the task", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("conversion");
      const reports = yield* Ref.make<Array<FleetSummaryReportInput>>([]);
      const adhocSent = yield* Deferred.make<void>();
      const taskSent = yield* Deferred.make<void>();
      const context = yield* FleetSummaryReporter.layerForTest().pipe(
        Layer.provide(
          Layer.mergeAll(
            localReporterDependencies,
            Scheduler.layer,
            Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () => Effect.succeed(shell(threadId, "running")),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({
              call: (request) =>
                Effect.gen(function* () {
                  const input = yield* decodeSummaryReport(request.arguments).pipe(Effect.orDie);
                  yield* Ref.update(reports, (items) => [...items, input]);
                  if (input.type === "upsert-adhoc") yield* Deferred.succeed(adhocSent, undefined);
                  if (input.type === "upsert-task") yield* Deferred.succeed(taskSent, undefined);
                  return yield* decodePeerResult(request.success, {
                    revision: 1,
                    changed: true,
                  }).pipe(Effect.orDie);
                }),
            }),
          ),
        ),
        Layer.build,
      );
      const reporter = Context.get(context, FleetSummaryReporter.FleetSummaryReporter);
      const coordinatorId = EnvironmentId.make("coordinator");
      yield* reporter.trackAdhoc(threadId, coordinatorId);
      yield* Deferred.await(adhocSent);
      yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      yield* reporter.trackTask(threadId, {
        fleetId: coordinatorId,
        repo: "example/one",
        issue: 7,
        taskId: "task",
        holder: "holder",
        attempt: 1,
        fencing: "1",
        leaseUntil: "2999-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(taskSent);
      yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      expect((yield* Ref.get(reports)).map((input) => input.type)).toEqual([
        "upsert-adhoc",
        "delete-adhoc",
        "upsert-task",
      ]);
    }),
  ),
);

it.effect("a delayed ad hoc acknowledgement cannot overwrite a task registration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("delayed-conversion");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const taskSent = yield* Deferred.make<void>();
      const calls = yield* Ref.make<Array<string>>([]);
      const rejectDelete = yield* Ref.make(true);
      const deleted = yield* Deferred.make<void>();
      const context = yield* FleetSummaryReporter.layerForTest().pipe(
        Layer.provide(
          Layer.mergeAll(
            localReporterDependencies,
            Scheduler.layer,
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () => Effect.succeed(shell(threadId, "running")),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({
              call: (request) =>
                Effect.gen(function* () {
                  const input = yield* decodeSummaryReport(request.arguments).pipe(Effect.orDie);
                  yield* Ref.update(calls, (items) => [...items, input.type]);
                  if (input.type === "upsert-task") yield* Deferred.succeed(taskSent, undefined);
                  if (input.type === "delete-adhoc" && (yield* Ref.get(rejectDelete))) {
                    yield* Deferred.succeed(deleted, undefined);
                    return yield* new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: "offline",
                    });
                  }
                  if (input.type === "upsert-adhoc") {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                  return yield* decodePeerResult(request.success, {
                    revision: 1,
                    changed: true,
                  }).pipe(Effect.orDie);
                }),
            }),
          ),
        ),
        Layer.build,
      );
      const reporter = Context.get(context, FleetSummaryReporter.FleetSummaryReporter);
      const coordinatorId = EnvironmentId.make("coordinator");
      const initial = yield* Effect.forkChild(reporter.trackAdhoc(threadId, coordinatorId));
      yield* Deferred.await(entered);
      const task = yield* Effect.forkChild(
        reporter.trackTask(threadId, {
          fleetId: coordinatorId,
          repo: "example/one",
          issue: 7,
          taskId: "task",
          holder: "holder",
          attempt: 1,
          fencing: "1",
          leaseUntil: "2999-01-01T00:00:00.000Z",
        }),
      );
      yield* Fiber.join(task);
      expect(yield* Ref.get(calls)).toEqual(["upsert-adhoc"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(initial);
      yield* Deferred.await(deleted);
      yield* Ref.set(rejectDelete, false);
      yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      yield* Deferred.await(taskSent);
      yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      expect(yield* Ref.get(calls)).toEqual([
        "upsert-adhoc",
        "delete-adhoc",
        "delete-adhoc",
        "upsert-task",
      ]);
    }),
  ),
);

it.effect("lease rejection remains stopped across repeated registration and heartbeats", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("lost-lease");
      const calls = yield* Ref.make(0);
      const rejected = yield* Deferred.make<void>();
      const context = yield* FleetSummaryReporter.layerForTest().pipe(
        Layer.provide(
          Layer.mergeAll(
            localReporterDependencies,
            Scheduler.layer,
            Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () => Effect.succeed(shell(threadId, "running")),
              listActiveShellIndex: () => Effect.succeed([]),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({
              call: () =>
                Ref.update(calls, (count) => count + 1).pipe(
                  Effect.andThen(Deferred.succeed(rejected, undefined)),
                  Effect.andThen(
                    Effect.fail(
                      new OrchestratorMcpFailure({
                        code: "invalid_request",
                        message: "fleet-summary:lease-required",
                      }),
                    ),
                  ),
                ),
            }),
          ),
        ),
        Layer.build,
      );
      const reporter = Context.get(context, FleetSummaryReporter.FleetSummaryReporter);
      const claim = {
        fleetId: "coordinator",
        repo: "example/one",
        issue: 7,
        taskId: "task",
        holder: "holder",
        attempt: 1,
        fencing: "1",
        leaseUntil: "2999-01-01T00:00:00.000Z",
      };
      yield* reporter.trackTask(threadId, claim);
      yield* Deferred.await(rejected);
      yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      yield* reporter.trackTask(threadId, claim);
      yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      expect(yield* Ref.get(calls)).toBe(1);
    }),
  ),
);

it.effect("negative heartbeat outcomes stop only the matching leased registration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<string>>([]);
      const threadIds = ["taken-over", "released", "expired"].map((id) => ThreadId.make(id));
      const context = yield* FleetSummaryReporter.layerForTest().pipe(
        Layer.provide(
          Layer.mergeAll(
            localReporterDependencies,
            Scheduler.layer,
            Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: (id) => Effect.succeed(shell(id, "running")),
              listActiveShellIndex: () => Effect.succeed([]),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({
              call: (request) =>
                Effect.gen(function* () {
                  yield* Ref.update(calls, (items) => [...items, request.tool]);
                  if (request.tool === "fleet_heartbeat") {
                    const leases = request.arguments.leases as ReadonlyArray<{
                      repo: string;
                      issue: number;
                      taskId: string;
                      attempt: number;
                    }>;
                    return yield* decodeHeartbeat({
                      sequence: request.arguments.sequence,
                      results: leases.map((lease) => ({
                        ...lease,
                        outcome: lease.taskId,
                        claim: null,
                      })),
                    }).pipe(Effect.orDie);
                  }
                  return yield* decodePeerResult(request.success, {
                    revision: 1,
                    changed: true,
                  }).pipe(Effect.orDie);
                }),
            }),
          ),
        ),
        Layer.build,
      );
      const reporter = Context.get(context, FleetSummaryReporter.FleetSummaryReporter);
      for (const threadId of threadIds) {
        yield* reporter.trackTask(threadId, {
          fleetId: "coordinator",
          repo: "example/one",
          issue: 7,
          taskId: threadId,
          holder: "holder",
          attempt: 1,
          fencing: "1",
          leaseUntil: "2999-01-01T00:00:00.000Z",
        });
        yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      }
      yield* reporter.start();
      yield* TestClock.adjust("30 seconds");
      const before = yield* Ref.get(calls);
      for (const threadId of threadIds) yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      yield* TestClock.adjust("30 seconds");
      expect(yield* Ref.get(calls)).toEqual(before);
    }),
  ),
);

it.effect("a local lease-required response stops subsequent task reports", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("local-lost");
      const writes = yield* Ref.make(0);
      const self = EnvironmentId.make("self");
      const status = yield* Ref.make<OrchestrationV2ThreadShell["status"]>("running");
      const rejected = yield* Deferred.make<void>();
      const context = yield* FleetSummaryReporter.layerForTest().pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(self),
            }),
            Layer.mock(FleetClaims.FleetClaims)({}),
            Layer.mock(FleetSummary.FleetSummary)({
              report: () =>
                Ref.update(writes, (count) => count + 1).pipe(
                  Effect.andThen(Deferred.succeed(rejected, undefined)),
                  Effect.andThen(
                    Effect.fail(
                      new FleetSummaryError({ reason: "lease-required", message: "lost" }),
                    ),
                  ),
                ),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () => Effect.map(Ref.get(status), (value) => shell(threadId, value)),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({}),
          ),
        ),
        Layer.build,
      );
      const reporter = Context.get(context, FleetSummaryReporter.FleetSummaryReporter);
      const claim = {
        fleetId: self,
        repo: "example/one",
        issue: 7,
        taskId: "task",
        holder: "holder",
        attempt: 1,
        fencing: "1",
        leaseUntil: "2999-01-01T00:00:00.000Z",
      };
      yield* reporter.trackTask(threadId, claim);
      yield* Deferred.await(rejected);
      yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      yield* reporter.trackTask(threadId, claim);
      yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      expect(yield* Ref.get(writes)).toBe(1);
      yield* Ref.set(status, "completed");
      yield* reporter.handle(fakeEvent(threadId, "run.updated"));
      expect(yield* Ref.get(writes)).toBe(2);
    }),
  ),
);

it("maps an idle executor session to done", () => {
  expect(phaseFromSessionRun("idle")).toBe("done");
});
