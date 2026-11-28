import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  BotId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  SecretRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import { nextScheduledRunAt } from "./Schedule.ts";

const isScheduledTaskError = Schema.is(ScheduledTaskError);

const threadShell = (
  projectId: ProjectId,
  state: { archivedAt?: string | null; deletedAt?: string | null } = {},
) => ({ projectId, archivedAt: null, deletedAt: null, ...state }) as never;

const insertRow = (
  sql: SqlClient.SqlClient,
  row: {
    id: string | null;
    next: string | null;
    enabled: number;
    status: string;
    scheduleJson?: string;
    prompt?: string;
  },
  now: string,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: row.id,
    title: "task",
    prompt: row.prompt ?? "Run task",
    enabled: row.enabled,
    schedule_json: row.scheduleJson ?? '{"type":"interval","everyMs":60000}',
    project_id: "project:test",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: row.next,
    last_run_at: null,
    last_run_status: row.status,
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect("loads only due tasks and skips corrupt due rows without decoding settled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    const secret = "PROMPT-SECRET-DO-NOT-LOG";
    const credential = "CREDENTIAL-SECRET-DO-NOT-LOG";
    for (const row of [
      { id: "due-now", next: now, enabled: 1, status: "never" },
      { id: "", next: now, enabled: 1, status: "never" },
      { id: "   ", next: now, enabled: 1, status: "never" },
      { id: null, next: now, enabled: 1, status: "never" },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
      },
      { id: "due-bad-date", next: "", enabled: 1, status: "never" },
      {
        id: "due-corrupt",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "due-cred",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: `{"type":"interval","everyMs":"${credential}"}`,
      },
      { id: "disabled", next: now, enabled: 0, status: "never", scheduleJson: "broken" },
      {
        id: "future",
        next: "2026-09-09T12:00:00.001Z",
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "unscheduled",
        next: null,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      { id: "running", next: now, enabled: 1, status: "running", scheduleJson: "broken" },
    ]) {
      yield* insertRow(sql, { ...row, prompt: secret }, now);
    }
    const warnings: unknown[] = [];
    const tasks = yield* ScheduledTaskService.listDueTasks(DateTime.makeUnsafe(now)).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["due-earlier", "due-now"],
    );
    assert.equal(warnings.length, 6);
    const annotations = warnings.map(
      (warning) => (warning as ReadonlyArray<unknown>)[1] as Record<string, unknown>,
    );
    assert.deepEqual(
      annotations.map((annotation) => annotation.taskId),
      ["due-bad-date", null, "", "   ", "due-corrupt", "due-cred"],
    );
    const causes = annotations.map((annotation) => annotation.cause);
    assert.deepEqual(
      causes.map((cause) => (isScheduledTaskError(cause) ? cause.taskId : undefined)),
      [undefined, undefined, undefined, undefined, "due-corrupt", "due-cred"],
    );
    for (const cause of causes) {
      if (cause !== undefined) assert.isTrue(isScheduledTaskError(cause));
    }
    const rendered = NodeUtil.inspect(annotations, { depth: null });
    assert.isFalse(rendered.includes(secret));
    assert.isFalse(rendered.includes(credential));
    const running = yield* sql<{
      last_run_status: string;
    }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'running'`;
    assert.equal(running[0]?.last_run_status, "running");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "releases interrupted runs on startup and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      for (const row of [
        { id: "stuck-valid", next: now, status: "running" },
        { id: "stuck-corrupt", next: now, status: "running", scheduleJson: "broken" },
        { id: "stuck-huge", next: now, status: "running", scheduleJson: hugeInterval },
        { id: null, next: now, status: "running" },
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }

      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 4
                          ? Deferred.succeed(lastDispatched, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseLast)),
                            )
                          : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          // The poll delays before its first pass; advance the frozen clock once.
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          const inflight = yield* sql<{
            last_run_status: string;
          }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'due-third'`;
          assert.equal(inflight[0]?.last_run_status, "running");
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );

      const rows = yield* sql<{
        task_id: string | null;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count
       FROM scheduled_tasks ORDER BY task_id`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      assert.equal(rows.length, 9);
      assert.equal(byId.get("stuck-valid")?.last_run_status, "failed");
      assert.isNotNull(byId.get("stuck-valid")?.next_run_at);
      assert.equal(byId.get("stuck-corrupt")?.last_run_status, "failed");
      assert.equal(byId.get(null)?.last_run_status, "failed");
      const stuckHuge = byId.get("stuck-huge");
      assert.equal(stuckHuge?.last_run_status, "failed");
      assert.isNull(stuckHuge?.next_run_at);
      for (const id of ["stuck-valid", "stuck-corrupt", "stuck-huge", null]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_error, "Run was interrupted by a server restart.");
        assert.equal(row?.run_count, 1);
      }
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.isTrue(row?.last_run_error?.includes("test launch failure") === true);
        assert.equal(row?.run_count, 1);
      }
      assert.isNull(byId.get("due-huge")?.next_run_at);
      assert.equal(byId.get("due-bad-date")?.last_run_status, "never");
      assert.equal(byId.get("due-bad-date")?.run_count, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "treats a next_run_at corrupted before the dispatch re-read as not due instead of defecting the poll",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      for (const row of [
        { id: "run-a", next: now, status: "never" },
        { id: "run-b-victim", next: now, status: "never" },
        { id: "run-c", next: now, status: "never" },
        { id: "run-d", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 1
                          ? sql`UPDATE scheduled_tasks
                                SET next_run_at = ''
                                WHERE task_id = 'run-b-victim'`.pipe(Effect.asVoid, Effect.orDie)
                          : n === 3
                            ? Deferred.succeed(lastDispatched, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseLast)),
                              )
                            : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          assert.equal(yield* Ref.get(dispatched), 3);
          const rows = yield* sql<{
            task_id: string;
            last_run_status: string;
            next_run_at: string | null;
            run_count: number;
          }>`SELECT task_id, last_run_status, next_run_at, run_count
             FROM scheduled_tasks ORDER BY task_id`;
          const byId = new Map(rows.map((row) => [row.task_id, row]));
          const victim = byId.get("run-b-victim");
          assert.equal(victim?.last_run_status, "never");
          assert.equal(victim?.run_count, 0);
          assert.equal(victim?.next_run_at, "");
          for (const id of ["run-a", "run-c"]) {
            const row = byId.get(id);
            assert.equal(row?.last_run_status, "failed");
            assert.equal(row?.run_count, 1);
          }
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("thread cleanup notifies subscribers and a finishing run cannot recreate the task", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const subscribed = yield* Deferred.make<void>();
    const running = yield* Deferred.make<void>();
    const removed = yield* Deferred.make<void>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("test dispatch failure")),
              ),
            getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:deleted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:deleted-during-run"),
        title: "Check orchestration",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.subscribeList().pipe(
        Stream.runForEach(({ tasks }) => {
          const current = tasks.find((candidate) => candidate.id === task.id);
          if (current === undefined) return Deferred.succeed(removed, undefined);
          return current.lastRunStatus === "running"
            ? Deferred.succeed(running, undefined)
            : Deferred.succeed(subscribed, undefined);
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const run = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.await(running);
      const refused = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.equal(refused.message, "Schedule task is already running.");
      yield* service.deleteForThread(threadId);
      yield* Deferred.await(removed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(run);
      assert.lengthOf((yield* service.list()).tasks, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { status: "failed", error: "Weekly usage limit reached" },
  { status: "interrupted", error: "The run was stopped." },
  { status: "cancelled", error: "The run was cancelled." },
] as const)("a run that ends $status after its message was accepted records it", (outcome) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:test");
    const ended = yield* Deferred.make<void>();
    const sent = yield* Ref.make("");
    const run = { id: "run:2", status: outcome.status, rootNodeId: "node:root" };
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) => Ref.set(sent, input.messageId).pipe(Effect.as({} as never)),
            getThreadShell: () => Effect.succeed(threadShell(projectId)),
            getProjectThreadRecords: () =>
              Effect.map(
                Ref.get(sent),
                (userMessageId) =>
                  ({
                    runs: [
                      { id: "run:1", status: "completed", userMessageId: "message:earlier" },
                      { ...run, userMessageId },
                    ],
                    messages: [{ id: userMessageId, runId: "run:2" }],
                    turnItems: [
                      {
                        type: "error",
                        status: "failed",
                        runId: "run:2",
                        nodeId: "node:root",
                        failure: { message: "Weekly usage limit reached" },
                      },
                    ],
                  }) as never,
              ),
            waitForThread: (input) =>
              Deferred.await(ended).pipe(
                Effect.as({
                  threadId: input.threadId,
                  run: { ...run, id: input.runId, userMessageId: "" },
                  timedOut: false,
                } as never),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:quota"),
        title: "Quota bookkeeping",
        prompt: "Update the notes",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId: ThreadId.make("thread:quota"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.runNow({ id: task.id });
      const failed = yield* service.subscribeList().pipe(
        Stream.map(({ tasks }) => tasks.find((candidate) => candidate.id === task.id)),
        Stream.filter((current) => current?.lastRunStatus === "failed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.succeed(ended, undefined);
      const recorded = Option.getOrUndefined(yield* Fiber.join(failed));
      assert.equal(recorded?.lastRunError, outcome.error);
      assert.equal(recorded?.runCount, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a bound run follows its thread when promotion moves it mid-send", () =>
  Effect.gen(function* () {
    const scratch = ProjectId.make("project:scratch");
    const promoted = ProjectId.make("project:promoted");
    const sends = yield* Ref.make<Array<{ projectId: ProjectId; commandId: string }>>([]);
    // Saving reads it first. Then the rebind lands, and the promotion commits between the shell
    // read and the retry.
    const shellProjects = yield* Ref.make([promoted, scratch, promoted]);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) =>
              Ref.updateAndGet(sends, (all) => [
                ...all,
                { projectId: input.projectId, commandId: input.commandId },
              ]).pipe(
                Effect.flatMap((all) =>
                  all.length < 3
                    ? Effect.fail(
                        new ThreadManagementService.ThreadManagementThreadNotFoundError({
                          projectId: input.projectId,
                          threadId: input.threadId,
                        }),
                      )
                    : Effect.succeed({} as never),
                ),
              ),
            getThreadShell: () =>
              Ref.modify(shellProjects, ([next, ...rest]) => [threadShell(next ?? promoted), rest]),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:promoted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:promoted-during-run"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: promoted,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      const result = yield* service.runNow({ id: task.id });

      assert.equal(result.threadId, threadId);
      const attempts = yield* Ref.get(sends);
      assert.deepEqual(
        attempts.map((attempt) => attempt.projectId),
        [promoted, scratch, promoted],
      );
      assert.equal(new Set(attempts.map((attempt) => attempt.commandId)).size, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a fresh-session task launches one thread, then starts each later run fresh in it", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const sends = yield* Ref.make<Array<{ threadId: ThreadId; freshContext?: boolean }>>([]);
    const launched = ThreadId.make("thread:fresh-session-task");
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: launched, resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed({ deletedAt: null } as never),
            sendToThread: (input) =>
              Ref.update(sends, (all) => [
                ...all,
                {
                  threadId: input.threadId,
                  ...(input.freshContext === undefined ? {} : { freshContext: input.freshContext }),
                },
              ]).pipe(Effect.as({} as never)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = {
        id: ScheduledTaskId.make("task:fresh-session"),
        title: "Triage",
        prompt: "Triage new issues",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      yield* service.upsert({ ...input, threadMode: "fresh_session" });

      assert.equal((yield* service.runNow({ id: input.id })).threadId, launched);
      // A form opened before the first run saves no thread; the binding stays.
      const { task } = yield* service.upsert({
        ...input,
        threadId: null,
        threadMode: "fresh_session",
      });
      assert.equal(task.threadId, launched);
      assert.equal(task.threadMode, "fresh_session");
      // A client that predates thread modes sends neither; both stay.
      const legacy = yield* service.upsert({ ...input, threadId: null });
      assert.equal(legacy.task.threadId, launched);
      assert.equal(legacy.task.threadMode, "fresh_session");
      yield* service.runNow({ id: input.id });

      assert.equal(yield* Ref.get(launches), 1);
      assert.deepEqual(yield* Ref.get(sends), [{ threadId: launched, freshContext: true }]);
      // Its thread stays in the old project, so moving the task leaves it for a new one.
      const moved = yield* service.upsert({
        ...input,
        projectId: ProjectId.make("project:moved"),
        threadId: launched,
      });
      assert.equal(moved.task.threadId, null);
      assert.equal(moved.task.threadMode, "fresh_session");
      const unbound = yield* service.upsert({ ...input, threadMode: "new_thread" });
      assert.equal(unbound.task.threadId, null);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a first run whose thread was deleted before it bound removes the task", () =>
  Effect.gen(function* () {
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread:deleted"),
                resumed: false,
              } as never),
          }),
          // Deleted before the binding landed, so its cleanup found no task to remove.
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ deletedAt: DateTime.makeUnsafe("2026-11-03T00:00:00Z") } as never),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:thread-deleted-mid-launch"),
        title: "Triage",
        prompt: "Triage new issues",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadMode: "continue",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.runNow({ id: task.id });
      assert.deepEqual((yield* service.list()).tasks, []);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["trash", "tombstone"] as const)(
  "keeps a task bound to a deleted thread in trash and drops one whose deletion is a tombstone",
  (scenario) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:test");
      const threadId = ThreadId.make(`thread:${scenario}`);
      const taskId = ScheduledTaskId.make(`task:${scenario}`);
      const layer = ScheduledTaskService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: () => Effect.succeed({ threadId, resumed: false } as never),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed(threadShell(projectId, { deletedAt: "2026-11-03T00:00:00Z" })),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: () => Effect.succeed(false),
            }),
            NodeCrypto.layer,
            Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${threadId}, ${projectId}, ${"trash"}, ${"codex"}, ${"full-access"}, ${"default"},
            ${"2026-11-03T00:00:00.000Z"}, ${"2026-11-03T00:00:00.000Z"}, ${"{}"}
          )
        `;
        if (scenario === "trash") {
          yield* sql`
            INSERT INTO orchestration_v2_projection_thread_trash (
              thread_id, project_id, deleted_at, purge_due_at, cascade_root_id
            ) VALUES (
              ${threadId}, ${projectId}, ${"2026-11-03T00:00:00.000Z"}, ${1}, ${threadId}
            )
          `;
        }
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert({
          id: taskId,
          title: "Triage",
          prompt: "Triage new issues",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId,
          threadMode: "continue",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        yield* service.runNow({ id: task.id });

        const [bound] = yield* sql<{ readonly thread_id: string | null }>`
          SELECT thread_id FROM scheduled_tasks WHERE task_id = ${task.id}
        `;
        const [pending] = yield* sql<{ readonly task_id: string }>`
          SELECT task_id FROM scheduled_task_pending_deletes WHERE task_id = ${task.id}
        `;
        if (scenario === "trash") {
          assert.equal(bound?.thread_id, threadId);
          assert.isUndefined(pending);
        } else {
          assert.isUndefined(bound);
          assert.isUndefined(pending);
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("fails a due run for a deleted thread in trash and advances its next run", () =>
  Effect.gen(function* () {
    const now = "2026-11-03T00:00:00.000Z";
    const projectId = ProjectId.make("project:test");
    const threadId = ThreadId.make("thread:due-trash");
    const taskId = ScheduledTaskId.make("task:due-trash");
    const failure = new ThreadManagementService.ThreadManagementThreadNotFoundError({
      projectId,
      threadId,
    });
    const failures = yield* Ref.make<ReadonlyArray<string>>([]);
    const runDueWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(threadShell(projectId, { deletedAt: now })),
            getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
            sendToThread: () =>
              Ref.update(failures, (all) => [...all, failure._tag]).pipe(
                Effect.andThen(Effect.fail(failure)),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.mock(Scheduler.Scheduler)({
            register: (name, work) =>
              name !== "scheduled-tasks"
                ? Effect.void
                : Effect.context<Effect.Services<typeof work>>().pipe(
                    Effect.flatMap((context) =>
                      Ref.set(runDueWork, work.pipe(Effect.provideContext(context), Effect.ignore)),
                    ),
                  ),
          }),
        ),
      ),
    );
    yield* TestClock.setTime(Date.parse(now));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${threadId}, ${projectId}, ${"trash"}, ${"codex"}, ${"full-access"}, ${"default"},
            ${now}, ${now}, ${"{}"}
          )
        `;
      yield* sql`
          INSERT INTO orchestration_v2_projection_thread_trash (
            thread_id, project_id, deleted_at, purge_due_at, cascade_root_id
          ) VALUES (${threadId}, ${projectId}, ${now}, ${1}, ${threadId})
        `;
      const { task } = yield* service.upsert({
        id: taskId,
        title: "Triage",
        prompt: "Triage new issues",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadMode: "continue",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* sql`
          UPDATE scheduled_tasks SET thread_id = ${threadId} WHERE task_id = ${task.id}
        `;
      yield* sql`
          UPDATE scheduled_tasks SET next_run_at = ${now} WHERE task_id = ${task.id}
        `;
      yield* TestClock.adjust("1 millis");
      yield* Ref.get(runDueWork).pipe(Effect.flatten);

      const [row] = yield* sql<{
        readonly last_run_status: string;
        readonly next_run_at: string | null;
        readonly run_count: number;
      }>`
          SELECT last_run_status, next_run_at, run_count FROM scheduled_tasks
          WHERE task_id = ${task.id}
        `;
      assert.equal(row?.last_run_status, "failed");
      assert.equal(row?.run_count, 1);
      assert.deepEqual(yield* Ref.get(failures), ["ThreadManagementThreadNotFoundError"]);
      assert.equal((yield* service.list()).tasks[0]?.threadId, threadId);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["recreated under the same id", "moved to another project"] as const)(
  "a first run never binds its thread to a task %s",
  (change) =>
    Effect.gen(function* () {
      const launching = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const layer = ScheduledTaskService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: () =>
                Deferred.succeed(launching, undefined).pipe(
                  Effect.andThen(Deferred.await(proceed)),
                  Effect.as({
                    threadId: ThreadId.make("thread:old-generation"),
                    resumed: false,
                  } as never),
                ),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: () => Effect.succeed(false),
            }),
            NodeCrypto.layer,
            Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const input = {
          id: ScheduledTaskId.make("task:recreated-mid-launch"),
          title: "Triage",
          prompt: "Triage new issues",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          threadMode: "fresh_session",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        } as const;
        yield* service.upsert(input);
        const run = yield* Effect.forkChild(service.runNow({ id: input.id }));
        yield* Deferred.await(launching);
        if (change === "recreated under the same id") {
          yield* service.delete({ id: input.id });
          yield* TestClock.adjust("1 second");
          yield* service.upsert(input);
        } else {
          yield* service.upsert({ ...input, projectId: ProjectId.make("project:moved") });
        }
        yield* Deferred.succeed(proceed, undefined);
        yield* Fiber.await(run);

        const replacement = (yield* service.list()).tasks.find((task) => task.id === input.id);
        assert.equal(replacement?.threadId, null);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("checks a task's destination thread only when the destination changes", () =>
  Effect.gen(function* () {
    const project = ProjectId.make("project:test");
    const otherProject = ProjectId.make("project:other");
    const destination = ThreadId.make("thread:destination");
    const archivedAt = "2026-11-05T00:00:00.000Z";
    const shells = yield* Ref.make<ReadonlyMap<ThreadId, never>>(
      new Map([
        [destination, threadShell(project)],
        [ThreadId.make("thread:archived"), threadShell(project, { archivedAt })],
        [ThreadId.make("thread:deleted"), threadShell(project, { deletedAt: archivedAt })],
        [ThreadId.make("thread:other-project"), threadShell(otherProject)],
      ]),
    );
    const consumed = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Ref.get(shells).pipe(Effect.map((all) => all.get(threadId) ?? null)),
          }),
          Layer.mock(SecretRequests.SecretRequests)({
            consume: () => Ref.update(consumed, (count) => count + 1).pipe(Effect.as("secret")),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const id = ScheduledTaskId.make("task:destination");
      const save = (
        threadId: ThreadId,
        schedule: ScheduledTaskUpsertInput["schedule"] = { type: "interval", everyMs: 60_000 },
      ) =>
        service.upsert({
          id,
          title: "Follow up",
          prompt: "Check progress",
          enabled: true,
          schedule,
          projectId: project,
          threadId,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });

      for (const [threadId, message] of [
        ["thread:missing", "That thread no longer exists."],
        ["thread:deleted", "That thread no longer exists."],
        ["thread:archived", "That thread is archived. Unarchive it or pick another destination."],
        ["thread:other-project", "That thread belongs to a different project."],
      ] as const) {
        const refused = yield* save(ThreadId.make(threadId)).pipe(Effect.flip);
        assert.equal(refused.message, message);
      }
      assert.lengthOf((yield* service.list()).tasks, 0);

      // A rejected save must not burn a one-shot secret.
      yield* save(ThreadId.make("thread:missing"), {
        type: "webhook",
        signature: {
          header: "x-signature",
          encoding: "hex",
          prefix: "",
          secretRef: SecretRef.make("secret-ref:00000000000000000000000000000001"),
        },
      }).pipe(Effect.flip);
      assert.equal(yield* Ref.get(consumed), 0);

      yield* save(destination);
      // A task whose thread was archived later stays editable.
      yield* Ref.update(shells, (all) =>
        new Map(all).set(destination, threadShell(project, { archivedAt })),
      );
      assert.equal((yield* save(destination)).task.threadId, destination);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a run interrupted right after it reserves the task does not block the next run", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:interrupted-reservation"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      // The reservation is the first Set.add of the task id; interrupt the run right there.
      const add = Set.prototype.add;
      let interrupted = false;
      const first = yield* Effect.gen(function* () {
        using _reserve = vi.spyOn(Set.prototype, "add").mockImplementation(function (
          this: Set<unknown>,
          value: unknown,
        ) {
          const result = add.call(this, value);
          if (value === task.id && !interrupted) {
            interrupted = true;
            Fiber.getCurrent()?.interruptUnsafe();
          }
          return result;
        });
        return yield* service
          .runNow({ id: task.id })
          .pipe(Effect.forkChild, Effect.flatMap(Fiber.await));
      });
      assert.isTrue(interrupted);
      assert.isTrue(Exit.hasInterrupts(first));

      const second = yield* service.runNow({ id: task.id });
      assert.equal(second.threadId, ThreadId.make("thread:launched"));
      assert.equal(yield* Ref.get(launches), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const pendingDeleteLayerDependencies = () =>
  Layer.mergeAll(
    NodeCrypto.layer,
    Scheduler.layer,
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
  );

const pendingDeleteInput = {
  title: "每夜盘点",
  prompt: "更新昨天的记录。",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project:test"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

it.effect("marks a deleted task for undo, restores it whole, then purges it for real", () =>
  Effect.gen(function* () {
    const layer = ScheduledTaskService.layer.pipe(Layer.provide(pendingDeleteLayerDependencies()));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const { task } = yield* service.upsert(pendingDeleteInput);

      yield* service.delete({ id: task.id });
      const mark = yield* sql<{ due_at: number }>`
        SELECT due_at FROM scheduled_task_pending_deletes WHERE task_id = ${task.id}
      `;
      assert.lengthOf(mark, 1);

      // Hidden for every reader, and its mark must not hide a sibling task.
      const { task: sibling } = yield* service.upsert({
        ...pendingDeleteInput,
        title: "白班巡检",
      });
      assert.deepEqual(
        (yield* service.list()).tasks.map((listed) => listed.id),
        [sibling.id],
      );
      assert.equal(
        (yield* service.runNow({ id: task.id }).pipe(Effect.flip)).message,
        "Schedule task not found.",
      );
      assert.equal(
        (yield* service.setEnabled({ id: task.id, enabled: false }).pipe(Effect.flip)).message,
        "Schedule task not found.",
      );

      const restored = yield* service.undoDelete({ id: task.id });
      assert.deepEqual(restored.task, task);
      assert.deepEqual(
        (yield* service.list()).tasks.map((listed) => listed.id).toSorted(),
        [sibling.id, task.id].toSorted(),
      );

      yield* service.delete({ id: task.id });
      yield* TestClock.adjust(
        `${ScheduledTaskService.SCHEDULED_TASK_PENDING_DELETE_MS + 1_000} millis`,
      );
      const [row] = yield* sql`SELECT task_id FROM scheduled_tasks WHERE task_id = ${task.id}`;
      assert.isUndefined(row);
      const [markGone] = yield* sql`
        SELECT task_id FROM scheduled_task_pending_deletes WHERE task_id = ${task.id}
      `;
      assert.isUndefined(markGone);
      assert.deepEqual(
        (yield* service.list()).tasks.map((listed) => listed.id),
        [sibling.id],
      );
      assert.equal(
        (yield* service.undoDelete({ id: task.id }).pipe(Effect.flip)).message,
        "无法撤销：这个定时任务已经删除",
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a task deleted across its slot does not run, then catches up under the missed-run rule",
  () =>
    Effect.gen(function* () {
      const now = "2026-09-09T12:00:00.000Z";
      const sql = yield* SqlClient.SqlClient;
      yield* insertRow(
        sql,
        {
          id: "task:interval-overdue",
          next: "2026-09-09T11:59:00.000Z",
          enabled: 1,
          status: "never",
        },
        now,
      );
      yield* insertRow(
        sql,
        {
          id: "task:fixed-overdue",
          next: "2026-09-09T10:00:00.000Z",
          enabled: 1,
          status: "never",
          scheduleJson: '{"type":"fixed_time","timeOfDay":"10:00"}',
        },
        now,
      );

      const launches = yield* Ref.make(0);
      const layer = ScheduledTaskService.layer.pipe(
        Layer.provide(
          Layer.merge(
            pendingDeleteLayerDependencies(),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: () =>
                Ref.update(launches, (count) => count + 1).pipe(
                  Effect.as({
                    threadId: ThreadId.make("thread:after-undo"),
                    resumed: false,
                  } as never),
                ),
            }),
          ),
        ),
      );
      yield* TestClock.setTime(Date.parse(now));
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* service.delete({ id: ScheduledTaskId.make("task:interval-overdue") });
        yield* service.delete({ id: ScheduledTaskId.make("task:fixed-overdue") });
        // Both slots are due while the tasks are marked for deletion.
        yield* TestClock.adjust("10 seconds");
        assert.equal(yield* Ref.get(launches), 0);

        yield* service.undoDelete({ id: ScheduledTaskId.make("task:interval-overdue") });
        // Interval runs have no grace window, so the overdue slot runs at once.
        yield* TestClock.adjust("10 seconds");
        assert.equal(yield* Ref.get(launches), 1);

        yield* service.undoDelete({ id: ScheduledTaskId.make("task:fixed-overdue") });
        // A fixed-time slot over ten minutes late is rescheduled, not run.
        yield* TestClock.adjust("10 seconds");
        assert.equal(yield* Ref.get(launches), 1);
        const [fixed] = yield* sql<{ next_run_at: string | null; last_run_status: string }>`
          SELECT next_run_at, last_run_status FROM scheduled_tasks
          WHERE task_id = 'task:fixed-overdue'
        `;
        const expectedNext = nextScheduledRunAt(
          { type: "fixed_time", timeOfDay: "10:00" },
          DateTime.makeZonedUnsafe(
            { year: 2026, month: 9, day: 9, hour: 12, minute: 0, second: 30, millisecond: 0 },
            { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
          ),
        );
        assert.equal(
          fixed?.next_run_at,
          expectedNext === null ? null : DateTime.formatIso(DateTime.toUtc(expectedNext)),
        );
        assert.equal(fixed?.last_run_status, "failed");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a restart inside the undo window still ends with the task purged", () =>
  Effect.gen(function* () {
    const layerDependencies = pendingDeleteLayerDependencies();
    const withServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        effect.pipe(
          Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))),
        ),
      );

    const taskId = yield* withServer(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(pendingDeleteInput);
        yield* service.delete({ id: task.id });
        return task.id;
      }),
    );

    yield* withServer(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* TestClock.adjust(
          `${ScheduledTaskService.SCHEDULED_TASK_PENDING_DELETE_MS + 1_000} millis`,
        );
        const [row] = yield* sql`
          SELECT task_id FROM scheduled_tasks WHERE task_id = ${taskId}
        `;
        assert.isUndefined(row);
        const [mark] = yield* sql`
          SELECT task_id FROM scheduled_task_pending_deletes WHERE task_id = ${taskId}
        `;
        assert.isUndefined(mark);
      }),
    );

    const failure = yield* withServer(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        return yield* service.undoDelete({ id: taskId }).pipe(Effect.flip);
      }),
    );
    assert.equal(failure.message, "无法撤销：这个定时任务已经删除");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const insertBot = (
  sql: SqlClient.SqlClient,
  input: { readonly id: string; readonly threadId: string; readonly status?: string },
) => sql`
  INSERT INTO orchestration_v2_projection_bots (
    bot_id, status, current_thread_id, updated_at, payload_json
  ) VALUES (
    ${input.id}, ${input.status ?? "active"}, ${input.threadId},
    '2026-11-03T00:00:00.000Z',
    ${JSON.stringify({
      id: input.id,
      name: input.id,
      status: input.status ?? "active",
      currentThreadId: input.threadId,
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    })}
  )
`;

const botTaskInput = (id: string) =>
  ({
    id: ScheduledTaskId.make(id),
    title: "Wake the bot",
    prompt: "Check in",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("project:test"),
    botId: BotId.make("bot:watcher"),
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
  }) as const;

// The mock scheduler captures the registered due work instead of driving it on a timer.
const botHarness = (
  threadManagement: Partial<ThreadManagementService.ThreadManagementService["Service"]>,
) => {
  const runDueWork = Ref.makeUnsafe<Effect.Effect<void>>(Effect.void);
  const layer = ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)(threadManagement),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        Layer.mock(Scheduler.Scheduler)({
          register: (name, work) =>
            name !== "scheduled-tasks"
              ? Effect.void
              : Effect.context<Effect.Services<typeof work>>().pipe(
                  Effect.flatMap((context) =>
                    Ref.set(runDueWork, work.pipe(Effect.provideContext(context), Effect.ignore)),
                  ),
                ),
        }),
      ),
    ),
  );
  return { runDueWork, layer };
};

it.effect("a bot-bound task posts to the bot's current thread and follows it across threads", () =>
  Effect.gen(function* () {
    const sends = yield* Ref.make<ReadonlyArray<{ threadId: ThreadId; projectId: ProjectId }>>([]);
    const projectId = ProjectId.make("project:test");
    const harness = botHarness({
      getThreadShell: () => Effect.succeed(threadShell(projectId)),
      sendToThread: (input) =>
        Ref.update(sends, (all) => [
          ...all,
          { threadId: input.threadId, projectId: input.projectId },
        ]).pipe(Effect.as({} as never)),
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(botTaskInput("task:bot-follows"));
      assert.equal(task.threadId, null);

      const first = yield* service.runNow({ id: task.id });
      assert.equal(first.threadId, ThreadId.make("thread:alpha"));
      assert.deepEqual(yield* Ref.get(sends), [
        { threadId: ThreadId.make("thread:alpha"), projectId },
      ]);
      const [recorded] = yield* sql<{ thread_id: string | null }>`
        SELECT thread_id FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.equal(recorded?.thread_id, "thread:alpha");

      // The bot moved; the recorded thread stays behind and must not steer the next run.
      yield* sql`UPDATE orchestration_v2_projection_bots SET current_thread_id = 'thread:beta'
        WHERE bot_id = 'bot:watcher'`;
      const second = yield* service.runNow({ id: task.id });
      assert.equal(second.threadId, ThreadId.make("thread:beta"));
      assert.deepEqual(yield* Ref.get(sends), [
        { threadId: ThreadId.make("thread:alpha"), projectId },
        { threadId: ThreadId.make("thread:beta"), projectId },
      ]);
      const [moved] = yield* sql<{ thread_id: string | null }>`
        SELECT thread_id FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.equal(moved?.thread_id, "thread:beta");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("skips a due run while its bot is paused, records it, and runs again after resume", () =>
  Effect.gen(function* () {
    const now = "2026-11-03T00:00:00.000Z";
    const sends = yield* Ref.make(0);
    const harness = botHarness({
      getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
      getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
      sendToThread: () => Ref.update(sends, (n) => n + 1).pipe(Effect.as({} as never)),
    });
    yield* TestClock.setTime(Date.parse(now));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha", status: "paused" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(botTaskInput("task:bot-paused"));
      yield* sql`UPDATE scheduled_tasks SET next_run_at = ${now} WHERE task_id = ${task.id}`;
      yield* TestClock.adjust("1 millis");
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);

      assert.equal(yield* Ref.get(sends), 0);
      const [skipped] = yield* sql<{
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`
        SELECT last_run_status, last_run_error, next_run_at, run_count
        FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.equal(skipped?.last_run_status, "failed");
      assert.equal(skipped?.last_run_error, "Bot bot:watcher is paused.");
      assert.equal(skipped?.run_count, 0);
      assert.isNotNull(skipped?.next_run_at);

      // The bot wakes up; the next due time dispatches normally.
      yield* sql`UPDATE orchestration_v2_projection_bots SET status = 'active'
        WHERE bot_id = 'bot:watcher'`;
      yield* TestClock.setTime(Date.parse(skipped!.next_run_at!) + 1_000);
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);
      assert.equal(yield* Ref.get(sends), 1);
      const [ran] = yield* sql<{ last_run_status: string; run_count: number }>`
        SELECT last_run_status, run_count FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.equal(ran?.last_run_status, "succeeded");
      assert.equal(ran?.run_count, 1);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["retired", "missing"] as const)(
  "fails a due run for a %s bot without dispatching, like a deleted thread",
  (scenario) =>
    Effect.gen(function* () {
      const now = "2026-11-03T00:00:00.000Z";
      const sends = yield* Ref.make(0);
      const harness = botHarness({
        getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
        sendToThread: () => Ref.update(sends, (n) => n + 1).pipe(Effect.as({} as never)),
      });
      yield* TestClock.setTime(Date.parse(now));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Binding validation would refuse a retired bot, so retire it only after the save.
        yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(botTaskInput(`task:bot-${scenario}`));
        if (scenario === "retired") {
          yield* sql`UPDATE orchestration_v2_projection_bots SET status = 'retired'
            WHERE bot_id = 'bot:watcher'`;
        } else {
          yield* sql`DELETE FROM orchestration_v2_projection_bots WHERE bot_id = 'bot:watcher'`;
        }
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${now} WHERE task_id = ${task.id}`;
        yield* TestClock.adjust("1 millis");
        yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);

        assert.equal(yield* Ref.get(sends), 0);
        const [row] = yield* sql<{
          last_run_status: string;
          last_run_error: string | null;
          next_run_at: string | null;
          run_count: number;
        }>`
          SELECT last_run_status, last_run_error, next_run_at, run_count
          FROM scheduled_tasks WHERE task_id = ${task.id}
        `;
        assert.equal(row?.last_run_status, "failed");
        assert.equal(
          row?.last_run_error,
          scenario === "retired"
            ? "Bot bot:watcher is retired."
            : "Bot bot:watcher no longer exists.",
        );
        assert.equal(row?.run_count, 1);
        assert.isNotNull(row?.next_run_at);
        // The task survives repeated failures, the same end state a deleted-thread task reaches.
        assert.equal((yield* service.list()).tasks.length, 1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("does not stack a second wake while the bot's earlier wake is still queued", () =>
  Effect.gen(function* () {
    const now = "2026-11-03T00:00:00.000Z";
    const sends = yield* Ref.make<ReadonlyArray<string>>([]);
    const harness = botHarness({
      getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
      getThreadRecords: () =>
        Ref.get(sends).pipe(
          Effect.map((sent) =>
            sent.length === 0
              ? ({ runs: [], messages: [] } as never)
              : ({
                  runs: [{ id: "run:queued", status: "queued", userMessageId: "message:queued" }],
                  messages: [
                    {
                      id: "message:queued",
                      // The queued wake belongs to the other task on the same bot.
                      scheduledTaskId: "task:bot-other",
                    },
                  ],
                } as never),
          ),
        ),
      sendToThread: (input) =>
        Ref.update(sends, (all) => [...all, input.threadId]).pipe(Effect.as({} as never)),
    });
    yield* TestClock.setTime(Date.parse(now));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({
        ...botTaskInput("task:bot-other"),
      });
      const { task } = yield* service.upsert(botTaskInput("task:bot-single-flight"));

      // The first dispatch queues on the busy thread, so a later due time sees it there.
      yield* sql`UPDATE scheduled_tasks SET next_run_at = ${now} WHERE task_id = ${task.id}`;
      yield* TestClock.adjust("1 millis");
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);
      assert.equal(yield* Ref.get(sends).pipe(Effect.map((all) => all.length)), 1);

      yield* sql<{ next_run_at: string | null }>`
        SELECT next_run_at FROM scheduled_tasks WHERE task_id = ${task.id}
      `.pipe(
        Effect.flatMap((rows) => {
          const next = rows[0]?.next_run_at;
          if (next === null || next === undefined) return Effect.void;
          return TestClock.setTime(Date.parse(next) + 1_000);
        }),
      );
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);

      // The queued wake is still sitting on the bot's thread, so the new due time does not stack.
      assert.equal(yield* Ref.get(sends).pipe(Effect.map((all) => all.length)), 1);
      const [row] = yield* sql<{
        last_run_status: string;
        next_run_at: string | null;
      }>`
        SELECT last_run_status, next_run_at FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.equal(row?.last_run_status, "succeeded");
      assert.isNotNull(row?.next_run_at);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("does not fire the next due occurrence while the previous wake is still queued", () =>
  Effect.gen(function* () {
    const now = "2026-11-03T00:00:00.000Z";
    const sends = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const harness = botHarness({
      getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
      getThreadRecords: () =>
        Ref.get(sends).pipe(
          Effect.map((sent) =>
            sent.length === 0
              ? ({ runs: [], messages: [] } as never)
              : ({
                  runs: [{ id: "run:queued", status: "queued", userMessageId: "message:queued" }],
                  messages: [
                    {
                      id: "message:queued",
                      // The earlier wake is still queued and belongs to this same task.
                      scheduledTaskId: "task:bot-fired-twice",
                    },
                  ],
                } as never),
          ),
        ),
      sendToThread: (input) =>
        Ref.update(sends, (all) => [...all, input.threadId]).pipe(Effect.as({} as never)),
    });
    yield* TestClock.setTime(Date.parse(now));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(botTaskInput("task:bot-fired-twice"));

      // The first poll takes the due occurrence; when the next one comes due the
      // wake is still queued on the busy thread, so it must not fire again.
      yield* sql`UPDATE scheduled_tasks SET next_run_at = ${now} WHERE task_id = ${task.id}`;
      yield* TestClock.adjust("1 millis");
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);

      yield* sql<{ next_run_at: string | null }>`
        SELECT next_run_at FROM scheduled_tasks WHERE task_id = ${task.id}
      `.pipe(
        Effect.flatMap((rows) => {
          const next = rows[0]?.next_run_at;
          if (next === null || next === undefined) return Effect.void;
          return TestClock.setTime(Date.parse(next) + 1_000);
        }),
      );
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);

      assert.equal(yield* Ref.get(sends).pipe(Effect.map((all) => all.length)), 1);
      const [row] = yield* sql<{ run_count: number }>`
        SELECT run_count FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.equal(row?.run_count, 1);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("does not stack a second wake when the bot's other task is still running", () =>
  Effect.gen(function* () {
    const now = "2026-11-03T00:00:00.000Z";
    const sends = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const harness = botHarness({
      getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
      getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
      sendToThread: (input) =>
        Ref.update(sends, (all) => [...all, input.threadId]).pipe(Effect.as({} as never)),
    });
    yield* TestClock.setTime(Date.parse(now));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task: running } = yield* service.upsert(botTaskInput("task:bot-still-running"));
      const { task } = yield* service.upsert(botTaskInput("task:bot-next-up"));
      yield* sql`
        UPDATE scheduled_tasks SET last_run_status = 'running'
        WHERE task_id = ${running.id}
      `;
      yield* sql`UPDATE scheduled_tasks SET next_run_at = ${now} WHERE task_id = ${task.id}`;
      yield* TestClock.adjust("1 millis");
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);

      // The other task's run still owns the bot, so this due time waits instead of stacking.
      assert.equal(yield* Ref.get(sends).pipe(Effect.map((all) => all.length)), 0);
      const [row] = yield* sql<{ last_run_status: string; next_run_at: string | null }>`
        SELECT last_run_status, next_run_at FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.equal(row?.last_run_status, "never");
      assert.notEqual(row?.next_run_at, now);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps a due once task waiting while its bot is paused and fires after resume", () =>
  Effect.gen(function* () {
    const now = "2026-11-03T00:00:00.000Z";
    const sends = yield* Ref.make(0);
    const harness = botHarness({
      getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
      getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
      sendToThread: () => Ref.update(sends, (n) => n + 1).pipe(Effect.as({} as never)),
    });
    yield* TestClock.setTime(Date.parse(now));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha", status: "paused" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        ...botTaskInput("task:bot-once-paused"),
        schedule: { type: "once", runAt: "2026-11-03T00:01:00.000Z" },
      });
      yield* sql`UPDATE scheduled_tasks SET next_run_at = ${now} WHERE task_id = ${task.id}`;
      yield* TestClock.adjust("1 millis");
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);

      // No skip is recorded and the time stays: a once task has no later slot to move to.
      assert.equal(yield* Ref.get(sends), 0);
      const [waiting] = yield* sql<{ next_run_at: string | null; run_count: number }>`
        SELECT next_run_at, run_count FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.equal(waiting?.next_run_at, now);
      assert.equal(waiting?.run_count, 0);

      yield* sql`UPDATE orchestration_v2_projection_bots SET status = 'active'
        WHERE bot_id = 'bot:watcher'`;
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);
      assert.equal(yield* Ref.get(sends), 1);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps a due once task waiting while the bot's other task is still running", () =>
  Effect.gen(function* () {
    const now = "2026-11-03T00:00:00.000Z";
    const sends = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const harness = botHarness({
      getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
      getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
      sendToThread: (input) =>
        Ref.update(sends, (all) => [...all, input.threadId]).pipe(Effect.as({} as never)),
    });
    yield* TestClock.setTime(Date.parse(now));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task: running } = yield* service.upsert(botTaskInput("task:bot-still-running-once"));
      const { task } = yield* service.upsert({
        ...botTaskInput("task:bot-once-waits"),
        schedule: { type: "once", runAt: "2026-11-03T00:01:00.000Z" },
      });
      yield* sql`
        UPDATE scheduled_tasks SET last_run_status = 'running'
        WHERE task_id = ${running.id}
      `;
      yield* sql`UPDATE scheduled_tasks SET next_run_at = ${now} WHERE task_id = ${task.id}`;
      yield* TestClock.adjust("1 millis");
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);

      // A once task cannot take a later slot: its time stays so it fires when the bot frees.
      assert.equal(yield* Ref.get(sends).pipe(Effect.map((all) => all.length)), 0);
      const [waiting] = yield* sql<{ next_run_at: string | null; last_run_status: string }>`
        SELECT next_run_at, last_run_status FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.isNotNull(waiting?.next_run_at);
      assert.equal(waiting?.last_run_status, "never");

      yield* sql`
        UPDATE scheduled_tasks SET last_run_status = 'succeeded'
        WHERE task_id = ${running.id}
      `;
      yield* Ref.get(harness.runDueWork).pipe(Effect.flatten);
      assert.equal(yield* Ref.get(sends).pipe(Effect.map((all) => all.length)), 1);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("unbinding a bot drops the recorded thread so the task starts clean", () =>
  Effect.gen(function* () {
    const harness = botHarness({
      getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
      sendToThread: () => Effect.succeed({} as never),
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        ...botTaskInput("task:bot-unbind"),
        threadMode: "fresh_session",
      });
      yield* service.runNow({ id: task.id });
      const [recorded] = yield* sql<{ thread_id: string | null }>`
        SELECT thread_id FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.equal(recorded?.thread_id, "thread:alpha");

      const { task: unbound } = yield* service.upsert({
        ...botTaskInput("task:bot-unbind"),
        botId: null,
      });
      assert.isNull(unbound.threadId);
      const [cleared] = yield* sql<{ thread_id: string | null; bot_id: string | null }>`
        SELECT thread_id, bot_id FROM scheduled_tasks WHERE task_id = ${task.id}
      `;
      assert.isNull(cleared?.bot_id);
      assert.isNull(cleared?.thread_id);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps a bot-bound task when the thread its last run went to is deleted", () =>
  Effect.gen(function* () {
    const harness = botHarness({});
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(botTaskInput("task:bot-survives-cleanup"));
      // The run record points at the bot's old home; deleting that thread is not the task's end.
      yield* sql`UPDATE scheduled_tasks SET thread_id = 'thread:alpha' WHERE task_id = ${task.id}`;
      yield* service.deleteForThread(ThreadId.make("thread:alpha"));
      assert.deepEqual(
        (yield* service.list()).tasks.map((listed) => listed.id),
        [task.id],
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rejects a task that names both a bot and a thread, and one whose bot is gone", () =>
  Effect.gen(function* () {
    const harness = botHarness({});
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      yield* insertBot(sql, { id: "bot:retired", threadId: "thread:beta", status: "retired" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const both = yield* service
        .upsert({
          ...botTaskInput("task:bot-and-thread"),
          threadId: ThreadId.make("thread:alpha"),
        })
        .pipe(Effect.flip);
      assert.equal(both.message, "A task binds a bot or a thread, not both.");

      const retired = yield* service
        .upsert({ ...botTaskInput("task:bot-retired"), botId: BotId.make("bot:retired") })
        .pipe(Effect.flip);
      assert.equal(retired.message, "That bot is retired.");

      const missing = yield* service
        .upsert({ ...botTaskInput("task:bot-missing"), botId: BotId.make("bot:gone") })
        .pipe(Effect.flip);
      assert.equal(missing.message, "That bot no longer exists.");
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  {
    name: "a live target receives thread-bound tasks while bot-bound tasks stay put",
    targetShell: "live" as const,
    expectSurviving: ["task:rebind-thread", "task:rebind-bot"],
    expectOnTarget: ["task:rebind-thread"],
  },
  {
    name: "a target deleted past the trash cannot keep the work, so the moved tasks die with it",
    targetShell: "tombstone" as const,
    expectSurviving: ["task:rebind-bot"],
    expectOnTarget: [],
  },
])("$name", ({ targetShell, expectSurviving, expectOnTarget }) =>
  Effect.gen(function* () {
    const source = ThreadId.make("thread:rebind-source");
    const target = ThreadId.make("thread:rebind-target");
    const harness = botHarness({
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === target
            ? targetShell === "live"
              ? threadShell(ProjectId.make("project:test"))
              : threadShell(ProjectId.make("project:test"), { deletedAt: "2026-11-20T00:00:00Z" })
            : threadShell(ProjectId.make("project:test")),
        ),
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({
        id: ScheduledTaskId.make("task:rebind-thread"),
        title: "Thread bound",
        prompt: "Run",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId: source,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const { task: botTask } = yield* service.upsert(botTaskInput("task:rebind-bot"));
      // The rotation that enqueues the rebind seals the old thread, so the bot's last-run
      // record can point at it; the binding must still not move.
      yield* sql`UPDATE scheduled_tasks SET thread_id = ${source} WHERE task_id = ${botTask.id}`;
      yield* service.rebindThread({ sourceThreadId: source, targetThreadId: target });
      const surviving = (yield* service.list()).tasks;
      assert.deepEqual(surviving.map((listed) => listed.id).toSorted(), expectSurviving.toSorted());
      const rows = yield* sql<{ task_id: string; thread_id: string | null }>`
        SELECT task_id, thread_id FROM scheduled_tasks
      `;
      const onTarget = rows
        .filter((row) => row.thread_id === target)
        .map((row) => row.task_id)
        .toSorted();
      assert.deepEqual(onTarget, expectOnTarget.toSorted());
      assert.deepEqual(rows.find((row) => row.task_id === botTask.id)?.thread_id ?? null, source);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a replayed rebind moves only what still binds the source thread", () =>
  Effect.gen(function* () {
    const source = ThreadId.make("thread:rebind-again-source");
    const target = ThreadId.make("thread:rebind-again-target");
    const harness = botHarness({
      getThreadShell: () => Effect.succeed(threadShell(ProjectId.make("project:test"))),
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const firstInput = {
        title: "Thread bound",
        prompt: "Run",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      } as const;
      yield* service.upsert({
        ...firstInput,
        id: ScheduledTaskId.make("task:rebind-first"),
        threadId: source,
      });
      yield* service.upsert({
        ...firstInput,
        id: ScheduledTaskId.make("task:rebind-late"),
        threadId: ThreadId.make("thread:rebind-elsewhere"),
      });
      yield* service.rebindThread({ sourceThreadId: source, targetThreadId: target });
      // The rotation effect replays after the crash that followed its first execution: a task
      // written back onto the sealed thread in between must still move, the already-moved one
      // must not be copied twice, and a task bound elsewhere is not the rotation's to take.
      yield* sql`UPDATE scheduled_tasks SET thread_id = ${source} WHERE task_id = ${"task:rebind-late"}`;
      yield* service.rebindThread({ sourceThreadId: source, targetThreadId: target });
      const rows = yield* sql<{ task_id: string; thread_id: string | null }>`
        SELECT task_id, thread_id FROM scheduled_tasks
      `;
      assert.deepEqual(
        rows
          .filter((row) => row.thread_id === target)
          .map((row) => row.task_id)
          .toSorted(),
        ["task:rebind-first", "task:rebind-late"],
      );
      assert.lengthOf(
        rows.filter((row) => row.task_id === "task:rebind-first"),
        1,
      );
      assert.lengthOf(
        rows.filter((row) => row.thread_id === source),
        0,
      );
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a rebind that cannot read the target thread fails instead of deleting anything", () =>
  Effect.gen(function* () {
    const source = ThreadId.make("thread:rebind-failread-source");
    const target = ThreadId.make("thread:rebind-failread-target");
    const harness = botHarness({
      getThreadShell: (threadId) =>
        threadId === target
          ? Effect.fail(new Error("simulated shell read failure") as never)
          : Effect.succeed(threadShell(ProjectId.make("project:test"))),
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({
        id: ScheduledTaskId.make("task:rebind-failread"),
        title: "Thread bound",
        prompt: "Run",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId: source,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const failed = yield* service
        .rebindThread({ sourceThreadId: source, targetThreadId: target })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "ScheduledTaskError");
      // A read error is a retryable failure, never a deletion: the row binds the source still.
      const rows = yield* sql<{ task_id: string; thread_id: string | null }>`
        SELECT task_id, thread_id FROM scheduled_tasks
      `;
      assert.deepEqual(rows, [{ task_id: "task:rebind-failread", thread_id: source }]);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a rebind that cannot read the trash projection fails instead of deleting anything", () =>
  Effect.gen(function* () {
    const source = ThreadId.make("thread:rebind-failtrash-source");
    const target = ThreadId.make("thread:rebind-failtrash-target");
    const harness = botHarness({
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === target
            ? threadShell(ProjectId.make("project:test"), { deletedAt: "2026-11-20T00:00:00Z" })
            : threadShell(ProjectId.make("project:test")),
        ),
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({
        id: ScheduledTaskId.make("task:rebind-failtrash"),
        title: "Thread bound",
        prompt: "Run",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId: source,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      // The trash read hits a missing table: exactly the kind of storage error that must fail
      // the effect for a retry, not read as "not in the trash".
      yield* sql`ALTER TABLE orchestration_v2_projection_thread_trash RENAME TO thread_trash_aside`;
      const failed = yield* service
        .rebindThread({ sourceThreadId: source, targetThreadId: target })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "ScheduledTaskError");
      const rows = yield* sql<{ task_id: string; thread_id: string | null }>`
        SELECT task_id, thread_id FROM scheduled_tasks
      `;
      assert.deepEqual(rows, [{ task_id: "task:rebind-failtrash", thread_id: source }]);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a replayed rebind deletes tasks that already moved onto a deleted target", () =>
  Effect.gen(function* () {
    const source = ThreadId.make("thread:rebind-strand-source");
    const target = ThreadId.make("thread:rebind-strand-target");
    const targetShellState = Ref.makeUnsafe(threadShell(ProjectId.make("project:test")));
    const harness = botHarness({
      getThreadShell: (threadId) =>
        threadId === target
          ? Ref.get(targetShellState)
          : Effect.succeed(threadShell(ProjectId.make("project:test"))),
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertBot(sql, { id: "bot:watcher", threadId: "thread:alpha" });
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* service.upsert({
        id: ScheduledTaskId.make("task:rebind-stranded"),
        title: "Thread bound",
        prompt: "Run",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId: source,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      // The first execution moves the task; the process dies before the cleanup it owed the
      // target, which is permanently deleted in the meantime. The replayed execution moves
      // nothing, and the stranded row must still die with its thread.
      yield* service.rebindThread({ sourceThreadId: source, targetThreadId: target });
      yield* Ref.set(
        targetShellState,
        threadShell(ProjectId.make("project:test"), { deletedAt: "2026-11-20T00:00:00Z" }),
      );
      yield* service.rebindThread({ sourceThreadId: source, targetThreadId: target });
      const rows = yield* sql<{ task_id: string; thread_id: string | null }>`
        SELECT task_id, thread_id FROM scheduled_tasks
      `;
      assert.lengthOf(rows, 0);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
