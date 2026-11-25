import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { presentVersionControlError } from "./versionControlError.logic";
import { VersionControlErrorDetail } from "./VersionControlErrorDetail";
import { useRef, useState } from "react";

import {
  readCachedPullRequestResolution,
  usePreparePullRequestThreadAction,
  usePullRequestResolutionState,
} from "~/state/sourceControlActions";
import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "@t3tools/client-runtime/pull-request-link-input";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { vcsEnvironment } from "~/state/vcs";
import { offHeadPullRequestCheckoutToast } from "./pullRequest/pullRequestCheckoutToast";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

interface PullRequestThreadDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: {
    branch: string;
    worktreePath: string | null;
    pullRequestUrl: string;
  }) => Promise<void> | void;
}

function pullRequestStatusTone(state: string | undefined): string {
  switch (state) {
    case "merged":
      return "text-violet-600 dark:text-violet-300/90";
    case "closed":
      return "text-zinc-500 dark:text-zinc-400/80";
    case "open":
      return "text-emerald-600 dark:text-emerald-300/90";
    default:
      return "text-muted-foreground";
  }
}
interface DialogError {
  readonly title?: string;
  readonly nextStep?: string;
  readonly detail: string;
  readonly collapseDetail: boolean;
}

function dialogError(error: unknown, fallbackAction: string): DialogError {
  const { title, nextStep, detail, collapseDetail } = presentVersionControlError(
    error,
    fallbackAction,
  );
  return { title, ...(nextStep === undefined ? {} : { nextStep }), detail, collapseDetail };
}

export function PullRequestThreadDialog({
  open,
  environmentId,
  threadId,
  cwd,
  initialReference,
  onOpenChange,
  onPrepared,
}: PullRequestThreadDialogProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [preparingMode, setPreparingMode] = useState<"local" | "worktree" | null>(null);
  const [prepareErrorMessage, setPrepareErrorMessage] = useState<DialogError | null>(null);
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const { data: gitStatus } = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd },
        }),
  );
  const sourceControlPresentation = getSourceControlPresentation(gitStatus?.sourceControlProvider);
  const terminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;

  const parsedReference = parsePullRequestReference(reference);
  const parsedDebouncedReference = parsePullRequestReference(debouncedReference);
  const pullRequestResolution = usePullRequestResolutionState({
    environmentId,
    cwd,
    reference: open ? parsedDebouncedReference : null,
  });
  const cachedPullRequest =
    readCachedPullRequestResolution({
      environmentId,
      cwd,
      reference: parsedReference,
    })?.pullRequest ?? null;
  const preparePullRequestThreadAction = usePreparePullRequestThreadAction({ environmentId, cwd });
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);

  const liveResolvedPullRequest =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (pullRequestResolution.data?.pullRequest ?? null)
      : null;
  const resolvedPullRequest = liveResolvedPullRequest ?? cachedPullRequest;
  const isResolving =
    open &&
    parsedReference !== null &&
    resolvedPullRequest === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      pullRequestResolution.isPending ||
      pullRequestResolution.isFetching);
  const statusTone = pullRequestStatusTone(resolvedPullRequest?.state);

  const handleConfirm = async (mode: "local" | "worktree") => {
    if (!preparePullRequestThreadAction.isAllowed) return;
    if (
      mode === "worktree" &&
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }
    if (!parsedReference) {
      setReferenceDirty(true);
      return;
    }
    if (!parsedReference || !resolvedPullRequest || !cwd) {
      return;
    }
    setPrepareErrorMessage(null);
    setPreparingMode(mode);
    const result = await preparePullRequestThreadAction.run({
      reference: parsedReference,
      mode,
      ...(mode === "worktree" ? { threadId } : {}),
    });
    setPreparingMode(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        preparePullRequestThreadAction.resetError();
      } else {
        const error = squashAtomCommandFailure(result);
        setPrepareErrorMessage(dialogError(error, "准备 PR 会话"));
      }
      return;
    }
    await onPrepared({
      branch: result.value.branch,
      worktreePath: result.value.worktreePath,
      pullRequestUrl: result.value.pullRequest.url,
    });
    if (!result.value.isOnPullRequestHead) {
      toastManager.add(offHeadPullRequestCheckoutToast(terminology));
    }
    onOpenChange(false);
  };

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? `请粘贴 ${terminology.singular} URL、检出命令，或输入 123 / #123。`
      : parsedReference === null
        ? `请使用 ${terminology.singular} URL、检出命令、123 或 #123。`
        : null;
  const errorMessage: DialogError | null =
    (validationMessage === null ? null : { detail: validationMessage, collapseDetail: false }) ??
    prepareErrorMessage ??
    (resolvedPullRequest === null && pullRequestResolution.error
      ? dialogError(pullRequestResolution.failure ?? pullRequestResolution.error, "加载 PR")
      : preparePullRequestThreadAction.error
        ? dialogError(preparePullRequestThreadAction.error, "准备 PR 会话")
        : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!preparePullRequestThreadAction.isPending) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup
        className="max-w-xl"
        initialFocus={() => {
          referenceInputRef.current?.focus();
          referenceInputRef.current?.select();
          return false;
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center">
            <SourceControlIcon className="me-2 size-4" />
            检出 {terminology.singular}
          </DialogTitle>
          <DialogDescription>
            解析一个 {sourceControlPresentation.providerName} {terminology.singular}，
            然后在主仓库或专用工作树中创建草稿会话。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="grid gap-1.5">
            <span className="text-meta font-medium text-foreground capitalize">
              {terminology.singular}
            </span>
            <Input
              ref={referenceInputRef}
              placeholder={`${terminology.shortLabel} URL、检出命令或 #42`}
              value={reference}
              onChange={(event) => {
                setReferenceDirty(true);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                if (event.nativeEvent.isComposing || event.keyCode === 229) {
                  return;
                }
                event.preventDefault();
                if (!isResolving && !preparePullRequestThreadAction.isPending) {
                  void handleConfirm("worktree");
                }
              }}
            />
          </label>

          {resolvedPullRequest ? (
            <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-row font-medium">{resolvedPullRequest.title}</p>
                  <p className="truncate text-muted-foreground text-xs">
                    #{resolvedPullRequest.number} · {resolvedPullRequest.headBranch} →{" "}
                    {resolvedPullRequest.baseBranch}
                  </p>
                </div>
                <span className={cn("shrink-0 text-xs capitalize", statusTone)}>
                  {resolvedPullRequest.state}
                </span>
              </div>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner size="sm" />
              正在解析 {terminology.singular}…
            </div>
          ) : null}

          {errorMessage ? (
            <div className="space-y-0.5 text-destructive text-xs">
              {errorMessage.title ? <p className="font-medium">{errorMessage.title}</p> : null}
              {errorMessage.nextStep ? <p>{errorMessage.nextStep}</p> : null}
              <VersionControlErrorDetail error={errorMessage} />
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={preparePullRequestThreadAction.isPending}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => handleConfirm("local")}
            disabled={
              !preparePullRequestThreadAction.isAllowed ||
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadAction.isPending
            }
          >
            {preparingMode === "local" ? "正在准备本地…" : "本地"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => handleConfirm("worktree")}
            disabled={
              !preparePullRequestThreadAction.isAllowed ||
              !canOperateThread ||
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadAction.isPending
            }
          >
            {preparingMode === "worktree" ? "正在准备工作树…" : "工作树"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
