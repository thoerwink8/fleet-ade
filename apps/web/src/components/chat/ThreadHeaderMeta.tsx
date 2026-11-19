import type { ThreadLinkedPullRequest } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";

/** Ticket, branch and pull request tags that follow the title. Each part shows only when known. */
export function ThreadHeaderChips({
  issueNumber,
  branch,
  pullRequest,
  className,
}: {
  readonly issueNumber: number | null;
  readonly branch: string | null;
  readonly pullRequest: Pick<ThreadLinkedPullRequest, "number" | "url"> | null;
  readonly className?: string;
}) {
  if (issueNumber === null && !branch && pullRequest === null) return null;
  return (
    <div
      data-thread-header-chips
      className={cn("flex min-w-0 shrink items-center gap-2 max-md:hidden", className)}
    >
      {issueNumber !== null ? (
        <Badge variant="chip" data-thread-header-chip="issue">
          #{issueNumber}
        </Badge>
      ) : null}
      {branch ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="chip"
                data-thread-header-chip="branch"
                className="min-w-0 max-w-64 shrink"
              />
            }
          >
            <GitBranchIcon aria-hidden />
            <span className="min-w-0 truncate font-mono">{branch}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">{branch}</TooltipPopup>
        </Tooltip>
      ) : null}
      {pullRequest ? (
        <Badge
          variant="chip"
          data-thread-header-chip="pull-request"
          className="transition-colors hover:text-foreground"
          render={
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`打开 PR #${pullRequest.number}`}
            />
          }
        >
          <PullRequestGlyph.pullRequest aria-hidden />
          PR #{pullRequest.number}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * The one place the page shows how full the context window is. It opens the thread details,
 * which break the window down.
 */
export function ThreadHeaderContext({
  percent,
  open,
  presentation,
  popoverHandle,
  shortcutLabel,
  onToggle,
}: {
  readonly percent: string;
  readonly open: boolean;
  readonly presentation: ThreadPanelPresentation;
  readonly popoverHandle: ReturnType<typeof PopoverCreateHandle> | undefined;
  readonly shortcutLabel: string | null;
  readonly onToggle: () => void;
}): ReactNode {
  const button = (
    <Button
      type="button"
      variant="ghost-muted"
      size="xs"
      data-thread-header-context
      aria-label={`上下文已用 ${percent}，打开会话详情`}
      aria-pressed={open}
      className="[-webkit-app-region:no-drag]"
      onClick={presentation === "popover" ? undefined : onToggle}
    >
      <span className="tabular-nums">{percent}</span>
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        {presentation === "popover" ? (
          <PopoverTrigger handle={popoverHandle} render={button} />
        ) : (
          button
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        上下文窗口 {percent}，点开看组成
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
