import type { EnvironmentId, PipelineRun } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { pipelineEnvironment } from "../../state/pipeline";
import { useEnvironmentQuery } from "../../state/query";
import { cn } from "../../lib/utils";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import {
  formatCiQueue,
  formatCommitCount,
  formatInputTokens,
  groupPipelineRuns,
  PIPELINE_STATUS_BADGE,
  PIPELINE_STATUS_LABEL,
} from "./PipelinePage.logic";

function RunSection({
  title,
  note,
  runs,
  empty,
  emphasis = false,
}: {
  title: string;
  note?: string;
  runs: ReadonlyArray<PipelineRun>;
  empty: string;
  emphasis?: boolean;
}) {
  const loud = emphasis && runs.length > 0;
  return (
    <section className="min-w-0 space-y-2.5">
      <div className="space-y-1 px-1">
        <div className="flex min-h-7 items-center gap-2">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {runs.length}
          </span>
        </div>
        {note !== undefined ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      </div>
      <div
        className={cn(
          "min-w-0 overflow-hidden rounded-xl border shadow-xs/5",
          loud ? "border-destructive/40 bg-destructive/5" : "border-border/60 bg-card/40",
        )}
      >
        {runs.length === 0 ? (
          <p className="px-3.5 py-3 text-sm text-muted-foreground sm:px-4">{empty}</p>
        ) : (
          <ul className="min-w-0 divide-y divide-border/50">
            {runs.map((run) => (
              <li key={run.id} className="flex min-w-0 items-start gap-3 px-3.5 py-3 sm:px-4">
                <span className="mt-0.5 flex shrink-0">
                  <Badge variant={PIPELINE_STATUS_BADGE[run.status]}>
                    {PIPELINE_STATUS_LABEL[run.status]}
                  </Badge>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-5 font-medium break-words text-foreground">
                    {run.title}
                  </p>
                  <p className="mt-1 text-xs leading-5 break-words text-muted-foreground">
                    提交 {formatCommitCount(run)} · 排队 {formatCiQueue(run)} · 输入用量{" "}
                    {formatInputTokens(run)}
                  </p>
                  {run.stuckReason !== null ? (
                    <span className="mt-1.5 flex">
                      <Badge variant="error">{run.stuckReason}</Badge>
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground">
                  <span>#{run.issueNumber}</span>
                  {run.prNumber !== null ? <span>PR {run.prNumber}</span> : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function PipelineFrame({
  pending,
  refreshDisabled,
  onRefresh,
  children,
}: {
  pending: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
  children: ReactNode;
}) {
  return (
    <AppRouteModal label="流水线">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">流水线</h1>
          <Button variant="outline" size="sm" disabled={refreshDisabled} onClick={onRefresh}>
            <RefreshIcon refreshing={pending} />
            刷新
          </Button>
          <AppRouteModalClose />
        </header>
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <WorkspacePageContainer>
            <div className="grid min-w-0 gap-8">{children}</div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AppRouteModal>
  );
}

function PipelineConnected({ environmentId }: { environmentId: EnvironmentId }) {
  const list = useEnvironmentQuery(pipelineEnvironment.list({ environmentId, input: {} }));
  const groups = groupPipelineRuns(list.data?.runs ?? []);
  let body: ReactNode;
  if (list.error !== null && list.data === null) {
    body = <p className="text-sm break-all">读不到运行记录。</p>;
  } else if (list.data === null) {
    body = <p className="text-sm text-muted-foreground">正在读取。</p>;
  } else {
    body = (
      <>
        <RunSection
          title="要你拍的"
          note="和下面卡住的是同一批。"
          runs={groups.stuck}
          empty="现在没有要你拍的"
          emphasis
        />
        <RunSection title="在跑的" runs={groups.running} empty="现在没有在跑的" />
        <RunSection title="卡住的" runs={groups.stuck} empty="现在没有卡住的" />
        <RunSection title="最近开的 PR" runs={groups.recentPullRequests} empty="还没有开着的 PR" />
      </>
    );
  }

  return (
    <PipelineFrame
      pending={list.isPending}
      refreshDisabled={list.isPending}
      onRefresh={list.refresh}
    >
      {body}
    </PipelineFrame>
  );
}

export function PipelinePage() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <PipelineFrame pending={false} refreshDisabled onRefresh={() => {}}>
        <p className="text-sm text-muted-foreground">还没有连上的环境。</p>
      </PipelineFrame>
    );
  }
  return <PipelineConnected environmentId={environmentId} />;
}
