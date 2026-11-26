import * as Cause from "effect/Cause";
import { isAtomCommandInterrupted, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type ScheduledTask } from "@t3tools/contracts";
import { describeRequestFailure } from "@t3tools/client-runtime/errors";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { toastManager } from "../ui/toast";

export const SCHEDULED_TASK_UNDO_MS = 8_000;

function scheduledTaskDeletedNotice(title: string, undo: (() => void) | null) {
  return {
    type: "success" as const,
    title: `已删除定时任务「${title}」`,
    timeout: SCHEDULED_TASK_UNDO_MS,
    // An older server deletes for good, so it must not offer a way back that cannot work.
    ...(undo === null ? {} : { actionProps: { children: "撤销" as const, onClick: undo } }),
  };
}

function squashMessage(cause: Cause.Cause<unknown>): string {
  const failure = describeRequestFailure(cause);
  return failure instanceof Error && failure.message.trim().length > 0
    ? failure.message
    : String(failure);
}

async function undoScheduledTaskDelete(
  environmentId: EnvironmentId,
  task: Pick<ScheduledTask, "id" | "title">,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.undoScheduledTaskDelete,
    { environmentId, input: { id: task.id } },
    { label: "scheduled task undo delete", reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  toastManager.add({
    type: "error",
    title: "无法撤销定时任务删除",
    description: squashMessage(result.cause),
    timeout: 8_000,
  });
}

export function requestScheduledTaskDelete(
  environmentId: EnvironmentId,
  task: Pick<ScheduledTask, "id" | "title">,
  canUndo: boolean,
): void {
  toastManager.add(
    scheduledTaskDeletedNotice(
      task.title,
      canUndo
        ? () => {
            void undoScheduledTaskDelete(environmentId, task);
          }
        : null,
    ),
  );
  void runAtomCommand(
    appAtomRegistry,
    serverEnvironment.deleteScheduledTask,
    { environmentId, input: { id: task.id } },
    { label: "scheduled task delete", reportFailure: false, reportDefect: false },
  ).then((result) => {
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title: "无法删除定时任务",
      description: squashMessage(result.cause),
      timeout: 8_000,
    });
  });
}
