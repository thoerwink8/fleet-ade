import { parsePullRequestAnchor, pullRequestLinkCommit } from "@t3tools/shared/pullRequestAnchor";
import { projectChangeRequestUrl } from "@t3tools/client-runtime/change-request-links";
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type PullRequestListEntry,
  type PullRequestRef,
} from "@t3tools/contracts";
import { ArrowLeftIcon, FileDiffIcon, PanelRightIcon } from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { resolveShortcutCommand, type ShortcutMatchContext } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { cn } from "~/lib/utils";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { pullRequestEnvironment, usePullRequestTurnRefresh } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { RelativeTime } from "~/components/RelativeTime";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import { PullRequestDetailHeaderBody, PullRequestDetailTitleRow } from "./PullRequestDetailLayout";
import { PullRequestDetailGhost } from "./PullRequestGhosts";
import { pullRequestRefKey, usePullRequestDetail } from "./usePullRequestDetail";
import { PullRequestDetailCrumbs } from "./PullRequestDetailCrumbs";
import { SourceControlAppAccessNotice } from "../SourceControlAppAccessNotice";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { openOnHostLabel } from "./pullRequestLinkContextMenu";
import { isPullRequestNotFound, resolvePullRequestReferenceHost } from "./pullRequestDetail.logic";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  resolvePullRequestState,
} from "./pullRequestPresentation";

// Defer the diff viewer's worker pool until Code renders.
const loadCodeTab = () => import("./PullRequestCodeTab");
const PullRequestCodeTab = lazy(loadCodeTab);

function resolvePullRequestReference(
  requestedReference: PullRequestRef,
  repositoryIdentity: Parameters<typeof resolvePullRequestReferenceHost>[1],
  supportsThreadPullRequests: boolean,
): PullRequestRef {
  return supportsThreadPullRequests
    ? resolvePullRequestReferenceHost(requestedReference, repositoryIdentity)
    : {
        projectId: requestedReference.projectId,
        repository: requestedReference.repository,
        number: requestedReference.number,
      };
}

export function PullRequestDetailPanel({
  environmentId,
  shortcutsEnabled,
  getShortcutContext,
  reference: requestedReference,
  listEntry = null,
  refreshToken: forcedRefreshToken = 0,
  onClose,
  onBack,
  revealUrl,
  onRevealSettled,
}: {
  environmentId: EnvironmentId;
  shortcutsEnabled: boolean;
  getShortcutContext: () => ShortcutMatchContext;
  reference: PullRequestRef;
  listEntry?: PullRequestListEntry | null;
  refreshToken?: number;
  onClose?: () => void;
  onBack?: (() => void) | undefined;
  /** A clicked link into this pull request, waiting to be shown. */
  revealUrl?: string | undefined;
  /** Reports the link it was given shown or missing, so a newer link stays pending. */
  onRevealSettled?: ((revealUrl: string) => void) | undefined;
}) {
  const environmentConfigs = useServerConfigs();
  const projects = useProjects();
  const project = projects.find(
    (candidate) =>
      candidate.id === requestedReference.projectId && candidate.environmentId === environmentId,
  );
  const repositoryIdentity = project?.repositoryIdentity;
  const supportsThreadPullRequests = environmentConfigs.get(environmentId) !== undefined;
  const reference = resolvePullRequestReference(
    requestedReference,
    repositoryIdentity,
    supportsThreadPullRequests,
  );
  const unavailableHostUrl = projectChangeRequestUrl(
    repositoryIdentity,
    reference.repository,
    reference.number,
  );
  const pullRequestKey = pullRequestRefKey(reference);
  const matchingListEntry =
    listEntry?.projectId === reference.projectId &&
    listEntry.repository.toLowerCase() === reference.repository.toLowerCase() &&
    (reference.host === undefined ||
      listEntry.host.toLowerCase() === reference.host.toLowerCase()) &&
    listEntry.number === reference.number
      ? listEntry
      : null;

  const { detailQuery, activityQuery, sharedSummary, detail } = usePullRequestDetail(
    environmentId,
    reference,
    matchingListEntry,
  );

  const revealAnchor = parsePullRequestAnchor(revealUrl);
  const [codeCommitScope, setCodeCommitScope] = useState<{
    readonly pullRequestKey: string;
    readonly oid: string | null;
  }>(() => ({ pullRequestKey, oid: pullRequestLinkCommit(revealUrl) }));
  const selectedCodeCommitOid =
    codeCommitScope.pullRequestKey === pullRequestKey ? codeCommitScope.oid : null;
  const followLink = useEffectEvent(() => {
    if (revealUrl === undefined) return;
    if (revealAnchor?.kind === "diff" || revealAnchor?.kind === "code") {
      setCodeCommitScope({ pullRequestKey, oid: pullRequestLinkCommit(revealUrl) });
      void loadCodeTab();
      if (revealAnchor.kind === "code") onRevealSettled?.(revealUrl);
      return;
    }
    if (revealAnchor?.kind === "commits") {
      setCodeCommitScope({ pullRequestKey, oid: pullRequestLinkCommit(revealUrl) });
      void loadCodeTab();
      onRevealSettled?.(revealUrl);
      return;
    }
    onRevealSettled?.(revealUrl);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a linked URL in the panel store selects the commit scope
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- link navigation selects the commit scope
    followLink();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each clicked link is a navigation request
  }, [revealUrl]);

  const [condensedScope, setCondensedScope] = useState<{
    readonly key: string;
    readonly condensed: boolean;
  }>({ key: `${environmentId}:${pullRequestKey}`, condensed: false });
  const tabScopeKey = `${environmentId}:${pullRequestKey}`;
  const condensed = condensedScope.key === tabScopeKey ? condensedScope.condensed : false;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const foldRef = useRef<HTMLDivElement | null>(null);
  const condensedRowRef = useRef<HTMLDivElement | null>(null);
  const compensationRef = useRef<{
    scopeKey: string;
    scroller: HTMLDivElement;
    target: number;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the scroller's scrollTop before paint after the header condenses
  useLayoutEffect(() => {
    const compensation = compensationRef.current;
    if (compensation === null) return;
    compensationRef.current = null;
    if (
      !condensed ||
      compensation.scopeKey !== tabScopeKey ||
      scrollerRef.current !== compensation.scroller
    ) {
      return;
    }
    compensation.scroller.scrollTop = Math.max(0, compensation.target);
  }, [condensed, tabScopeKey]);

  const turnRefresh = usePullRequestTurnRefresh(environmentId);
  const summaryMeta = detail ?? sharedSummary;
  const terminology = sourceControlClients.get(
    summaryMeta?.provider ?? listEntry?.provider ?? repositoryIdentity?.provider,
  ).changeRequest;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { copyToClipboard: copyReference } = useCopyToClipboard<string>({
    target: `${terminology.singular} reference`,
    onCopy: (label) => toastManager.add({ type: "success", title: `已复制 ${label}` }),
    onError: (error, label) =>
      toastManager.add({
        type: "error",
        title: `无法复制 ${label}`,
        description: error.message,
      }),
  });
  const copyFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!shortcutsEnabled || event.defaultPrevented || isCommandPaletteOpen()) return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: getShortcutContext(),
    });
    if (command !== "pullRequest.copyNumber") return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) copyReference(`#${reference.number}`, `${terminology.shortLabel} 编号`);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown capture listener for the copy-number shortcut
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => copyFromShortcut(event);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const repositoryUrl =
    detail === null
      ? null
      : (sourceControlClients.parseChangeRequestUrl(detail.url)?.link.repositoryUrl ?? null);
  const hostClient = sourceControlClients.get(detail?.provider);
  const openOnHostText = openOnHostLabel(hostClient);
  const authorProfileUrl =
    detail?.author && repositoryUrl !== null
      ? hostClient.authorProfileUrl(detail.author.login, repositoryUrl)
      : null;

  const refreshDetail = () => {
    detailQuery.refresh();
    activityQuery.refresh();
  };
  const [refreshToken, setRefreshToken] = useState(0);
  useLiveRefresh(
    () => {
      detailQuery.refresh();
    },
    { key: `pull-request:${environmentId}:${pullRequestKey}` },
  );
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const refreshFromHost = async () => {
    await invalidate({ environmentId, input: { reference } });
    refreshDetail();
    setRefreshToken((token) => token + 1);
  };
  const refreshFromHostOnRequest = useEffectEvent(() => void refreshFromHost());
  const appliedForcedToken = useRef(forcedRefreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new forced refresh token invalidates the host cache and refetches
  useEffect(() => {
    if (appliedForcedToken.current === forcedRefreshToken) return;
    appliedForcedToken.current = forcedRefreshToken;
    refreshFromHostOnRequest();
  }, [forcedRefreshToken]);

  const statePresentation = detail
    ? resolvePullRequestState({ state: detail.state, isDraft: detail.isDraft })
    : null;

  if (detailQuery.isPending && !detail) {
    return (
      <PullRequestDetailGhost
        seed={matchingListEntry}
        summary={sharedSummary}
        number={reference.number}
        {...(onBack ? { onBack } : {})}
        {...(onClose ? { onClose } : {})}
      />
    );
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-background">
      <div
        className={cn(
          "@container/pr-header grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2",
          detail && "border-b border-border/60",
          !detail && !onClose && "hidden",
        )}
      >
        <PullRequestDetailCrumbs
          detail={detail}
          toneClassName={statePresentation?.toneClassName ?? null}
          condensed={condensed}
          repositoryUrl={repositoryUrl}
          openOnHostText={openOnHostText}
          onBack={onBack}
        />
        <div className="mr-4 flex h-7 shrink-0 select-none items-center justify-end gap-1">
          {onClose ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`折叠 ${terminology.singular} 面板`}
              onClick={onClose}
            >
              <PanelRightIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>

        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[1fr]"
              : "grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={condensedRowRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "translate-y-0 opacity-100 delay-50"
                : "translate-y-1 opacity-0 duration-100",
            )}
            inert={!condensed}
          >
            {detail ? (
              <div className="col-span-2 min-w-0 px-4 pb-2 pt-1">
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
                    <PullRequestActorLabel
                      actor={detail.author}
                      profileUrl={authorProfileUrl}
                      variant="avatar"
                      className="shrink-0"
                    />
                    <span className="shrink-0">
                      <RelativeTime timestamp={detail.updatedAt} />
                    </span>
                  </span>
                  <span aria-hidden className="h-3 w-px shrink-0 bg-border/70" />
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-2xs text-muted-foreground/65">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <code className="inline-flex min-w-0 max-w-[40%] shrink-0">
                            <MiddleTruncate value={detail.baseBranch} showTitle={false} />
                          </code>
                        }
                      />
                      <TooltipPopup side="top">{detail.baseBranch}</TooltipPopup>
                    </Tooltip>
                    <ArrowLeftIcon
                      aria-label="接收来自以下分支的更改"
                      className="size-3 shrink-0 opacity-60"
                    />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <code className="flex min-w-0 flex-1">
                            <MiddleTruncate value={detail.headBranch} showTitle={false} />
                          </code>
                        }
                      />
                      <TooltipPopup side="top">{detail.headBranch}</TooltipPopup>
                    </Tooltip>
                  </span>
                  <span className="ml-auto inline-flex shrink-0 items-baseline justify-end gap-2 text-2xs">
                    <span
                      className="inline-flex items-baseline gap-1 tabular-nums"
                      aria-label={`${detail.changedFiles.toLocaleString("zh-CN")} changed ${
                        detail.changedFiles === 1 ? "file" : "files"
                      }`}
                    >
                      <FileDiffIcon aria-hidden className="size-3 self-center" />
                      {detail.changedFiles.toLocaleString("zh-CN")}
                    </span>
                    <PullRequestDiffStat
                      additions={detail.additions}
                      deletions={detail.deletions}
                      className="shrink-0 font-mono text-2xs"
                    />
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[0fr]"
              : "grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={foldRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "-translate-y-1 opacity-0 duration-100"
                : "translate-y-0 opacity-100 delay-50",
            )}
            inert={condensed}
          >
            {detail ? (
              <PullRequestDetailHeaderBody
                title={
                  <PullRequestDetailTitleRow>
                    <h1 className="truncate text-base font-semibold leading-snug">
                      {detail.title}
                    </h1>
                  </PullRequestDetailTitleRow>
                }
                author={
                  <PullRequestActorLabel actor={detail.author} profileUrl={authorProfileUrl} />
                }
                updated={
                  <span>
                    已更新 <RelativeTime timestamp={detail.updatedAt} />
                  </span>
                }
                base={
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <code className="inline-flex min-w-0 max-w-[40%] shrink-0">
                          <MiddleTruncate value={detail.baseBranch} showTitle={false} />
                        </code>
                      }
                    />
                    <TooltipPopup side="top">{detail.baseBranch}</TooltipPopup>
                  </Tooltip>
                }
                head={
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <code className="flex min-w-0 flex-1">
                          <MiddleTruncate value={detail.headBranch} showTitle={false} />
                        </code>
                      }
                    />
                    <TooltipPopup side="top">{detail.headBranch}</TooltipPopup>
                  </Tooltip>
                }
                files={`${detail.changedFiles.toLocaleString("zh-CN")} ${detail.changedFiles === 1 ? "file" : "files"}`}
                diffStat={
                  <PullRequestDiffStat
                    additions={detail.additions}
                    deletions={detail.deletions}
                    className="shrink-0 font-mono text-xs"
                  />
                }
              />
            ) : null}
          </div>
        </div>
      </div>

      <SourceControlAppAccessNotice
        environmentId={environmentId}
        provider={detail?.provider ?? repositoryIdentity?.provider}
        host={reference.host}
        repository={reference.repository}
        className="border-b border-border/60"
      />
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        onScrollCapture={(event) => {
          const scroller = scrollerRef.current;
          if (event.target !== scroller || scroller === null) return;
          const top = scroller.scrollTop;
          const previous = condensed;
          const foldHeight = foldRef.current?.scrollHeight ?? 0;
          let next = previous;
          if (previous) {
            if (top < 4 && foldHeight > 0) next = false;
          } else if (foldHeight > 0 && top > foldHeight + 32) {
            const chromeDelta = foldHeight - (condensedRowRef.current?.scrollHeight ?? 0);
            compensationRef.current = {
              scopeKey: tabScopeKey,
              scroller,
              target: top - chromeDelta,
            };
            next = true;
          }
          if (next !== previous) setCondensedScope({ key: tabScopeKey, condensed: next });
        }}
      >
        {detailQuery.error && !detail ? (
          <PullRequestsUnavailableState
            {...(isPullRequestNotFound(detailQuery.failure)
              ? {
                  title: `找不到 ${capitalizeTerm(terminology.singular)} #${reference.number}`,
                  error: `它可能是 issue 而不是 ${terminology.singular}，也可能是此账号无权查看。`,
                }
              : { error: detailQuery.error })}
            refreshing={detailQuery.isPending}
            onRetry={refreshDetail}
            {...(unavailableHostUrl
              ? {
                  host: {
                    url: unavailableHostUrl,
                    openLabel: openOnHostLabel(
                      sourceControlClients.get(repositoryIdentity?.provider),
                    ),
                  },
                }
              : {})}
          />
        ) : detail ? (
          <div className="absolute inset-0">
            <Suspense
              fallback={<DiffPanelLoadingState label={`正在加载 ${terminology.singular} 差异…`} />}
            >
              <PullRequestCodeTab
                scrollerRef={(node) => {
                  scrollerRef.current = node;
                }}
                environmentId={environmentId}
                reference={reference}
                detail={detail}
                selectedCommitOid={selectedCodeCommitOid}
                onSelectedCommitChange={(oid) => setCodeCommitScope({ pullRequestKey, oid })}
                refreshToken={refreshToken}
                backgroundRefreshToken={turnRefresh ?? 0}
                revealUrl={revealUrl}
                {...(onRevealSettled ? { onRevealSettled } : {})}
              />
            </Suspense>
          </div>
        ) : null}
      </div>
    </div>
  );
}
