import type { EnvironmentId, PipelineRun } from "@t3tools/contracts";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { pipelineEnvironment } from "../../state/pipeline";
import { useEnvironmentQuery } from "../../state/query";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  formatCiQueue,
  formatCommitCount,
  formatInputTokens,
  groupPipelineRuns,
  isPipelineRunLink,
  PIPELINE_STATUS_BADGE,
  PIPELINE_STATUS_LABEL,
  pipelineRunElementId,
  type PipelineSection,
} from "./PipelineRunsSection.logic";

function scrollToPipelineRun(event: ReactMouseEvent<HTMLAnchorElement>, id: number) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  document.getElementById(pipelineRunElementId(id))?.scrollIntoView({ block: "nearest" });
}

function RunLinkRow({ run }: { run: PipelineRun }) {
  const elementId = pipelineRunElementId(run.id);
  return (
    <li className="min-w-0 px-3.5 py-2.5 sm:px-4">
      <div className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <a
          href={`#${elementId}`}
          onClick={(event) => scrollToPipelineRun(event, run.id)}
          className="min-w-0 leading-5 break-words text-foreground underline decoration-muted-foreground/60 underline-offset-4 hover:text-foreground"
        >
          {run.title}
        </a>
        <span className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
          <span>#{run.issueNumber}</span>
          {run.prNumber !== null ? (
            <a
              href={`https://github.com/${run.repository}/pull/${run.prNumber}`}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              PR {run.prNumber}
            </a>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function RunDetailRow({ run }: { run: PipelineRun }) {
  return (
    <li
      id={pipelineRunElementId(run.id)}
      className="min-w-0 scroll-mt-4 space-y-1.5 px-3.5 py-3 sm:px-4"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={PIPELINE_STATUS_BADGE[run.status]}>
            {PIPELINE_STATUS_LABEL[run.status]}
          </Badge>
          {run.stuckReason !== null ? <Badge variant="error">{run.stuckReason}</Badge> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground">
          <span>#{run.issueNumber}</span>
          {run.prNumber !== null ? (
            <a
              href={`https://github.com/${run.repository}/pull/${run.prNumber}`}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              PR {run.prNumber}
            </a>
          ) : null}
        </div>
      </div>
      <p className="min-w-0 text-row font-medium break-words text-foreground">{run.title}</p>
      {run.notifyNote ? (
        <p className="text-xs leading-5 text-muted-foreground">{run.notifyNote}</p>
      ) : null}
      <p className="flex flex-nowrap items-center gap-x-2 overflow-x-auto whitespace-nowrap text-xs leading-5 tabular-nums text-muted-foreground">
        <span className="whitespace-nowrap">提交 {formatCommitCount(run)}</span>
        <span aria-hidden="true">·</span>
        <span className="whitespace-nowrap">排队 {formatCiQueue(run)}</span>
        <span aria-hidden="true">·</span>
        <span className="whitespace-nowrap">输入用量 {formatInputTokens(run)}</span>
      </p>
    </li>
  );
}

function RunSection({
  section,
  title,
  note,
  runs,
  empty,
  emphasis = false,
}: {
  section: PipelineSection;
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
          <h2 className="text-base font-medium text-foreground">{title}</h2>
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
            {runs.map((run) =>
              isPipelineRunLink(section) ? (
                <RunLinkRow key={run.id} run={run} />
              ) : (
                <RunDetailRow key={run.id} run={run} />
              ),
            )}
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
    <section aria-label="流水线" className="grid min-w-0 gap-4 rounded-xl border p-4">
      <div className="flex items-center gap-3">
        <h2 className="min-w-0 flex-1 text-base font-medium">流水线</h2>
        <Button variant="outline" size="sm" disabled={refreshDisabled} onClick={onRefresh}>
          <RefreshIcon refreshing={pending} />
          刷新
        </Button>
      </div>
      <div className="grid min-w-0 gap-6">{children}</div>
    </section>
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
          section="needsAction"
          title="要你拍的"
          note="下面卡住的单只放链接。"
          runs={groups.stuck}
          empty="现在没有要你拍的"
          emphasis
        />
        <RunSection section="running" title="在跑的" runs={groups.running} empty="现在没有在跑的" />
        <RunSection section="stuck" title="卡住的" runs={groups.stuck} empty="现在没有卡住的" />
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

export function PipelineRunsSection() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <PipelineFrame pending={false} refreshDisabled onRefresh={() => {}}>
        <p className="text-sm text-muted-foreground">还没有连上的电脑。</p>
      </PipelineFrame>
    );
  }
  return <PipelineConnected environmentId={environmentId} />;
}
