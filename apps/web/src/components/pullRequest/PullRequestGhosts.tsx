import type { PullRequestListEntry, PullRequestSummary } from "@t3tools/contracts";
import { ArrowLeftIcon, ExternalLinkIcon, PanelRightIcon } from "lucide-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { RelativeTime } from "~/components/RelativeTime";

import { Button, InlineButton } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { PullRequestDetailHeaderBody, PullRequestDetailTitleRow } from "./PullRequestDetailLayout";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  resolvePullRequestState,
} from "./pullRequestPresentation";

function GhostBar({ className }: { className?: string | undefined }) {
  return <span aria-hidden className={cn("block h-3 rounded bg-muted-foreground/15", className)} />;
}

const TITLE_WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/2"];
const META_WIDTHS = ["w-2/5", "w-1/3", "w-2/5", "w-1/4", "w-1/3", "w-2/5", "w-1/3"];

export function PullRequestListGhost({ rows = 7, caption }: { rows?: number; caption?: string }) {
  return (
    <div role="status" aria-label={caption ?? "正在加载 PR"} className="space-y-0.5">
      {/* Outside the pulse so the explanation stays readable. */}
      {caption ? (
        <p className="px-3 pb-1 text-meta font-medium text-muted-foreground">{caption}</p>
      ) : null}
      <div className="motion-safe:animate-skeleton space-y-0.5">
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 py-2.5"
          >
            <GhostBar className="size-4 rounded-full" />
            <div className="min-w-0 space-y-1.5">
              <GhostBar className={cn("h-4", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
              <GhostBar className={cn("h-3.5", META_WIDTHS[index % META_WIDTHS.length])} />
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <GhostBar className="w-12" />
              <GhostBar className="w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PullRequestDetailGhost({
  seed: entry,
  summary,
  number,
  onBack,
  onClose,
}: {
  seed?: PullRequestListEntry | null;
  summary?: PullRequestSummary | null;
  number?: number;
  onBack?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}) {
  const seed = summary
    ? {
        ...entry,
        ...summary,
        isDraft: summary.isDraft ?? entry?.isDraft,
      }
    : entry;
  const terminology = sourceControlClients.get(seed?.provider).changeRequest;
  const statePresentation = seed
    ? resolvePullRequestState({
        state: seed.state,
        isDraft: seed.isDraft ?? false,
      })
    : null;
  const changedFiles = summary?.changedFiles ?? null;

  return (
    <div
      role="status"
      aria-label={`正在加载 ${terminology.singular}`}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-background",
        !seed && "motion-safe:animate-skeleton",
      )}
    >
      <div className="@container/pr-header grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60">
        <div className="pl-4 grid h-7 min-w-0 items-center overflow-hidden">
          <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground sm:text-xs">
            {onBack ? (
              <Button
                size="icon-micro"
                variant="ghost-muted"
                className="-ml-1.5"
                onClick={onBack}
                aria-label="返回到此会话的 PR"
              >
                <ArrowLeftIcon aria-hidden className="size-3.5" />
              </Button>
            ) : null}
            {seed ? (
              <>
                <span className="min-w-0 truncate font-medium">{seed.repository}</span>
                <InlineButton
                  onClick={() => void readLocalApi()?.shell.openExternal(seed.url)}
                  aria-label={`在托管平台上打开 ${terminology.singular} #${seed.number}`}
                >
                  <span className={statePresentation?.toneClassName}>#{seed.number}</span>
                  <ExternalLinkIcon aria-hidden className="size-2.5" />
                </InlineButton>
              </>
            ) : (
              <>
                <GhostBar className="w-24" />
                <span className="shrink-0 text-xs text-muted-foreground">#{number ?? "…"}</span>
              </>
            )}
          </div>
        </div>
        <div className="mr-4 flex h-7 shrink-0 items-center justify-end gap-1">
          {onClose ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`折叠 ${terminology.singular} 面板`}
              onClick={onClose}
            >
              <PanelRightIcon aria-hidden className="size-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="col-span-2 grid grid-rows-[1fr]">
          <div className="min-h-0 overflow-hidden">
            <PullRequestDetailHeaderBody
              title={
                <PullRequestDetailTitleRow>
                  {seed ? (
                    <h1 className="truncate text-base font-medium leading-snug">{seed.title}</h1>
                  ) : (
                    <GhostBar className="h-5 w-4/5 max-w-md" />
                  )}
                </PullRequestDetailTitleRow>
              }
              author={
                seed ? (
                  <PullRequestActorLabel actor={seed.author ?? null} tooltip={false} />
                ) : (
                  <span className="flex items-center gap-1.5">
                    <GhostBar className="size-4 rounded-full" />
                    <GhostBar className="h-3 w-14" />
                  </span>
                )
              }
              updated={
                seed ? (
                  <span>
                    已更新 <RelativeTime timestamp={seed.updatedAt} />
                  </span>
                ) : (
                  <GhostBar className="h-3 w-16" />
                )
              }
              base={
                <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1">
                  {seed ? (
                    <code className="flex min-w-0">
                      <MiddleTruncate value={seed.baseBranch} />
                    </code>
                  ) : (
                    <GhostBar className="h-3 w-12" />
                  )}
                </span>
              }
              head={
                seed ? (
                  <code className="flex min-w-0">
                    <MiddleTruncate value={seed.headBranch} />
                  </code>
                ) : (
                  <GhostBar className="h-3 w-32 flex-1" />
                )
              }
              files={
                changedFiles === null ? (
                  <GhostBar className="h-3 w-10" />
                ) : (
                  `${changedFiles.toLocaleString("zh-CN")} 个文件`
                )
              }
              diffStat={
                seed ? (
                  <PullRequestDiffStat
                    additions={seed.additions ?? 0}
                    deletions={seed.deletions ?? 0}
                    className="shrink-0 font-mono text-xs"
                  />
                ) : (
                  <GhostBar className="h-3 w-20" />
                )
              }
            />
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="space-y-3">
          <GhostBar className="h-5 w-40" />
          <div className="space-y-2">
            <GhostBar className="h-4 w-full" />
            <GhostBar className="h-4 w-11/12" />
            <GhostBar className="h-4 w-4/5" />
            <GhostBar className="h-4 w-2/3" />
          </div>
        </div>
      </div>
    </div>
  );
}
