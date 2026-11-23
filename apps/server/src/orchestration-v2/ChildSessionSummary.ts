import {
  Cause,
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  PubSub,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CHILD_SUMMARY_IDLE_MS,
  CHILD_SUMMARY_PAGE_SIZE,
  type ChildSummaryDetail,
  type ChildSummaryListItem,
  type ChildSummaryStreamEvent,
  ChildSummaryCursorError,
  ChildSummaryReadError,
  type CommandChildrenPage,
  EnvironmentId,
  type FleetSummaryRow,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import * as FleetSummary from "../ledger/FleetSummary.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { forkParked } from "../serverActivation.ts";
import {
  CHILD_SUMMARY_SILENCE_REASON,
  childSummaryCursor,
  deriveChildSummary,
  deriveRemoteChildSummary,
  emptyPushLane,
  flushPush,
  offerPush,
  parseChildSummaryCursor,
  toSummaryItem,
  type PushLane,
  type RemoteLinkState,
  type RemoteSummaryFacts,
  type SummaryFacts,
  type SummaryItem,
} from "./childSummaryDerive.ts";
import * as CommandAssist from "./CommandAssist.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

const ACTIVITY_EVENTS: Readonly<Record<string, true>> = {
  "thread.created": true,
  "thread.metadata-updated": true,
  "thread.pull-request-synced": true,
  "thread.pull-request-link-updated": true,
  "thread.deleted": true,
  "thread.archived": true,
  "run.created": true,
  "run.updated": true,
  "runtime-request.updated": true,
  "turn-item.updated": true,
  "subagent.updated": true,
};

interface SummaryRow {
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly revision: number;
  readonly phase: ChildSummaryListItem["phase"];
  readonly reason: string;
  readonly conclusion: ChildSummaryListItem["conclusion"];
  readonly needsYou: number;
  readonly activity: string;
  readonly goalSummary: string;
  readonly goal: string;
  readonly avoid: string;
  readonly filesJson: string;
  readonly latestCommand: string | null;
  readonly branch: string | null;
  readonly commitSha: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly environmentLabel: string | null;
  readonly title: string | null;
  readonly repo: string | null;
  readonly stale: number;
  readonly staleReason: string | null;
  readonly prNumber: number | null;
  readonly prState: string | null;
  readonly grandchildCount: number;
  readonly grandchildNote: string | null;
  readonly createdAtMs: number;
  readonly activityAtMs: number;
  readonly idleEligible: number;
  readonly updatedAt: string;
}

function storedRowToItem(row: SummaryRow): ChildSummaryListItem {
  return {
    threadId: row.threadId,
    parentThreadId: row.parentThreadId,
    revision: row.revision,
    phase: row.phase,
    reason: row.reason,
    conclusion: row.conclusion,
    needsYou: row.needsYou === 1,
    activity: row.activity,
    goalSummary: row.goalSummary,
    grandchildCount: row.grandchildCount,
    grandchildNote: row.grandchildNote,
    createdAtMs: row.createdAtMs,
    updatedAt: row.updatedAt,
    ...(row.environmentId === null ? {} : { environmentId: row.environmentId }),
    ...(row.environmentLabel === null ? {} : { environmentLabel: row.environmentLabel }),
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.repo === null ? {} : { repo: row.repo }),
    ...(row.branch === null ? {} : { branch: row.branch }),
    ...(row.commitSha === null ? {} : { commit: row.commitSha }),
    ...(row.stale === 1 ? { stale: true } : {}),
    ...(row.staleReason === null ? {} : { staleReason: row.staleReason }),
  };
}

function filesJsonOf(files: ChildSummaryDetail["files"]): string {
  return JSON.stringify(files);
}

function storedRowToDetail(row: SummaryRow): ChildSummaryDetail {
  let files: ChildSummaryDetail["files"] = [];
  try {
    const parsed: unknown = JSON.parse(row.filesJson);
    if (Array.isArray(parsed)) files = parsed as ChildSummaryDetail["files"];
  } catch {
    files = [];
  }
  return {
    ...storedRowToItem(row),
    goal: row.goal,
    avoid: row.avoid,
    files,
    latestCommand: row.latestCommand,
    branch: row.branch,
    commit: row.commitSha,
    prNumber: row.prNumber,
    outlook: null,
    handback: null,
  };
}

function assistFiles(
  detail: Omit<ChildSummaryDetail, "revision" | "updatedAt">,
): CommandAssist.CommandAssistFacts["files"] {
  return detail.files.map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
  }));
}

function isoOf(epochMillis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(epochMillis));
}

function sameContent(
  previous: SummaryRow,
  list: Omit<ChildSummaryListItem, "revision" | "updatedAt">,
  detail: Omit<ChildSummaryDetail, "revision" | "updatedAt">,
  prState: string | null,
): boolean {
  return (
    previous.phase === list.phase &&
    previous.reason === list.reason &&
    previous.conclusion === list.conclusion &&
    (previous.needsYou === 1) === list.needsYou &&
    previous.activity === list.activity &&
    previous.goalSummary === list.goalSummary &&
    previous.grandchildCount === list.grandchildCount &&
    previous.grandchildNote === list.grandchildNote &&
    previous.createdAtMs === list.createdAtMs &&
    previous.goal === detail.goal &&
    previous.avoid === detail.avoid &&
    previous.filesJson === filesJsonOf(detail.files) &&
    previous.latestCommand === detail.latestCommand &&
    previous.branch === detail.branch &&
    previous.commitSha === detail.commit &&
    previous.environmentId === (list.environmentId ?? null) &&
    previous.environmentLabel === (list.environmentLabel ?? null) &&
    previous.title === (list.title ?? null) &&
    previous.repo === (list.repo ?? null) &&
    (previous.stale === 1) === (list.stale === true) &&
    previous.staleReason === (list.staleReason ?? null) &&
    previous.prNumber === detail.prNumber &&
    previous.prState === prState
  );
}

const SELECT_COLUMNS = `
    thread_id AS threadId,
    parent_thread_id AS parentThreadId,
    revision,
    phase,
    reason,
    conclusion,
    needs_you AS needsYou,
    activity,
    goal_summary AS goalSummary,
    goal,
    avoid,
    files_json AS filesJson,
    latest_command AS latestCommand,
    branch,
    commit_sha AS commitSha,
    environment_id AS environmentId,
    environment_label AS environmentLabel,
    title,
    repo,
    stale,
    stale_reason AS staleReason,
    pr_number AS prNumber,
    pr_state AS prState,
    grandchild_count AS grandchildCount,
    grandchild_note AS grandchildNote,
    created_at_ms AS createdAtMs,
    activity_at_ms AS activityAtMs,
    idle_eligible AS idleEligible,
    updated_at AS updatedAt
  `;

const RELEVANT_ITEM_TYPES = [
  "file_change",
  "command_execution",
  "assistant_message",
  "file_search",
  "web_search",
  "todo_list",
  "approval_request",
];

interface StoredLane {
  lane: PushLane;
  token: number;
}

interface ItemRow {
  readonly type: string;
  readonly status: string;
  readonly fileName: string | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly command: string | null;
  readonly text: string | null;
  readonly pattern: string | null;
  readonly title: string | null;
  readonly requestKind: string | null;
  readonly requestId: string | null;
  readonly prompt: string | null;
}

type RemoteSummaryInput = Omit<
  RemoteSummaryFacts,
  "previousActivity" | "previousBranch" | "previousCommit" | "previousTitle" | "previousRepo"
>;

interface ChildSessionSummaryInternalShape {
  readonly note: (facts: SummaryFacts) => Effect.Effect<void, ChildSummaryReadError>;
  readonly noteRemote: (facts: RemoteSummaryInput) => Effect.Effect<void, ChildSummaryReadError>;
  readonly removeRemote: (threadId: ThreadId) => Effect.Effect<void, ChildSummaryReadError>;
  readonly recompute: (
    threadId: ThreadId,
    shell: OrchestrationV2ThreadShell | null,
  ) => Effect.Effect<void, ChildSummaryReadError>;
  readonly markIdle: () => Effect.Effect<void, ChildSummaryReadError>;
}

/** Implementation surface for workers and tests; not part of the read contract. */
export class ChildSessionSummaryInternal extends Context.Service<
  ChildSessionSummaryInternal,
  ChildSessionSummaryInternalShape
>()("t3/orchestration-v2/ChildSessionSummary/ChildSessionSummaryInternal") {}

export class ChildSessionSummary extends Context.Service<
  ChildSessionSummary,
  {
    readonly list: (options: {
      readonly threadId: ThreadId;
      readonly cursor?: string | undefined;
    }) => Effect.Effect<CommandChildrenPage, ChildSummaryReadError | ChildSummaryCursorError>;
    readonly detail: (options: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<ChildSummaryDetail | null, ChildSummaryReadError>;
    readonly subscribe: (
      threadId: ThreadId,
    ) => Stream.Stream<ChildSummaryStreamEvent, ChildSummaryReadError>;
  }
>()("t3/orchestration-v2/ChildSessionSummary") {
  static readonly layer: Layer.Layer<
    ChildSessionSummary | ChildSessionSummaryInternal,
    never,
    SqlClient.SqlClient
  > = Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const layerScope = yield* Effect.scope;
      const pubsub = yield* PubSub.unbounded<ChildSummaryStreamEvent>();
      // Idle and write paths share one permit so a stale-then-write pair cannot
      // interleave a lower revision between read and update.
      const writeSemaphore = yield* Semaphore.make(1);
      const lanes = new Map<string, StoredLane>();

      const readError = (error: unknown) =>
        new ChildSummaryReadError({
          cause: error instanceof Error ? error.cause : undefined,
        });

      const assist = yield* Effect.serviceOption(CommandAssist.CommandAssist);

      const warnSql = (operation: string, threadId: ThreadId) => (error: unknown) =>
        Effect.logWarning("child-summary.assist-read-failed", { operation, threadId, error });

      const scheduleAssist = Effect.fn("ChildSessionSummary.scheduleAssist")(function* (input: {
        readonly facts: SummaryFacts;
        readonly detail: Omit<ChildSummaryDetail, "revision" | "updatedAt">;
        readonly reason: string;
        readonly handback: boolean;
        readonly opened: boolean;
      }) {
        if (Option.isNone(assist)) return;
        const service = assist.value;
        const threadId = input.facts.threadId;
        const watchAnywhere = yield* service.activityOrDriftEnabled({
          projectId: null,
          anywhere: true,
        });
        if (!watchAnywhere && !input.handback) return;
        const project = yield* sql<{ readonly projectId: string | null }>`
          SELECT json_extract(payload_json, '$.projectId') AS projectId
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
        `.pipe(
          Effect.tapError(warnSql("project", threadId)),
          Effect.orElseSucceed(() => [] as const),
        );
        const projectId =
          typeof project[0]?.projectId === "string" ? ProjectId.make(project[0].projectId) : null;
        const watchHere = yield* service.activityOrDriftEnabled({ projectId, anywhere: false });
        if (!watchHere && !input.handback) return;
        const roots =
          projectId === null
            ? []
            : yield* sql<{ readonly cwd: string | null }>`
                SELECT workspace_root AS cwd
                FROM projection_projects
                WHERE project_id = ${projectId}
              `.pipe(
                Effect.tapError(warnSql("workspace", threadId)),
                Effect.orElseSucceed(() => [] as const),
              );
        const cwd = roots[0]?.cwd?.trim() ?? "";
        if (cwd.length === 0 || cwd === "/") {
          yield* Effect.logWarning("child-summary.assist-skipped", { threadId });
          return;
        }
        const run = yield* sql<{ readonly runId: string }>`
          SELECT run_id AS runId
          FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId}
          ORDER BY ordinal DESC
          LIMIT 1
        `.pipe(
          Effect.tapError(warnSql("run", threadId)),
          Effect.orElseSucceed(() => [] as const),
        );
        const runId = run[0]?.runId;
        if (watchHere) {
          const counted =
            runId === undefined
              ? []
              : yield* sql<{ readonly total: number }>`
                  SELECT count(*) AS total
                  FROM orchestration_v2_projection_turn_items
                  WHERE thread_id = ${threadId}
                    AND run_id = ${runId}
                    AND type IN ('file_change', 'command_execution')
                `.pipe(
                  Effect.tapError(warnSql("steps", threadId)),
                  Effect.orElseSucceed(() => [] as const),
                );
          const additions = input.detail.files.reduce((sum, file) => sum + file.additions, 0);
          const deletions = input.detail.files.reduce((sum, file) => sum + file.deletions, 0);
          yield* service
            .observe({
              threadId,
              projectId,
              cwd,
              runId: runId ?? threadId,
              opened: input.opened,
              stepCount: Number(counted[0]?.total ?? 0),
              silence: input.reason === CHILD_SUMMARY_SILENCE_REASON,
              goal: input.facts.goal ?? "",
              avoid: input.detail.avoid === "没有写别碰" ? "" : input.detail.avoid,
              activity: input.detail.activity,
              files: assistFiles(input.detail),
              latestCommand: input.detail.latestCommand,
              additions,
              deletions,
              childPhase: input.reason,
            })
            .pipe(Effect.ignore);
        }
        if (!input.handback || runId === undefined) return;
        const report = yield* sql<{ readonly text: string | null }>`
          SELECT json_extract(payload_json, '$.text') AS text
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
            AND run_id = ${runId}
            AND type = 'assistant_message'
          ORDER BY ordinal DESC
          LIMIT 1
        `.pipe(
          Effect.tapError(warnSql("report", threadId)),
          Effect.orElseSucceed(() => [] as const),
        );
        yield* service
          .handback({
            threadId,
            projectId,
            cwd,
            prExists: input.facts.pr !== null && input.facts.pr.state !== "unknown",
            // Whether that commit is the branch head needs git. Null keeps the check from saying it matched.
            headOnBranch: null,
            report: report[0]?.text ?? "",
            childPhase: input.reason,
          })
          .pipe(Effect.ignore);
      });

      const forkAssist = (work: Effect.Effect<void>) =>
        work.pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, layerScope), Effect.asVoid);

      const publish = Effect.fn("ChildSessionSummary.publish")(function* (
        row: ChildSummaryListItem,
      ) {
        const nowMs = yield* Clock.currentTimeMillis;
        const stored = lanes.get(row.threadId) ?? { lane: emptyPushLane, token: 0 };
        const offered = offerPush(stored.lane, row, nowMs);
        if (offered.emit !== null) {
          // Urgent and terminal rows publish at once; a lane with nothing pending is done.
          if (offered.lane.pending === null) lanes.delete(row.threadId);
          else lanes.set(row.threadId, { lane: offered.lane, token: stored.token });
          yield* PubSub.publish(pubsub, { _tag: "upsert", row: offered.emit });
          return;
        }
        const armMs = offered.armMs;
        if (armMs === null) {
          lanes.set(row.threadId, { lane: offered.lane, token: stored.token });
          return;
        }
        lanes.set(row.threadId, { lane: offered.lane, token: stored.token + 1 });
        yield* forkParked(
          Effect.gen(function* () {
            yield* Effect.sleep(armMs);
            const current = lanes.get(row.threadId);
            if (current === undefined || current.token !== stored.token + 1) return;
            const now = yield* Clock.currentTimeMillis;
            const flushed = flushPush(current.lane, now);
            if (flushed.lane.pending === null) lanes.delete(row.threadId);
            else lanes.set(row.threadId, { lane: flushed.lane, token: current.token });
            if (flushed.emit !== null) {
              yield* PubSub.publish(pubsub, { _tag: "upsert", row: flushed.emit });
            }
          }),
        ).pipe(Effect.provideService(Scope.Scope, layerScope));
      });

      const getRow = (threadId: ThreadId) =>
        sql<SummaryRow>`SELECT ${sql.literal(SELECT_COLUMNS)} FROM child_session_summary WHERE thread_id = ${threadId}`.pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(readError),
        );

      const note = Effect.fn("ChildSessionSummary.note")((facts: SummaryFacts) =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const derived = deriveChildSummary(facts, nowMs);
            const previous = yield* getRow(facts.threadId);
            if (
              previous !== null &&
              sameContent(previous, derived.list, derived.detail, facts.pr?.state ?? null)
            ) {
              yield* forkAssist(
                scheduleAssist({
                  facts,
                  detail: derived.detail,
                  reason: derived.list.reason,
                  handback: false,
                  opened: false,
                }),
              );
              return;
            }
            const revision = previous === null ? 1 : previous.revision + 1;
            const updatedAt = isoOf(nowMs);
            const filesJson = filesJsonOf(derived.detail.files);
            yield* sql`
              INSERT INTO child_session_summary (
                thread_id, parent_thread_id, revision, phase, reason, conclusion, needs_you,
                activity, goal_summary, goal, avoid, files_json, latest_command, branch,
                pr_number, pr_state, grandchild_count, grandchild_note,
                created_at_ms, activity_at_ms, idle_eligible, updated_at
              ) VALUES (
                ${facts.threadId}, ${facts.parentThreadId}, ${revision}, ${derived.list.phase},
                ${derived.list.reason}, ${derived.list.conclusion}, ${derived.list.needsYou ? 1 : 0},
                ${derived.list.activity}, ${derived.list.goalSummary}, ${derived.detail.goal},
                ${derived.detail.avoid}, ${filesJson},
                ${derived.detail.latestCommand}, ${derived.detail.branch},
                ${derived.detail.prNumber}, ${facts.pr?.state ?? null},
                ${derived.list.grandchildCount}, ${derived.list.grandchildNote},
                ${facts.createdAtMs}, ${facts.activityAtMs}, ${derived.idleEligible ? 1 : 0},
                ${updatedAt}
              )
              ON CONFLICT(thread_id) DO UPDATE SET
                parent_thread_id = excluded.parent_thread_id,
                revision = excluded.revision,
                phase = excluded.phase,
                reason = excluded.reason,
                conclusion = excluded.conclusion,
                needs_you = excluded.needs_you,
                activity = excluded.activity,
                goal_summary = excluded.goal_summary,
                goal = excluded.goal,
                avoid = excluded.avoid,
                files_json = excluded.files_json,
                latest_command = excluded.latest_command,
                branch = excluded.branch,
                pr_number = excluded.pr_number,
                pr_state = excluded.pr_state,
                grandchild_count = excluded.grandchild_count,
                grandchild_note = excluded.grandchild_note,
                created_at_ms = excluded.created_at_ms,
                activity_at_ms = excluded.activity_at_ms,
                idle_eligible = excluded.idle_eligible,
                updated_at = excluded.updated_at
            `.pipe(Effect.mapError(readError));
            yield* publish({ ...derived.list, revision, updatedAt });
            yield* forkAssist(
              scheduleAssist({
                facts,
                detail: derived.detail,
                reason: derived.list.reason,
                handback: derived.list.phase === "做完" && previous?.phase !== "做完",
                opened: false,
              }),
            );
          }),
        ),
      );

      const noteRemote = Effect.fn("ChildSessionSummary.noteRemote")((input: RemoteSummaryInput) =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const previous = yield* getRow(input.threadId);
            const derived = deriveRemoteChildSummary({
              ...input,
              previousActivity: previous?.activity ?? null,
              previousBranch: previous?.branch ?? null,
              previousCommit: previous?.commitSha ?? null,
              previousTitle: previous?.title ?? null,
              previousRepo: previous?.repo ?? null,
            });
            if (previous !== null && sameContent(previous, derived.list, derived.detail, null)) {
              return;
            }
            const revision = previous === null ? 1 : previous.revision + 1;
            const updatedAt = isoOf(nowMs);
            yield* sql`
              INSERT INTO child_session_summary (
                thread_id, parent_thread_id, revision, phase, reason, conclusion, needs_you,
                activity, goal_summary, goal, avoid, files_json, latest_command, branch,
                commit_sha, environment_id, environment_label, title, repo, stale, stale_reason,
                pr_number, pr_state, grandchild_count, grandchild_note,
                created_at_ms, activity_at_ms, idle_eligible, updated_at
              ) VALUES (
                ${input.threadId}, ${input.parentThreadId}, ${revision}, ${derived.list.phase},
                ${derived.list.reason}, ${derived.list.conclusion}, ${derived.list.needsYou ? 1 : 0},
                ${derived.list.activity}, ${derived.list.goalSummary}, ${derived.detail.goal},
                ${derived.detail.avoid}, ${"[]"}, ${null}, ${derived.detail.branch},
                ${derived.detail.commit}, ${derived.list.environmentId ?? null},
                ${derived.list.environmentLabel ?? null}, ${derived.list.title ?? null},
                ${derived.list.repo ?? null}, ${derived.list.stale === true ? 1 : 0},
                ${derived.list.staleReason ?? null},
                ${null}, ${null}, ${0}, ${null},
                ${input.createdAtMs}, ${nowMs}, ${0}, ${updatedAt}
              )
              ON CONFLICT(thread_id) DO UPDATE SET
                parent_thread_id = excluded.parent_thread_id,
                revision = excluded.revision,
                phase = excluded.phase,
                reason = excluded.reason,
                conclusion = excluded.conclusion,
                needs_you = excluded.needs_you,
                activity = excluded.activity,
                goal_summary = excluded.goal_summary,
                goal = excluded.goal,
                avoid = excluded.avoid,
                files_json = excluded.files_json,
                latest_command = excluded.latest_command,
                branch = excluded.branch,
                commit_sha = excluded.commit_sha,
                environment_id = excluded.environment_id,
                environment_label = excluded.environment_label,
                title = excluded.title,
                repo = excluded.repo,
                stale = excluded.stale,
                stale_reason = excluded.stale_reason,
                pr_number = excluded.pr_number,
                pr_state = excluded.pr_state,
                grandchild_count = excluded.grandchild_count,
                grandchild_note = excluded.grandchild_note,
                created_at_ms = excluded.created_at_ms,
                activity_at_ms = excluded.activity_at_ms,
                idle_eligible = excluded.idle_eligible,
                updated_at = excluded.updated_at
            `.pipe(Effect.mapError(readError));
            yield* publish({ ...derived.list, revision, updatedAt });
          }),
        ),
      );

      const removeRemote = Effect.fn("ChildSessionSummary.removeRemote")((threadId: ThreadId) =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const previous = yield* getRow(threadId);
            if (previous === null || previous.environmentId === null) return;
            yield* sql`
              DELETE FROM child_session_summary
              WHERE thread_id = ${threadId} AND environment_id IS NOT NULL
            `.pipe(Effect.mapError(readError));
            lanes.delete(threadId);
            yield* PubSub.publish(pubsub, {
              _tag: "deleted",
              threadId,
              parentThreadId: previous.parentThreadId,
            });
          }),
        ),
      );

      const buildFacts = Effect.fn("ChildSessionSummary.buildFacts")(function* (
        shell: OrchestrationV2ThreadShell,
        parentThreadId: ThreadId,
      ) {
        const items = yield* sql<ItemRow>`
            SELECT
              type,
              status,
              json_extract(payload_json, '$.fileName') AS fileName,
              json_extract(payload_json, '$.additions') AS additions,
              json_extract(payload_json, '$.deletions') AS deletions,
              json_extract(payload_json, '$.input') AS command,
              json_extract(payload_json, '$.text') AS text,
              coalesce(
                json_extract(payload_json, '$.patterns[0]'),
                json_extract(payload_json, '$.pattern')
              ) AS pattern,
              json_extract(payload_json, '$.title') AS title,
              json_extract(payload_json, '$.requestKind') AS requestKind,
              json_extract(payload_json, '$.requestId') AS requestId,
              json_extract(payload_json, '$.prompt') AS prompt
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${shell.id}
              AND type IN ${sql.in(RELEVANT_ITEM_TYPES)}
            ORDER BY ordinal DESC
            LIMIT 40
          `;
        const lastUser = yield* sql<{ readonly text: string | null }>`
            SELECT json_extract(payload_json, '$.text') AS text
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${shell.id} AND type = 'user_message'
            ORDER BY ordinal DESC
            LIMIT 1
          `;
        const activity = yield* sql<{ readonly latest: string | null }>`
            SELECT max(updated_at) AS latest
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${shell.id}
          `;
        // Grandchildren read back from summary rows: one indexed lookup, never a
        // payload_json scan of every projected thread.
        const grandchildren = yield* sql<{ readonly total: number }>`
            SELECT count(*) AS total
            FROM child_session_summary
            WHERE parent_thread_id = ${shell.id}
          `;

        const pending = shell.pendingRuntimeRequest;
        const approval =
          pending !== null && pending.kind === "command" && pending.blocking !== false
            ? pending
            : null;
        const waitingForAnswer =
          pending !== null && pending.kind === "user_input" && pending.blocking !== false;
        const approvalItem =
          approval === null
            ? null
            : (items.find(
                (item: ItemRow) =>
                  item.type === "approval_request" && item.requestId === approval.id,
              ) ?? null);
        const approvalCommand =
          approval === null
            ? null
            : (approvalItem?.prompt ??
              approvalItem?.title ??
              items.find((item: ItemRow) => item.type === "command_execution")?.command ??
              "命令");

        const summaryItems: SummaryItem[] = [];
        for (const row of items) {
          if (row.type === "approval_request") continue;
          summaryItems.push(
            toSummaryItem({
              type: row.type,
              status: row.status,
              fileName: row.fileName ?? undefined,
              additions: row.additions ?? undefined,
              deletions: row.deletions ?? undefined,
              input: row.command ?? undefined,
              text: row.text ?? undefined,
              pattern: row.pattern ?? undefined,
              title: row.title ?? undefined,
            }),
          );
        }

        const itemUpdated = activity[0]?.latest;
        const itemUpdatedMs =
          itemUpdated === null || itemUpdated === undefined ? 0 : Date.parse(itemUpdated);
        const statusChanged = Math.max(
          shell.latestRunCompletedAt == null
            ? 0
            : DateTime.toEpochMillis(shell.latestRunCompletedAt),
          shell.activityRunStartedAt == null
            ? 0
            : DateTime.toEpochMillis(shell.activityRunStartedAt),
          shell.latestRunStartedAt == null ? 0 : DateTime.toEpochMillis(shell.latestRunStartedAt),
        );
        const activityAtMs = Math.max(
          DateTime.toEpochMillis(shell.createdAt),
          statusChanged,
          Number.isNaN(itemUpdatedMs) ? 0 : itemUpdatedMs,
        );

        const timedOut = yield* sql<{ readonly marked: number }>`
            SELECT 1 AS marked
            FROM orchestration_v2_projection_subagents
            WHERE child_thread_id = ${shell.id}
              AND origin = 'app_owned'
              AND json_type(payload_json, '$.timedOutAt') = 'text'
            LIMIT 1
          `;
        const pr =
          shell.pullRequests?.find((link) => link.snapshot !== null) ??
          shell.pullRequests?.[0] ??
          null;
        return {
          threadId: shell.id,
          parentThreadId,
          createdAtMs: DateTime.toEpochMillis(shell.createdAt),
          activityAtMs,
          status: shell.status,
          ...(timedOut.length === 0 ? {} : { timedOut: true }),
          approvalCommand,
          waitingForAnswer,
          items: summaryItems,
          goal: shell.goal?.objective ?? shell.title ?? lastUser[0]?.text ?? null,
          taskText: lastUser[0]?.text ?? null,
          branch: shell.branch ?? null,
          pr: pr === null ? null : { number: pr.number, state: pr.snapshot?.state ?? "unknown" },
          grandchildCount: Number(grandchildren[0]?.total ?? 0),
        } satisfies SummaryFacts;
      }, Effect.mapError(readError));

      const recompute = Effect.fn("ChildSessionSummary.recompute")(function* (
        threadId: ThreadId,
        shell: OrchestrationV2ThreadShell | null,
      ) {
        if (shell === null || shell.deletedAt !== null) {
          const previous = yield* getRow(threadId);
          yield* sql`DELETE FROM child_session_summary WHERE thread_id = ${threadId}`.pipe(
            Effect.mapError(readError),
          );
          lanes.delete(threadId);
          if (previous !== null) {
            yield* PubSub.publish(pubsub, {
              _tag: "deleted",
              threadId,
              parentThreadId: previous.parentThreadId,
            });
          }
          return;
        }
        const parentId = shell.lineage.parentThreadId;
        if (shell.lineage.relationshipToParent !== "subagent" || parentId === null) return;
        const facts = yield* buildFacts(shell, parentId);
        yield* note(facts);
      });

      const markIdle = Effect.fn("ChildSessionSummary.markIdle")(function* () {
        yield* writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const stale = yield* sql<SummaryRow>`
              SELECT ${sql.literal(SELECT_COLUMNS)} FROM child_session_summary
              WHERE phase = '在做' AND idle_eligible = 1 AND activity_at_ms <= ${nowMs - CHILD_SUMMARY_IDLE_MS}
            `.pipe(Effect.mapError(readError));
            for (const row of stale) {
              const updatedAt = isoOf(nowMs);
              const updated = yield* sql<{ readonly revision: number }>`
                UPDATE child_session_summary
                SET phase = '卡住', reason = ${CHILD_SUMMARY_SILENCE_REASON}, revision = revision + 1, updated_at = ${updatedAt}
                WHERE thread_id = ${row.threadId} AND phase = '在做'
                RETURNING revision
              `.pipe(Effect.mapError(readError));
              const revision = updated[0]?.revision;
              if (revision === undefined) continue;
              yield* publish({
                ...storedRowToItem(row),
                phase: "卡住",
                reason: "没动静",
                revision,
                updatedAt,
              });
              const detail = storedRowToDetail(row);
              yield* forkAssist(
                scheduleAssist({
                  facts: {
                    threadId: row.threadId,
                    parentThreadId: row.parentThreadId,
                    createdAtMs: row.createdAtMs,
                    activityAtMs: row.activityAtMs,
                    status: "running",
                    approvalCommand: null,
                    waitingForAnswer: false,
                    items: [],
                    goal: row.goal,
                    taskText: null,
                    branch: row.branch,
                    pr: row.prNumber === null ? null : { number: row.prNumber, state: "unknown" },
                    grandchildCount: row.grandchildCount,
                  },
                  detail: { ...detail, activity: row.activity },
                  reason: CHILD_SUMMARY_SILENCE_REASON,
                  handback: false,
                  opened: false,
                }),
              );
            }
          }),
        );
      });

      const list = Effect.fn("ChildSessionSummary.list")(function* (options: {
        readonly threadId: ThreadId;
        readonly cursor?: string | undefined;
      }) {
        const parsed =
          options.cursor === undefined ? null : parseChildSummaryCursor(options.cursor);
        if (options.cursor !== undefined && parsed === null) {
          return yield* new ChildSummaryCursorError();
        }
        const rows = yield* (
          parsed === null
            ? sql<SummaryRow>`
              SELECT ${sql.literal(SELECT_COLUMNS)} FROM child_session_summary
              WHERE parent_thread_id = ${options.threadId}
              ORDER BY created_at_ms ASC, thread_id ASC
              LIMIT ${CHILD_SUMMARY_PAGE_SIZE + 1}
            `
            : sql<SummaryRow>`
              SELECT ${sql.literal(SELECT_COLUMNS)} FROM child_session_summary
              WHERE parent_thread_id = ${options.threadId}
                AND (created_at_ms > ${parsed.createdAtMs}
                  OR (created_at_ms = ${parsed.createdAtMs} AND thread_id > ${parsed.threadId}))
              ORDER BY created_at_ms ASC, thread_id ASC
              LIMIT ${CHILD_SUMMARY_PAGE_SIZE + 1}
            `
        ).pipe(Effect.mapError(readError));
        const page = rows.slice(0, CHILD_SUMMARY_PAGE_SIZE);
        const last = page[page.length - 1];
        const nextCursor =
          rows.length > CHILD_SUMMARY_PAGE_SIZE && last !== undefined
            ? childSummaryCursor(last)
            : null;
        return { children: page.map(storedRowToItem), nextCursor };
      });

      const detail = Effect.fn("ChildSessionSummary.detail")(function* (options: {
        readonly threadId: ThreadId;
      }) {
        const row = yield* getRow(options.threadId);
        if (row === null) return null;
        if (row.environmentId !== null) {
          return storedRowToDetail(row);
        }
        const assistState = yield* sql<{
          readonly outlook: string | null;
          readonly handback: string | null;
        }>`
          SELECT json_extract(state_json, '$.outlook') AS outlook,
                 json_extract(state_json, '$.handback') AS handback
          FROM command_assist_state
          WHERE thread_id = ${options.threadId}
        `.pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(readError),
        );
        const textOrNull = (value: string | null | undefined) =>
          typeof value === "string" && value.length > 0 ? value : null;
        const detail = {
          ...storedRowToDetail(row),
          outlook: textOrNull(assistState?.outlook),
          handback: textOrNull(assistState?.handback),
        };
        yield* forkAssist(
          scheduleAssist({
            facts: {
              threadId: row.threadId,
              parentThreadId: row.parentThreadId,
              createdAtMs: row.createdAtMs,
              activityAtMs: row.activityAtMs,
              status: "running",
              approvalCommand: null,
              waitingForAnswer: false,
              items: [],
              goal: row.goal,
              taskText: null,
              branch: row.branch,
              pr: row.prNumber === null ? null : { number: row.prNumber, state: "unknown" },
              grandchildCount: row.grandchildCount,
            },
            detail,
            reason: row.reason,
            handback: false,
            opened: true,
          }),
        );
        return detail;
      });

      const subscribe = (threadId: ThreadId) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // The queue is open before the snapshot, so a write between them is
            // never missed; a later delete event still overrides a pushed row.
            const subscription = yield* PubSub.subscribe(pubsub);
            const snapshot = yield* sql<SummaryRow>`
              SELECT ${sql.literal(SELECT_COLUMNS)} FROM child_session_summary
              WHERE parent_thread_id = ${threadId}
              ORDER BY created_at_ms ASC, thread_id ASC
            `.pipe(Effect.mapError(readError));
            return Stream.concat(
              Stream.fromIterable(
                snapshot.map((row): ChildSummaryStreamEvent => ({
                  _tag: "upsert",
                  row: storedRowToItem(row),
                })),
              ),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter(
                  (event) =>
                    (event._tag === "deleted" && event.parentThreadId === threadId) ||
                    (event._tag === "upsert" && event.row.parentThreadId === threadId),
                ),
              ),
            );
          }),
        );

      return Context.make(
        ChildSessionSummary,
        ChildSessionSummary.of({ list, detail, subscribe }),
      ).pipe(
        Context.add(
          ChildSessionSummaryInternal,
          ChildSessionSummaryInternal.of({ note, noteRemote, removeRemote, recompute, markIdle }),
        ),
      );
    }),
  );

  static readonly layerWorker = Layer.effectDiscard(
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const projectionStore = yield* ProjectionStoreV2;
      const internal = yield* ChildSessionSummaryInternal;
      const sql = yield* SqlClient.SqlClient;
      const highWater = yield* eventSink.latestSequence({});
      yield* forkParked(
        Effect.gen(function* () {
          const children = yield* sql<{ readonly threadId: string }>`
            SELECT thread_id AS threadId
            FROM orchestration_v2_projection_threads
            WHERE json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
              AND json_extract(payload_json, '$.creationSource') != 'provider'
              AND deleted_at IS NULL
              AND archived_at IS NULL
          `;
          const liveIds = new Set(children.map((child) => child.threadId));
          const rows = yield* sql<{ readonly threadId: string }>`
            SELECT thread_id AS threadId FROM child_session_summary
            WHERE environment_id IS NULL
          `;
          for (const row of rows) {
            if (!liveIds.has(row.threadId)) {
              yield* internal.recompute(ThreadId.make(row.threadId), null).pipe(Effect.ignore);
            }
          }
          yield* Effect.forEach(
            children,
            (child) => {
              const threadId = ThreadId.make(child.threadId);
              return projectionStore.getThreadShell(threadId).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    Effect.logWarning("child-summary.startup-shell-read-failed", {
                      threadId,
                      error,
                    }),
                  onSuccess: (shell) => internal.recompute(threadId, shell).pipe(Effect.ignore),
                }),
              );
            },
            { discard: true },
          );
          yield* Stream.runForEach(eventSink.stream({ afterSequence: highWater }), (stored) => {
            if (ACTIVITY_EVENTS[stored.event.type] !== true) return Effect.void;
            if (stored.event.type === "thread.deleted" || stored.event.type === "thread.archived") {
              return internal.recompute(stored.event.threadId, null).pipe(Effect.ignore);
            }
            const threadIds =
              stored.event.type === "subagent.updated"
                ? [stored.event.threadId, stored.event.payload.childThreadId]
                : [stored.event.threadId];
            return Effect.forEach(
              [...new Set(threadIds)].filter((threadId): threadId is ThreadId => threadId !== null),
              (threadId) =>
                projectionStore.getThreadShell(threadId).pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      Effect.logWarning("child-summary.event-shell-read-failed", {
                        threadId,
                        error,
                      }),
                    onSuccess: (shell) => internal.recompute(threadId, shell).pipe(Effect.ignore),
                  }),
                ),
              { discard: true },
            );
          });
        }),
      );
    }),
  ).pipe(Layer.provide(ChildSessionSummary.layer));

  static readonly layerIdle = Layer.effectDiscard(
    Effect.gen(function* () {
      const internal = yield* ChildSessionSummaryInternal;
      yield* forkParked(
        internal.markIdle().pipe(Effect.ignore, Effect.repeat(Schedule.spaced("30 seconds"))),
      );
    }),
  ).pipe(Layer.provide(ChildSessionSummary.layer));

  /**
   * Projects remote delegated child tasks into `child_session_summary` using only
   * `FleetSummary` and local subagent records — never subscribing to remote transcripts.
   */
  static readonly layerRemoteWorker: Layer.Layer<
    never,
    never,
    | ChildSessionSummaryInternal
    | Orchestrator.OrchestratorV2
    | FleetSummary.FleetSummary
    | SqlClient.SqlClient
  > = Layer.effectDiscard(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const fleetSummary = yield* FleetSummary.FleetSummary;
      const internal = yield* ChildSessionSummaryInternal;
      const sql = yield* SqlClient.SqlClient;
      const peerLinks = yield* Effect.serviceOption(PeerLinks.PeerLinks);
      const stateLock = yield* Semaphore.make(1);
      const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

      interface RemoteBinding {
        readonly parentThreadId: ThreadId;
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly label: string;
        readonly createdAtMs: number;
        readonly updatedAtMs: number;
        readonly subagentStatus: string;
        readonly title: string | null;
        readonly prompt: string;
        readonly result: string | null;
      }

      const remoteKey = (environmentId: string, threadId: string) =>
        `${environmentId}\n${threadId}`;

      const bindings = new Map<string, RemoteBinding>();
      const fleetRows = new Map<string, FleetSummaryRow>();

      const parseEpochMs = (value: unknown, fallback: number): number => {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string") {
          const parsed = Date.parse(value);
          if (!Number.isNaN(parsed)) return parsed;
        }
        return fallback;
      };

      const mergeBinding = (incoming: RemoteBinding) => {
        const key = remoteKey(incoming.environmentId, incoming.threadId);
        const existing = bindings.get(key);
        if (existing === undefined) {
          bindings.set(key, incoming);
          return incoming;
        }
        const createdAtMs = Math.min(existing.createdAtMs, incoming.createdAtMs);
        const merged =
          incoming.updatedAtMs >= existing.updatedAtMs
            ? { ...incoming, createdAtMs }
            : { ...existing, createdAtMs };
        bindings.set(key, merged);
        return merged;
      };

      const bindingFromPayload = (
        parentThreadId: ThreadId,
        payload: {
          readonly remoteChild?: {
            readonly environmentId?: unknown;
            readonly threadId?: unknown;
            readonly label?: unknown;
            readonly title?: unknown;
          };
          readonly status?: unknown;
          readonly title?: unknown;
          readonly prompt?: unknown;
          readonly result?: unknown;
          readonly startedAt?: unknown;
          readonly updatedAt?: unknown;
        },
      ): RemoteBinding | null => {
        const remote = payload.remoteChild;
        if (
          remote === undefined ||
          typeof remote.environmentId !== "string" ||
          remote.environmentId.trim().length === 0 ||
          typeof remote.threadId !== "string" ||
          remote.threadId.trim().length === 0
        ) {
          return null;
        }
        const updatedAtMs = parseEpochMs(payload.updatedAt, 0);
        const createdAtMs = parseEpochMs(payload.startedAt, updatedAtMs);
        return {
          parentThreadId,
          environmentId: EnvironmentId.make(remote.environmentId),
          threadId: ThreadId.make(remote.threadId),
          label:
            typeof remote.label === "string" && remote.label.trim().length > 0
              ? remote.label
              : remote.environmentId,
          createdAtMs,
          updatedAtMs,
          subagentStatus: typeof payload.status === "string" ? payload.status : "running",
          title:
            typeof remote.title === "string" && remote.title.trim().length > 0
              ? remote.title
              : typeof payload.title === "string"
                ? payload.title
                : null,
          prompt: typeof payload.prompt === "string" ? payload.prompt : "",
          result: typeof payload.result === "string" ? payload.result : null,
        };
      };

      const bindingFromSubagent = (
        parentThreadId: ThreadId,
        subagent: OrchestrationV2Subagent,
      ): RemoteBinding | null => {
        if (subagent.remoteChild === undefined) return null;
        const updatedAtMs = DateTime.toEpochMillis(subagent.updatedAt);
        const createdAtMs =
          subagent.startedAt === null ? updatedAtMs : DateTime.toEpochMillis(subagent.startedAt);
        return {
          parentThreadId,
          environmentId: subagent.remoteChild.environmentId,
          threadId: subagent.remoteChild.threadId,
          label: subagent.remoteChild.label || subagent.remoteChild.environmentId,
          createdAtMs,
          updatedAtMs,
          subagentStatus: subagent.status,
          title: subagent.remoteChild.title ?? subagent.title,
          prompt: subagent.prompt,
          result: subagent.result,
        };
      };

      const resolveLinkState = Effect.fn("ChildSessionSummary.resolveLinkState")(function* (
        environmentId: EnvironmentId,
      ): Effect.fn.Return<RemoteLinkState | null> {
        if (Option.isNone(peerLinks)) return null;
        const link = yield* peerLinks.value
          .get(environmentId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(link)) {
          return { kind: "unreachable", reason: "执行环境未连接" };
        }
        const now = yield* DateTime.now;
        if (DateTime.isLessThanOrEqualTo(link.value.expiresAt, now)) {
          return { kind: "unreachable", reason: "执行环境链接已过期" };
        }
        if (link.value.lastError !== null && link.value.lastError.trim().length > 0) {
          return { kind: "unreachable", reason: link.value.lastError };
        }
        return { kind: "reachable", label: link.value.label };
      });

      const reconcileBinding = Effect.fn("ChildSessionSummary.reconcileRemoteBinding")(function* (
        binding: RemoteBinding,
      ) {
        const key = remoteKey(binding.environmentId, binding.threadId);
        const fleetRow = fleetRows.get(key) ?? null;
        const linkState = yield* resolveLinkState(binding.environmentId);
        yield* internal
          .noteRemote({
            threadId: binding.threadId,
            parentThreadId: binding.parentThreadId,
            environmentId: binding.environmentId,
            environmentLabel: binding.label,
            createdAtMs: binding.createdAtMs,
            subagentStatus: binding.subagentStatus,
            title: binding.title,
            prompt: binding.prompt,
            result: binding.result,
            fleetRow,
            linkState,
          })
          .pipe(Effect.ignore);
      });

      const seedBindings = Effect.gen(function* () {
        const subagents = yield* sql<{
          readonly parentThreadId: string;
          readonly payloadJson: string;
        }>`
          SELECT
            s.thread_id AS parentThreadId,
            s.payload_json AS payloadJson
          FROM orchestration_v2_projection_subagents AS s
          INNER JOIN orchestration_v2_projection_threads AS p
            ON p.thread_id = s.thread_id
          WHERE s.origin = 'app_owned'
            AND s.child_thread_id IS NULL
            AND json_extract(s.payload_json, '$.remoteChild.environmentId') IS NOT NULL
            AND json_extract(s.payload_json, '$.remoteChild.threadId') IS NOT NULL
            AND p.deleted_at IS NULL
            AND p.archived_at IS NULL
        `.pipe(Effect.orElseSucceed(() => [] as const));
        for (const row of subagents) {
          const decoded = decodeJson(row.payloadJson);
          if (Option.isNone(decoded)) continue;
          const parsed = decoded.value;
          if (typeof parsed !== "object" || parsed === null) continue;
          const binding = bindingFromPayload(
            ThreadId.make(row.parentThreadId),
            parsed as Parameters<typeof bindingFromPayload>[1],
          );
          if (binding !== null) mergeBinding(binding);
        }
      });

      const sweepOrphanRemoteRows = Effect.gen(function* () {
        const liveRemoteIds = new Set([...bindings.values()].map((entry) => entry.threadId));
        const existing = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS threadId FROM child_session_summary
          WHERE environment_id IS NOT NULL
        `.pipe(Effect.orElseSucceed(() => [] as const));
        for (const row of existing) {
          const threadId = ThreadId.make(row.threadId);
          if (!liveRemoteIds.has(threadId)) {
            yield* internal.removeRemote(threadId).pipe(Effect.ignore);
          }
        }
      });

      const consumeFleetSummary = Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* fleetSummary.subscribe({});
          const pendingSnapshot = new Map<string, FleetSummaryRow>();
          yield* Stream.runForEach(stream, (event) =>
            stateLock.withPermits(1)(
              Effect.gen(function* () {
                if (event.type === "snapshot") {
                  for (const row of event.rows) {
                    if (row.threadId === undefined) continue;
                    pendingSnapshot.set(remoteKey(row.environmentId, row.threadId), row);
                  }
                  if (event.page === event.pageCount) {
                    fleetRows.clear();
                    for (const [key, row] of pendingSnapshot) fleetRows.set(key, row);
                    pendingSnapshot.clear();
                    yield* sweepOrphanRemoteRows;
                    for (const binding of bindings.values()) {
                      yield* reconcileBinding(binding);
                    }
                  }
                  return;
                }
                if (event.type === "upsert") {
                  if (event.row.threadId === undefined) return;
                  const key = remoteKey(event.row.environmentId, event.row.threadId);
                  fleetRows.set(key, event.row);
                  const binding = bindings.get(key);
                  if (binding !== undefined) yield* reconcileBinding(binding);
                  return;
                }
                if (event.type === "tombstone") {
                  if (event.key.threadId === undefined) return;
                  const key = remoteKey(event.key.environmentId, event.key.threadId);
                  fleetRows.delete(key);
                  const binding = bindings.get(key);
                  if (binding !== undefined) yield* reconcileBinding(binding);
                  return;
                }
                // Resync restarts this scoped subscription from a fresh snapshot.
                return yield* Effect.fail("resync" as const);
              }),
            ),
          );
        }),
      ).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          const squashed = Cause.squash(cause);
          if (squashed === "resync") return Effect.void;
          return Effect.logWarning("child-summary.remote-fleet-stream-failed", { cause }).pipe(
            Effect.andThen(Effect.sleep("1 second")),
          );
        }),
        Effect.forever,
      );

      const consumeSubagentEvents = Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        stateLock.withPermits(1)(
          Effect.gen(function* () {
            if (event.type === "thread.deleted" || event.type === "thread.archived") {
              for (const [key, binding] of bindings.entries()) {
                if (binding.parentThreadId !== event.threadId) continue;
                bindings.delete(key);
                yield* internal.removeRemote(binding.threadId).pipe(Effect.ignore);
              }
              return;
            }
            if (
              event.type !== "subagent.updated" ||
              event.payload.origin !== "app_owned" ||
              event.payload.remoteChild === undefined
            ) {
              return;
            }
            const binding = bindingFromSubagent(event.threadId, event.payload);
            if (binding === null) return;
            const merged = mergeBinding(binding);
            yield* reconcileBinding(merged);
          }),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("child-summary.remote-event-stream-failed", { cause }).pipe(
                Effect.andThen(Effect.sleep("1 second")),
              ),
        ),
        Effect.forever,
      );

      yield* forkParked(
        Effect.gen(function* () {
          yield* stateLock.withPermits(1)(seedBindings);
          yield* Effect.all([consumeFleetSummary, consumeSubagentEvents], {
            concurrency: "unbounded",
            discard: true,
          });
        }),
      );
    }),
  );
}
