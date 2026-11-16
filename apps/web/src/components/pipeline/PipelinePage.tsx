import type { EnvironmentId, PipelineRun } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { pipelineEnvironment } from "../../state/pipeline";
import { useEnvironmentQuery } from "../../state/query";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { groupPipelineRuns, PIPELINE_STATUS_LABEL } from "./PipelinePage.logic";

function RunList({ runs }: { runs: ReadonlyArray<PipelineRun> }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">没有</p>;
  }
  return (
    <ul className="min-w-0">
      {runs.map((run) => (
        <li key={run.id} className="min-w-0 border-b py-3 last:border-b-0">
          <p className="min-w-0 text-sm font-medium break-words">{run.title}</p>
          <p className="mt-1 min-w-0 text-sm break-words text-muted-foreground">
            {`${PIPELINE_STATUS_LABEL[run.status]} · 单 ${run.issueNumber}${
              run.prNumber !== null ? ` · PR ${run.prNumber}` : ""
            }${run.stuckReason !== null ? ` · ${run.stuckReason}` : ""}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0">
      <h2 className="text-sm font-medium">{title}</h2>
      {note !== undefined ? <p className="mt-1 text-sm text-muted-foreground">{note}</p> : null}
      <div className="mt-2 min-w-0">{children}</div>
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
        <section className="grid min-w-0 gap-6">
          <h2 className="text-sm font-medium">流水线</h2>
          <Section title="在跑的">
            <RunList runs={groups.running} />
          </Section>
          <Section title="卡住的">
            <RunList runs={groups.stuck} />
          </Section>
          <Section title="最近开的 PR">
            <RunList runs={groups.recentPullRequests} />
          </Section>
        </section>
        <Section title="要你拍的" note="和上面卡住的是同一批。">
          <RunList runs={groups.stuck} />
        </Section>
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
