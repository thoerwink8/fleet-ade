import { isListedThreadLineage } from "@t3tools/contracts";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";

export function planProjectRemoval<
  Thread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "lineage">,
>(options: {
  readonly members: ReadonlyArray<
    Pick<EnvironmentProject, "id" | "environmentId" | "title" | "workspaceRoot"> & {
      readonly environmentLabel?: string | null;
    }
  >;
  readonly groupMemberCount: number;
  readonly hasOtherMembers: boolean;
  readonly displayName: string;
  readonly threads: ReadonlyArray<Thread>;
  /** The members' threads this client does not hold: older settled threads its shell left out. */
  readonly unloadedThreadCount?: number;
}) {
  const { members, groupMemberCount, hasOtherMembers, displayName, threads } = options;
  const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
  const projectThreads = threads.filter((thread) =>
    memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  // Side chats and subagents go with their parent but never show in thread lists.
  const threadCount =
    projectThreads.filter((thread) => isListedThreadLineage(thread.lineage)).length +
    (options.unloadedThreadCount ?? 0);
  const isWholeGroup = members.length === groupMemberCount;
  const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = members.length === 1 ? members[0]! : null;
  const targetLabel = singleMember?.title ?? displayName;
  const confirmationMessage = [
    threadCount > 0
      ? `Remove ${targetKind} "${targetLabel}" and delete its ${threadCount} thread${threadCount === 1 ? "" : "s"}?`
      : `Remove ${targetKind} "${targetLabel}"?`,
    ...(singleMember
      ? [
          `路径：${singleMember.workspaceRoot}`,
          ...(singleMember.environmentLabel ? [`环境：${singleMember.environmentLabel}`] : []),
        ]
      : [`将移除 ${members.length} 个已分组的项目条目。`]),
    ...(threadCount > 0
      ? ["这些会话及所有已归档会话将从 T3 Code 中删除。提供方会话会保留。"]
      : ["所有已归档会话将从 T3 Code 中删除。提供方会话会保留。"]),
    isWholeGroup && !hasOtherMembers
      ? "仅移除项目条目，磁盘上的文件会保留。"
      : "此项目组中的其他条目不受影响。",
    "此操作无法撤销。",
  ].join("\n");

  return { projectThreads, isWholeGroup, targetKind, confirmationMessage };
}
