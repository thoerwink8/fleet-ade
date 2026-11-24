import {
  CommandId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

export class ScratchThreadPromotionError extends Schema.TaggedError<ScratchThreadPromotionError>()(
  "ScratchThreadPromotionError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ScratchThreadPromotion extends Context.Service<
  ScratchThreadPromotion,
  {
    /**
     * Turns a No project thread's folder into a project, in place, and moves every
     * thread working in that folder into it. Running it again finishes a partial move.
     */
    readonly promote: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<{ readonly projectId: ProjectId }, ScratchThreadPromotionError>;
  }
>()("t3/project/ScratchThreadPromotion") {}

const make = Effect.gen(function* () {
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const realPath = (folder: string) =>
    fileSystem.realPath(folder).pipe(Effect.orElseSucceed(() => folder));

  const fail = (reason: string) => (cause: unknown) =>
    new ScratchThreadPromotionError({ reason, cause });

  const promote: ScratchThreadPromotion["Service"]["promote"] = Effect.fn(
    "ScratchThreadPromotion.promote",
  )(function* (input) {
    const thread = yield* threads.getThreadShell(input.threadId).pipe(
      Effect.mapError(fail("无法读取会话。")),
      Effect.filterOrFail(
        (shell) => shell !== null,
        () => new ScratchThreadPromotionError({ reason: "未找到会话。" }),
      ),
    );
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.mapError(fail("无法读取会话所属的项目。")));
    const folder = thread.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
    const scratchRoot = Option.getOrUndefined(yield* managedFolders.scratchRoot);
    const isScratch = yield* managedFolders.isScratchProject(thread.projectId);
    // A thread already rooted at its folder is a partial earlier promotion; finish it.
    const alreadyPromoted =
      Option.isSome(project) && project.value.workspaceRoot === folder && !isScratch;
    if (
      folder === undefined ||
      scratchRoot === undefined ||
      (yield* realPath(path.dirname(folder))) !== (yield* realPath(scratchRoot)) ||
      !(isScratch || alreadyPromoted)
    ) {
      return yield* new ScratchThreadPromotionError({
        reason: "只有拥有独立目录的「无项目」会话才能变成项目。",
      });
    }

    const snapshot = yield* Effect.flatten(
      threads.readShellSnapshot({ worktreePath: folder }),
    ).pipe(Effect.mapError(fail("无法读取此目录中的会话。")));
    const moveSet = new Map<ThreadId, OrchestrationV2ThreadShell>();
    if (isScratch) moveSet.set(thread.id, thread);
    for (const candidate of [...snapshot.threads, ...snapshot.archivedThreads]) {
      if (yield* managedFolders.isScratchProject(candidate.projectId)) {
        moveSet.set(candidate.id, candidate);
      }
    }

    for (const candidate of moveSet.values()) {
      const records = yield* threads
        .getThreadRecords(candidate.id, ["runs", "runtimeRequests"], { turnItemTypes: [] })
        .pipe(Effect.mapError(fail(`无法读取「${candidate.title}」。`)));
      if (threadHasUnfinishedWork(records)) {
        return yield* new ScratchThreadPromotionError({
          reason: `「${candidate.title}」仍在工作。请先结束或停止它。`,
        });
      }
    }

    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const projectId = yield* createProject(thread.title, folder);
        yield* scheduledTasks
          .moveThreadTasks({ threadIds: [...moveSet.keys()], projectId })
          .pipe(Effect.mapError(fail("无法移动会话的定时任务。")));
        for (const candidate of moveSet.values()) {
          const commandId = CommandId.make(`scratch-promotion:${yield* randomId}`);
          yield* threads
            .dispatch({
              type: "thread.project.adopt-folder",
              commandId,
              threadId: candidate.id,
              projectId,
            })
            .pipe(Effect.mapError(fail(`无法移动「${candidate.title}」。请重试。`)));
        }
        return { projectId };
      }),
    );
  });

  const randomId = random.uuidV4();

  // bootstrap returns the project that already owns the folder, so retries reuse it.
  const createProject = Effect.fn("ScratchThreadPromotion.createProject")(function* (
    title: string,
    workspaceRoot: string,
  ) {
    const id = yield* randomId;
    return yield* projects
      .bootstrap({
        commandId: CommandId.make(`scratch-promotion-project:${id}`),
        projectId: ProjectId.make(id),
        title,
        workspaceRoot,
      })
      .pipe(
        Effect.map(({ project }) => project.id),
        // bootstrap reads before locking; racing creates return the winner in a conflict.
        Effect.catchTags({
          ProjectConflictError: (conflict) => Effect.succeed(conflict.conflictingProjectId),
        }),
        Effect.mapError(fail("无法创建项目。")),
      );
  });

  return ScratchThreadPromotion.of({ promote });
});

export const layer = Layer.effect(ScratchThreadPromotion, make);
