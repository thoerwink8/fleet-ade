import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  getNewProjectRepository,
  type NewProjectPublishTarget,
} from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  newProjectCommitWarningDescription,
  presentVersionControlError,
} from "~/components/versionControlError.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";
import { suggestAppAccessForRemote } from "../components/sourceControlAppAccessToast";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : "发生错误。";
}

export function useNewProject() {
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();

  const publishNewRepository = async (input: {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly target: NewProjectPublishTarget;
  }) => {
    const { label } = input.target.definition;
    const result = await publishRepository({
      environmentId: input.environmentId,
      input: {
        cwd: input.workspaceRoot,
        provider: input.target.definition.kind,
        repository: getNewProjectRepository(input.target, input.workspaceRoot),
        visibility: "private",
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const presentation = presentVersionControlError(
          squashAtomCommandFailure(result),
          `创建 ${label} 仓库`,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: presentation.title,
            description: `${presentation.description} 之后也可以在 Git 菜单中选择“发布仓库”。`,
          }),
        );
      }
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `已发布到 ${label}`,
        description: result.value.repository.nameWithOwner,
      }),
    );
    void suggestAppAccessForRemote(input.environmentId, result.value.remoteUrl);
  };

  return async (input: {
    readonly environmentId: EnvironmentId;
    readonly name: string;
    readonly publishTo: NewProjectPublishTarget | null;
  }): Promise<boolean> => {
    const result = await createNew({
      environmentId: input.environmentId,
      input: { name: input.name },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "无法创建项目",
            description: errorMessage(squashAtomCommandFailure(result)),
          }),
        );
      }
      return false;
    }

    const { projectId, workspaceRoot, commitError, commitFailure } = result.value;
    toastManager.add(
      stackedThreadToast(
        commitError === undefined && commitFailure === undefined
          ? { type: "success", title: `已创建 ${input.name}`, description: workspaceRoot }
          : {
              type: "warning",
              title: `已创建 ${input.name}，但还没有首个提交`,
              description: newProjectCommitWarningDescription(
                commitFailure,
                commitError,
                workspaceRoot,
              ),
            },
      ),
    );
    if (input.publishTo) {
      void publishNewRepository({
        environmentId: input.environmentId,
        workspaceRoot,
        target: input.publishTo,
      });
    }

    const projectRef = scopeProjectRef(input.environmentId, projectId);
    // Wait for the stored project path; drafts use it as their key.
    const project = await waitForProject(projectRef).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "无法打开项目",
          description: `${errorMessage(error)} 等这个客户端跟上后，它会出现在侧边栏。`,
        }),
      );
      return null;
    });
    if (project === null) return true;
    await handleNewThread(projectRef).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "无法打开项目",
          description: errorMessage(error),
        }),
      );
    });
    return true;
  };
}
