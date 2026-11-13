import { useAtomCommand } from "~/state/use-atom-command";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import {
  capitalizeTerm,
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useClientSettings, useEnvironmentSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildPhysicalToLogicalProjectKeyMap } from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { usePreparePullRequestThreadAction } from "~/state/sourceControlActions";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { pullRequestEnvironment } from "~/state/pullRequests";

import { toastManager } from "../ui/toast";
import { offHeadPullRequestCheckoutToast } from "./pullRequestCheckoutToast";
import {
  checkoutFailureDescription,
  appendHandoff,
  readableFailure,
} from "./pullRequestDetail.logic";
import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";

export function usePullRequestDefaultMergeMethodResolver(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
) {
  const projectDefault = useEnvironmentSettings(
    environmentId,
    (settings) => resolveProjectSettings(settings, projectId).settings.pullRequestMergeMethod,
  );
  const legacyOverrides = useClientSettings((settings) => settings.pullRequestMergeMethodOverrides);
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return () => {
    if (projectDefault != null) return projectDefault;
    if (Object.keys(legacyOverrides).length === 0) return undefined;
    const project = projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    );
    if (!project) return undefined;
    const key =
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: grouping,
        primaryEnvironmentId,
      }).get(derivePhysicalProjectKey(project)) ??
      deriveLogicalProjectKeyFromSettings(project, grouping);
    return legacyOverrides[key];
  };
}

const actionSuccessLabels = (term: string): Record<PullRequestAction, string> => ({
  merge: "已请求合并",
  ready: "已标记为可审查",
  draft: "已转为草稿",
  close: `已关闭 ${capitalizeTerm(term)}`,
  reopen: `已重新打开 ${capitalizeTerm(term)}`,
  "update-branch": "已用基础分支更新分支",
  "enable-auto-merge": "已开启自动合并",
  "disable-auto-merge": "已关闭自动合并",
  revert: `已打开还原 ${term}`,
  "delete-branch": "已删除分支",
  "approve-workflows": "已批准工作流",
});

const actionFailureLabels = (term: string): Record<PullRequestAction, string> => ({
  merge: `无法合并此 ${term}`,
  ready: "无法将其标记为可审查",
  draft: "无法将其转为草稿",
  close: `无法关闭此 ${term}`,
  reopen: `无法重新打开此 ${term}`,
  "update-branch": "无法更新此分支",
  "enable-auto-merge": "无法开启自动合并",
  "disable-auto-merge": "无法关闭自动合并",
  revert: `无法打开还原 ${term}`,
  "delete-branch": "无法删除此分支",
  "approve-workflows": "无法批准工作流",
});

const actionFailureHints = (term: string): Record<PullRequestAction, string> => ({
  merge: "托管平台拒绝了合并。请确认你有写入权限、其要求的检查已通过，且分支没有冲突。",
  ready: "托管平台拒绝了该操作。请确认你对此仓库有写入权限。",
  draft: "托管平台拒绝了该操作。请确认你对此仓库有写入权限。",
  close: "托管平台拒绝了该操作。请确认你有写入权限，或该项由你创建。",
  reopen: "托管平台拒绝了该操作。请确认你有写入权限，且分支仍然存在。",
  "update-branch":
    "托管平台拒绝了此操作。请确认你有写入权限，且基础分支没有以托管平台无法合并的方式分叉。",
  "enable-auto-merge": "托管平台拒绝了此操作。请确认此仓库已允许自动合并，且你有写入权限。",
  "disable-auto-merge": "托管平台拒绝了该操作。请确认你对此仓库有写入权限。",
  revert: `托管平台拒绝了该操作。请确认你有写入权限，且此 ${term} 已在托管平台上合并。`,
  "delete-branch":
    "托管平台拒绝了该操作。请确认你对源仓库有写入权限，且分支在此页面加载后没有变动。",
  "approve-workflows":
    "托管平台拒绝了该操作。请确认你有 Actions 的写入权限，且这些工作流运行仍在等待批准。",
});

export function usePullRequestActionRunner({
  environmentId,
  reference,
  terminology,
  onSuccess,
  resolveMergeMethod,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef | null;
  terminology: ChangeRequestTerminology;
  onSuccess?: (action: PullRequestAction, reply: PullRequestSummary | undefined) => void;
  /** Resolve repository settings on click to avoid per-row reads. */
  resolveMergeMethod?: (detail: PullRequestDetail) => PullRequestMergeMethod;
}) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, {
    reportFailure: false,
  });
  const pendingRef = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const actionKey =
    reference === null
      ? null
      : JSON.stringify([
          environmentId,
          reference.host ?? null,
          reference.repository,
          reference.number,
        ]);
  const actionPending = actionKey !== null && pendingKeys.has(actionKey);

  const perform = async (action: PullRequestAction, method?: PullRequestMergeMethod) => {
    if (actionKey === null || reference === null || pendingRef.current.has(actionKey)) return;
    pendingRef.current.add(actionKey);
    setPendingKeys(new Set(pendingRef.current));
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        action,
        ...(method ? { mergeMethod: method } : resolveMergeMethod ? { resolveMergeMethod } : {}),
      },
    });
    pendingRef.current.delete(actionKey);
    setPendingKeys(new Set(pendingRef.current));
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: actionFailureLabels(terminology.singular)[action],
        description: readableFailure(
          squashAtomCommandFailure(result),
          actionFailureHints(terminology.singular)[action],
        ),
      });
      return;
    }
    toastManager.add({ type: "success", title: actionSuccessLabels(terminology.singular)[action] });
    onSuccess?.(action, result.value);
  };

  return { actionPending, perform };
}

export function usePullRequestCloseBatch(
  onClosed: (entry: EnvironmentPullRequestEntry, reply: PullRequestSummary | undefined) => void,
) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const pending = useRef(new Set<string>());
  const [closingKeys, setClosingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const close = async (entries: readonly EnvironmentPullRequestEntry[]) => {
    const batch = entries.filter((entry) => {
      const key = pullRequestEntryKey(entry);
      if (entry.state !== "open" || pending.current.has(key)) return false;
      pending.current.add(key);
      return true;
    });
    if (batch.length === 0) return;
    setClosingKeys(new Set(pending.current));
    const failures: string[] = [];
    const outcomes = await Promise.all(
      batch.map(async (entry) => {
        const result = await runAction({
          environmentId: entry.environmentId,
          input: {
            projectId: entry.projectId,
            host: entry.host,
            repository: entry.repository,
            number: entry.number,
            action: "close",
          },
        });
        pending.current.delete(pullRequestEntryKey(entry));
        setClosingKeys(new Set(pending.current));
        if (result._tag === "Failure") {
          failures.push(
            `#${entry.number}: ${readableFailure(squashAtomCommandFailure(result), actionFailureHints(sourceControlClients.get(entry.provider).changeRequest.singular).close)}`,
          );
          return;
        }
        onClosed(entry, result.value);
        return true;
      }),
    );
    const closed = outcomes.filter(Boolean).length;
    toastManager.add({
      type: failures.length > 0 ? "error" : "success",
      title:
        failures.length > 0
          ? `已关闭 ${closed} 个 pull request 中的 ${batch.length} 个`
          : `Closed ${closed} pull request${closed === 1 ? "" : "s"}`,
      ...(failures.length > 0 ? { description: failures.slice(0, 3).join("\n") } : {}),
    });
  };
  return { close, closingKeys };
}

export interface PullRequestThreadTask {
  prompt: string;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
}

export function writeHandoffToComposer(
  target: ScopedThreadRef | DraftId,
  task: PullRequestThreadTask,
) {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  const next = appendHandoff(
    { prompt: draft?.prompt ?? "", reviewComments: draft?.reviewComments ?? [] },
    task,
  );
  store.setPrompt(target, next.prompt);
  store.setReviewComments(target, next.reviewComments);
}

export type PullRequestHandoffDetail = Pick<
  PullRequestDetail,
  "projectId" | "workspaceRoot" | "url"
>;

export function usePullRequestHandoffs({
  environmentId,
  detail,
}: {
  environmentId: EnvironmentId;
  detail: PullRequestHandoffDetail | null;
}) {
  const newThread = useNewThreadHandler();
  const prepareThread = usePreparePullRequestThreadAction({
    environmentId,
    cwd: detail?.workspaceRoot ?? null,
  });
  // Serialize all handoffs because they check out the same pull request.
  const [handoff, setHandoff] = useState<string | null>(null);
  // Prompt links hand over a URL alone, so the URL is what names the host.
  const terminology = (
    (detail && sourceControlClients.findByChangeRequestUrl(detail.url)) ||
    sourceControlClients.get(undefined)
  ).changeRequest;

  // Questions must not change checkouts or create worktrees.
  const openThreadWithTask = async (
    projectRef: ReturnType<typeof scopeProjectRef>,
    task: PullRequestThreadTask | null,
    opened?: { draftId: DraftId },
  ): Promise<{ draftId: DraftId } | null> => {
    const session =
      opened ??
      (await newThread(projectRef).then(
        (result) => result,
        () => null,
      ));
    if (session === null) return null;
    if (task === null) return session;
    writeHandoffToComposer(session.draftId, task);
    return session;
  };

  const startAsk = async (kind: string, task: PullRequestThreadTask) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    const opened = await openThreadWithTask(projectRef, task);
    setHandoff(null);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "无法打开会话",
        description: "请从项目中重试，或先打开一个会话。",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "已在会话中提问",
      description:
        task.prompt.length > 0
          ? "问题已在输入框中。请检查后发送。"
          : `${terminology.singular} 已在输入框中。输入你的问题后发送。`,
    });
  };

  const startHandoff = async (
    kind: string,
    task: PullRequestThreadTask | null,
    mode: "worktree" | "local" = "worktree",
  ) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    // Dismissing the loading toast cancels the handoff before it touches a draft.
    let cancelled = false;
    // Explicit timeouts survive toast updates and would pin the result after loading.
    const toastId = toastManager.add({
      type: "loading",
      title: `正在准备 ${terminology.singular} 的工作副本…`,
      data: {
        onClose: () => {
          cancelled = true;
        },
      },
    });
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    // Checkout setup requires the thread to exist first.
    const opened = await newThread(projectRef).then(
      (session) => session,
      () => null,
    );
    if (cancelled) {
      setHandoff(null);
      return;
    }
    if (opened === null) {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: "无法为工作副本打开会话",
        description: "请从项目中重试，或先打开一个会话。",
      });
      return;
    }
    const prepared = await prepareThread.run({
      reference: detail.url,
      mode,
      threadId: opened.threadId,
    });
    if (cancelled) {
      setHandoff(null);
      return;
    }
    if (prepared._tag === "Failure") {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: `无法准备 ${terminology.singular} 的工作副本`,
        description: checkoutFailureDescription(
          isAtomCommandInterrupted(prepared) ? undefined : squashAtomCommandFailure(prepared),
        ),
      });
      return;
    }
    const pointed = await newThread(projectRef, {
      branch: prepared.value.branch,
      worktreePath: prepared.value.worktreePath,
      envMode: prepared.value.worktreePath === null ? "local" : "worktree",
    }).then(
      (session) => session,
      () => null,
    );
    if (cancelled) {
      setHandoff(null);
      return;
    }
    if (pointed === null) {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: "已检出，但会话仍在原处",
        description: `工作副本已在 \`${prepared.value.branch}\` 上准备好。请从分支选择器将会话指向它，然后再次提问。`,
      });
      return;
    }
    // The draft carries the pull request until its first send makes it a thread, which links it.
    useComposerDraftStore.getState().setDraftThreadContext(pointed.draftId, {
      checkoutPullRequest: {
        url: prepared.value.pullRequest.url,
        branch: prepared.value.branch,
      },
    });
    setHandoff(null);
    if (task === null) {
      toastManager.update(
        toastId,
        prepared.value.isOnPullRequestHead
          ? {
              type: "success",
              title: mode === "local" ? "已在此检出" : "已检出",
              description:
                mode === "local"
                  ? `此仓库已切换到 ${terminology.singular} 的分支，并在其上打开了会话。`
                  : `${terminology.singular} 已位于独立工作树中，并在其上打开了会话。`,
            }
          : offHeadPullRequestCheckoutToast(terminology),
      );
      return;
    }
    // The task goes on the checkout draft: if the user typed into `opened` while the
    // checkout ran, that is no longer the draft the user is looking at.
    await openThreadWithTask(projectRef, task, pointed);
    toastManager.update(
      toastId,
      prepared.value.isOnPullRequestHead
        ? {
            type: "success",
            title: "工作副本已就绪",
            description: "任务已在输入框中。请检查后发送。",
          }
        : offHeadPullRequestCheckoutToast(terminology),
    );
  };

  return { handoff, startAsk, startHandoff };
}
