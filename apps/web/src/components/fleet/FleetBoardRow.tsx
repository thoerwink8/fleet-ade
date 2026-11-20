import { fleetSummaryRowKey } from "@t3tools/client-runtime/state/fleet-summary";
import type { EnvironmentId, FleetSummaryRow, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  fleetReason,
  fleetStaleReason,
  fleetStatusAge,
  isFleetOfflineRow,
} from "./FleetBoard.logic";

function rowStatusBadge(row: FleetSummaryRow): {
  variant: "dot-attention" | "dot-active" | "dot-blocked" | "dot-done";
  label: string;
} {
  if (row.needsYou) return { variant: "dot-attention", label: "要你看" };
  if (row.phase === "stuck") return { variant: "dot-blocked", label: "卡住" };
  if (row.phase === "working") return { variant: "dot-active", label: "在做" };
  return { variant: "dot-done", label: "做完" };
}

export const FleetBoardRow = memo(function FleetBoardRow({
  row,
  machineName,
  machineConnected,
  now,
  selected,
  onSelect,
}: {
  row: FleetSummaryRow;
  machineName: string;
  machineConnected: boolean;
  /** Shared minute-granular epoch ms, so a page of rows never re-renders alone. */
  now: number;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const key = fleetSummaryRowKey(row);
  const staleText = fleetStaleReason(row);
  const offline = isFleetOfflineRow(row);
  const age = fleetStatusAge(row.updatedAt, now, row.needsYou);
  const status = rowStatusBadge(row);
  const reasonText =
    staleText !== null
      ? staleText
      : row.needsYou || row.phase === "stuck"
        ? fleetReason(row.reason)
        : "";
  const bodyLine = reasonText || row.lastProgress;
  const repoIssue =
    row.repo !== undefined && row.issue !== undefined
      ? `${row.repo} #${row.issue}`
      : row.repo !== undefined
        ? row.repo
        : row.issue !== undefined
          ? `#${row.issue}`
          : "";
  const metaTail = [machineName, repoIssue].filter(Boolean).join(" · ");

  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md transition-colors [content-visibility:auto] [contain-intrinsic-block-size:76px]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        data-fleet-row={key}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(key)}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 rounded-md px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex min-w-0 items-center gap-2">
          {offline ? <Badge variant="secondary">最后已知</Badge> : null}
          <Badge variant={status.variant}>{status.label}</Badge>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.title}</span>
          {age ? (
            <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
              {age}
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{bodyLine || "暂无进展"}</span>
          {age ? <span className="shrink-0 tabular-nums sm:hidden">{age}</span> : null}
        </div>
        {metaTail ? (
          <div className="min-w-0 truncate text-xs text-muted-foreground/80">{metaTail}</div>
        ) : null}
      </button>
      {row.needsYou && machineConnected && row.threadId !== undefined ? (
        <Button
          variant="warning-outline"
          size="xs"
          className="shrink-0"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{
                environmentId: row.environmentId as EnvironmentId,
                threadId: row.threadId as ThreadId,
              }}
            />
          }
        >
          去处理
        </Button>
      ) : null}
      <ChevronRightIcon aria-hidden className="me-2 size-3.5 shrink-0 text-muted-foreground/60" />
    </div>
  );
});
