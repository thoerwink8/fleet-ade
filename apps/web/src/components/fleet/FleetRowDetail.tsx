import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FleetSummaryRow, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowUpRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useThreadShell } from "~/state/entities";
import { formatFullTimestamp } from "~/timestampFormat";

import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import {
  fleetFullReason,
  fleetReason,
  fleetStaleReason,
  fleetStatusAge,
  isFleetOfflineRow,
} from "./FleetBoard.logic";

function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-3 py-1 text-prose">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function FleetRowDetail({
  row,
  machineName,
  machineConnected,
  isMobile,
  now,
  onClose,
}: {
  /** The row to show, or null while the drawer is closed. */
  row: FleetSummaryRow | null;
  machineName: string;
  machineConnected: boolean;
  isMobile: boolean;
  now: number;
  onClose: () => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const threadRef =
    row !== null && machineConnected && row.threadId !== undefined
      ? scopeThreadRef(row.environmentId as EnvironmentId, row.threadId as ThreadId)
      : null;
  const shell = useThreadShell(threadRef);
  const prLink = shell?.linkedPullRequest ?? shell?.branchPullRequest ?? null;
  const fullReason = row === null ? "" : fleetFullReason(row.reason);
  const shortReason = row === null ? "" : fleetReason(row.reason);
  const staleText = row === null ? null : fleetStaleReason(row);
  const offline = row !== null && isFleetOfflineRow(row);
  const needsYouAge = row !== null && row.needsYou ? fleetStatusAge(row.updatedAt, now, true) : "";

  return (
    <Sheet
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup
        side="right"
        layer="nested"
        showCloseButton={!isMobile}
        className={isMobile ? "w-full max-w-none" : "sm:max-w-[24rem]"}
        aria-label={row?.title ?? "任务详情"}
      >
        {row === null ? null : (
          <>
            <SheetHeader>
              {isMobile ? (
                <div className="mb-1 flex items-center">
                  <Button variant="ghost" size="sm" onClick={onClose}>
                    <ArrowLeftIcon aria-hidden />
                    返回
                  </Button>
                </div>
              ) : null}
              <SheetTitle>{row.title}</SheetTitle>
              <SheetDescription size="prose">
                {machineName}
                {row.repo !== undefined ? ` · ${row.repo}` : ""}
                {row.issue !== undefined ? ` · #${row.issue}` : ""}
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
              <div className="flex flex-wrap items-center gap-2">
                {offline ? <Badge variant="secondary">最后已知</Badge> : null}
                {row.needsYou ? <Badge variant="dot-attention">要你看</Badge> : null}
                {!row.needsYou && row.phase === "stuck" ? (
                  <Badge variant="dot-blocked">出错了</Badge>
                ) : null}
                {!row.needsYou && row.phase === "working" ? (
                  <Badge variant="dot-active">运行中</Badge>
                ) : null}
                {row.phase === "done" ? <Badge variant="dot-done">已完成</Badge> : null}
              </div>
              {row.needsYou || row.phase === "stuck" ? (
                <div className="flex flex-col gap-1">
                  {shortReason ? <p className="text-prose">{shortReason}</p> : null}
                  {fullReason && fullReason !== shortReason ? (
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                      {fullReason}
                    </pre>
                  ) : null}
                </div>
              ) : null}
              {staleText !== null ? <p className="text-prose text-warning">{staleText}</p> : null}
              <section aria-label="最新进展" className="rounded-lg border bg-card p-3">
                <p className="text-xs text-muted-foreground">最新进展</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-prose">
                  {row.lastProgress || "暂无进展"}
                </p>
              </section>
              <section aria-label="详情">
                <DetailItem label="更新时间">
                  {formatFullTimestamp(row.updatedAt, timestampFormat)}
                  {needsYouAge ? ` · ${needsYouAge}` : ""}
                </DetailItem>
                {row.repo !== undefined ? <DetailItem label="仓库">{row.repo}</DetailItem> : null}
                {row.taskId !== undefined ? (
                  <DetailItem label="任务">{row.taskId}</DetailItem>
                ) : null}
                {shell?.branch ? <DetailItem label="分支">{shell.branch}</DetailItem> : null}
                {prLink ? <DetailItem label="PR">#{prLink.number}</DetailItem> : null}
              </section>
              {!machineConnected ? (
                <div className="mt-auto flex flex-col gap-3 rounded-lg border bg-card p-3">
                  <p className="text-prose text-muted-foreground">
                    这台电脑没在本客户端连上，看不到详情
                  </p>
                  <div className="flex">
                    <Button
                      variant="outline"
                      size="sm"
                      render={<Link to="/settings/connections" />}
                    >
                      去连接
                    </Button>
                  </div>
                </div>
              ) : row.threadId !== undefined ? (
                <div className="mt-auto flex pt-2">
                  <Button
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
                    打开会话
                    <ArrowUpRightIcon aria-hidden />
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </SheetPopup>
    </Sheet>
  );
}
