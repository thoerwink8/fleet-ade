import { WorkLogBlock } from "./WorkLog";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { environmentThreadDetails } from "../../state/threads";
import {
  subagentGroupSummary,
  summarizeSubagentStatuses,
} from "@t3tools/client-runtime/state/subagent-display";
import { memo, use, useState } from "react";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { ChevronDownIcon, WorkflowIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";
import { SubagentElapsed, V2LifecycleRow } from "./V2LifecycleRow";
import { LinkRequestCard } from "./LinkRequestCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { subagentGroupTiming } from "./TimelineV2EventRow.logic";

export function V2EventTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "event" }> }) {
  const ctx = use(TimelineRowCtx);
  const { item, visibility } = row.projectedItem;
  if (item.type === "subagent" && (row.subagents?.length ?? 1) > 1) {
    return <V2SubagentGroup key={row.id} row={row} />;
  }
  if (item.type === "secret_request") {
    return (
      <SecretRequestCard
        environmentId={ctx.activeThreadEnvironmentId}
        item={item}
        visibility={visibility}
      />
    );
  }
  if (item.type === "link_request") {
    return (
      <LinkRequestCard
        environmentId={ctx.activeThreadEnvironmentId}
        item={item}
        visibility={visibility}
      />
    );
  }
  return (
    <V2LifecycleRow
      environmentId={ctx.activeThreadEnvironmentId}
      item={item}
      resourceSummary={row.resourceSummary}
      runs={ctx.runs}
      onOpenThread={ctx.onOpenThread}
    />
  );
}

const V2SubagentGroup = memo(function V2SubagentGroup({
  row,
}: {
  row: Extract<TimelineRow, { kind: "event" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const groupId = `subagent-group:${row.id}`;
  const [expanded, setExpanded] = useState(() =>
    ctx.workGroupViewState.expandedEntries.has(groupId),
  );
  const members = (row.subagents ?? [row.projectedItem]).flatMap(({ item }) =>
    item.type === "subagent" ? [item] : [],
  );
  const liveAgents = useAtomValue(
    environmentThreadDetails.threadAtom(
      scopeThreadRef(ctx.activeThreadEnvironmentId, row.projectedItem.item.threadId),
    ),
    (thread) => thread?.projection.subagents,
  );
  const agents = members.map((item) => {
    const live = liveAgents?.find((agent) => agent.id === item.subagentId);
    return {
      item,
      status: live?.status ?? item.status,
      startedAt: live?.startedAt ?? item.startedAt,
      completedAt: live?.completedAt ?? item.completedAt,
    };
  });
  const summary = subagentGroupSummary(agents);
  const label = `${members.length} 个子代理`;
  const statusSummary = summarizeSubagentStatuses(agents.map(({ status }) => status));
  const activeCount = agents.filter(({ status }) => isOrchestrationV2WorkActive(status)).length;
  const doneCount = agents.filter(({ status }) => status === "completed").length;
  const countsLabel = [
    activeCount > 0 ? `${activeCount} 在做` : null,
    doneCount > 0 ? `${doneCount} 做完` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const toggleExpanded = (open: boolean) => {
    ctx.onToggleWorkEntry(row.id, expanded);
    if (open) ctx.workGroupViewState.expandedEntries.add(groupId);
    else ctx.workGroupViewState.expandedEntries.delete(groupId);
    setExpanded(open);
  };
  return (
    <WorkLogBlock continues={row.continuesWorkLog}>
      <div className="my-2 overflow-hidden rounded-lg border border-border bg-card">
        <Collapsible open={expanded} onOpenChange={toggleExpanded} data-subagent-group>
          <CollapsibleTrigger
            aria-label={label}
            aria-description={statusSummary}
            className="flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left text-ui text-foreground"
          >
            <WorkflowIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium">并行子任务</span>
            <span
              className={cn(
                "shrink-0 text-meta tabular-nums",
                summary.failed ? "text-destructive" : "text-secondary-label",
              )}
            >
              {countsLabel || statusSummary}
            </span>
            <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
              <SubagentElapsed agent={subagentGroupTiming(agents)} />
            </span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          {/* Virtualized rows must settle before disclosure scroll anchoring resumes. */}
          <CollapsiblePanel animate={false}>
            {expanded ? (
              <div className="border-t border-border p-1">
                {members.map((item) => (
                  <V2LifecycleRow
                    environmentId={ctx.activeThreadEnvironmentId}
                    key={item.id}
                    item={item}
                    runs={ctx.runs}
                    onOpenThread={ctx.onOpenThread}
                  />
                ))}
              </div>
            ) : null}
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </WorkLogBlock>
  );
});
