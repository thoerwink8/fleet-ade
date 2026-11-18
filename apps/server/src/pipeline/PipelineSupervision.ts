import { CommandId, MessageId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { storageCleanupThreadIdle } from "../storageCleanup.ts";
import { PipelineRuns } from "./PipelineRuns.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "../mcp/delegatedTaskModes.ts";

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const failed = (error: unknown) => denied(error instanceof Error ? error.message : String(error));

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const settings = yield* ServerSettingsService;
  const runs = yield* PipelineRuns;
  const git = yield* GitWorkflowService;
  const sql = yield* SqlClient.SqlClient;
  const authorize = Effect.fn("PipelineSupervision.authorize")(function* (
    scope: McpInvocationScope,
  ) {
    if (
      !scope.capabilities.has("orchestration") ||
      scope.client?.access === "read-only" ||
      scope.thread === undefined
    ) {
      return yield* denied("A writing orchestration thread credential is required.");
    }
    const caller = yield* threads
      .getThreadShell(scope.thread.threadId)
      .pipe(Effect.mapError(failed));
    if (
      caller === null ||
      caller.deletedAt !== null ||
      caller.archivedAt !== null ||
      caller.activeRunId === null ||
      caller.providerInstanceId !== scope.thread.providerInstanceId ||
      caller.lineage.parentThreadId !== null ||
      caller.lineage.sideChat === true ||
      scope.thread.subagent === true
    ) {
      return yield* denied("Only an active top-level controller may supervise a pipeline run.");
    }
    const project = yield* projects.getById(caller.projectId).pipe(Effect.mapError(failed));
    if (Option.isNone(project)) return yield* denied("Controller project is unavailable.");
    const identity = project.value.repositoryIdentity;
    if (!identity?.owner || !identity.name)
      return yield* denied("Project repository identity is unavailable.");
    const repository = `${identity.owner}/${identity.name}`;
    const current = yield* settings.getSettings.pipe(Effect.mapError(failed));
    if (!current.pipelineRepos.includes(repository))
      return yield* denied("Controller repository is not allowlisted.");
    return { caller, repository, current };
  });
  const owned = Effect.fn("PipelineSupervision.owned")(function* (
    scope: McpInvocationScope,
    issueNumber: number,
    includeMerged = false,
  ) {
    const context = yield* authorize(scope);
    const run = (yield* runs.list.pipe(Effect.mapError(failed))).runs.find(
      (candidate) =>
        candidate.repository === context.repository &&
        candidate.issueNumber === issueNumber &&
        (includeMerged || candidate.status !== "merged") &&
        !(candidate.status === "stuck" && candidate.stuckReason === "取消"),
    );
    if (run === undefined || run.controllerThreadId !== context.caller.id)
      return yield* denied("No run belongs to this controller in the requested lifecycle.");
    return { ...context, run };
  });
  return {
    start: Effect.fn("PipelineSupervision.start")(function* (
      scope: McpInvocationScope,
      input: { issueNumber: number },
    ) {
      const { caller, repository } = yield* authorize(scope);
      const result = yield* runs
        .startSupervised({
          ...input,
          repository,
          controllerThreadId: caller.id,
        })
        .pipe(Effect.mapError(failed));
      if (result.status === "rejected")
        return yield* denied(`Pipeline start rejected: ${result.code}.`);
      return result.run;
    }),
    status: Effect.fn("PipelineSupervision.status")(function* (
      scope: McpInvocationScope,
      input: { issueNumber: number },
    ) {
      const { caller, run } = yield* owned(scope, input.issueNumber);
      if (run.threadId === null) return { run, worker: null };
      const worker = yield* threads
        .getThreadShell(ThreadId.make(run.threadId))
        .pipe(Effect.mapError(failed));
      if (worker === null || worker.projectId !== caller.projectId)
        return yield* denied("Worker does not belong to the controller project.");
      return {
        run,
        worker: {
          threadId: worker.id,
          latestRunId: worker.latestRunId,
          activeRunId: worker.activeRunId,
          status: worker.status,
          latestMessage: worker.latestVisibleMessage,
          lastError: worker.lastError ?? null,
        },
      };
    }),
    send: Effect.fn("PipelineSupervision.send")(function* (
      scope: McpInvocationScope,
      input: {
        issueNumber: number;
        message: string;
        mode?: "auto" | "queue" | "steer" | "restart" | undefined;
      },
    ) {
      const { caller, run } = yield* owned(scope, input.issueNumber);
      if (run.threadId === null) return yield* denied("The worker has not started.");
      const threadId = ThreadId.make(run.threadId);
      const worker = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failed));
      if (worker === null || worker.projectId !== caller.projectId)
        return yield* denied("Worker does not belong to the controller project.");
      yield* resolveRuntimeMode(caller.runtimeMode, worker.runtimeMode);
      yield* resolveInteractionMode(caller.interactionMode, worker.interactionMode);
      const key = SecureRandom.uuidV4Unsafe();
      const result = yield* threads
        .sendToThread({
          projectId: caller.projectId,
          threadId,
          commandId: CommandId.make(`pipeline-send:${key}`),
          messageId: MessageId.make(`pipeline-send:${key}`),
          senderThreadId: caller.id,
          text: input.message,
          attachments: [],
          mode: input.mode ?? "auto",
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(failed));
      return {
        delivery: result.delivery,
        threadId,
        messageId: result.message.id,
        runId: result.run.id,
        status: result.run.status,
      };
    }),
    verdict: Effect.fn("PipelineSupervision.verdict")(function* (
      scope: McpInvocationScope,
      input: {
        issueNumber: number;
        verdict: "accepted" | "rejected";
        expectedHeadSha: string;
      },
    ) {
      const { caller, run } = yield* owned(scope, input.issueNumber);
      if (run.headSha === null) return yield* denied("The current run has no head to judge.");
      if (run.headSha !== input.expectedHeadSha)
        return yield* denied("The reviewed head is no longer current.");
      const updated = yield* sql<{
        id: number;
      }>`UPDATE pipeline_runs SET controller_verdict = ${input.verdict},
        accepted_head_sha = ${input.verdict === "accepted" ? input.expectedHeadSha : null}
        WHERE id = ${run.id} AND controller_thread_id = ${caller.id}
        AND head_sha = ${input.expectedHeadSha}
        AND status != 'merged' AND NOT (status = 'stuck' AND stuck_reason = '取消') RETURNING id`.pipe(
        Effect.mapError(failed),
      );
      if (updated.length !== 1)
        return yield* denied("Run or head changed before the verdict was recorded.");
      return { verdict: input.verdict, headSha: input.expectedHeadSha };
    }),
    cleanup: Effect.fn("PipelineSupervision.cleanup")(function* (
      scope: McpInvocationScope,
      input: { issueNumber: number },
    ) {
      const { caller, run, current } = yield* owned(scope, input.issueNumber, true);
      if (
        run.controllerVerdict !== "accepted" ||
        run.headSha === null ||
        run.acceptedHeadSha !== run.headSha
      )
        return yield* denied("Cleanup requires acceptance of the current head.");
      if (run.status !== "merged")
        return { outcome: "retained" as const, reason: "Pipeline run has not been merged." };
      if (run.threadId === null)
        return { outcome: "retained" as const, reason: "The worker has not started." };
      const threadId = ThreadId.make(run.threadId);
      const worker = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failed));
      if (worker !== null && worker.projectId !== caller.projectId)
        return yield* denied("Worker belongs to another project.");
      if (worker === null)
        return { outcome: "retained" as const, reason: "Worker state is unknown." };
      if (worker.deletedAt === null) {
        if (
          !storageCleanupThreadIdle(worker, DateTime.toEpochMillis(yield* DateTime.now), current)
        ) {
          return {
            outcome: "retained" as const,
            reason: "Worker has active, queued, background, runtime, or unknown work.",
          };
        }
        yield* threads
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`pipeline-cleanup:${SecureRandom.uuidV4Unsafe()}`),
            threadId,
          })
          .pipe(Effect.mapError(failed));
      }
      if (worker.worktreePath !== null) {
        const project = yield* projects.getById(worker.projectId).pipe(Effect.mapError(failed));
        if (Option.isNone(project)) return yield* denied("Worker project is unavailable.");
        const removed = yield* git
          .removeWorktree({
            cwd: project.value.workspaceRoot,
            path: worker.worktreePath,
            force: true,
          })
          .pipe(Effect.exit);
        if (Exit.isFailure(removed)) {
          return {
            outcome: "retryable" as const,
            reason: "Worker deleted, but its worktree could not be removed.",
          };
        }
      }
      return {
        outcome: "deleted" as const,
        reason:
          worker.worktreePath === null
            ? "Worker deleted; it had no worktree."
            : "Worker deleted and its worktree removed.",
      };
    }),
  };
});

export class PipelineSupervision extends Context.Service<
  PipelineSupervision,
  Effect.Success<typeof make>
>()("t3/pipeline/PipelineSupervision") {}
export const layer = Layer.effect(PipelineSupervision, make);
