import { useAtomValue } from "@effect/atom-react";
import type { ChildSummaryListItem, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { deriveCompletedBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, MessagesSquareIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { RuntimeSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";

import { useNowMinute } from "../../hooks/useNowMinute";
import { deriveThreadPendingBackgroundTasks } from "../ChatView.logic";
import { useThreadProjection } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { AgentElapsed } from "./AgentElapsed";
import {
  backgroundWorkRowsFromChildren,
  backgroundWorkRowsFromCommands,
  backgroundWorkRowsFromSubagents,
  backgroundWorkSecondLine,
  backgroundWorkStatusWord,
  isActiveBackgroundWork,
  presentBackgroundWorkSection,
  BACKGROUND_WORK_SCROLL_AFTER,
  type BackgroundWorkRowInput,
} from "./threadDetailsTasks.logic";

/** Reads a child summary row into the shape the section model wants. */
function childSessionOf(item: ChildSummaryListItem) {
  return {
    threadId: item.threadId,
    title: item.title ?? null,
    phase: item.phase,
    activity: item.activity,
    needsYou: item.needsYou,
    reason: item.reason,
  };
}

const SOURCE_ICONS = {
  subagent: BotIcon,
  command: TerminalIcon,
  child: MessagesSquareIcon,
} as const;

function agentSlotInitial(row: BackgroundWorkRowInput): string | null {
  if (row.driver === null) return null;
  const name = PROVIDER_DISPLAY_NAMES[row.driver];
  return name !== undefined && name.length > 0 ? name.charAt(0).toLocaleUpperCase() : null;
}

function statusDotClass(row: BackgroundWorkRowInput): string {
  switch (row.status) {
    case "running":
    case "pending":
      return "fa-dot fa-dot--running";
    case "waiting":
    case "needs_approval":
    case "needs_answer":
      return "fa-dot fa-dot--ring";
    case "failed":
      return "fa-dot fa-dot--error";
    default:
      return "fa-dot";
  }
}

function BackgroundTaskStopButton(props: {
  readonly row: BackgroundWorkRowInput;
  readonly environmentId: EnvironmentId;
  readonly stopping: boolean;
  readonly onStoppingStart: (id: string) => void;
  readonly onStoppingClear: (id: string) => void;
}) {
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow, {
    reportFailure: false,
  });

  const { stop: target } = props.row;
  if (target === null) return null;

  const stop = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (props.stopping) return;
    props.onStoppingStart(props.row.id);
    const result =
      target.kind === "workflow"
        ? await stopWorkflow({
            environmentId: props.environmentId,
            input: { threadId: target.threadId, subagentId: target.subagentId },
          })
        : await interruptTurn({
            environmentId: props.environmentId,
            input: { threadId: target.threadId, subagentId: target.subagentId },
          });
    if (result._tag === "Failure") {
      // Failed stops roll back immediately; successful stops stay in "正在停止" until the
      // projection removes the row from active status.
      props.onStoppingClear(props.row.id);
      const failure = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: target.kind === "workflow" ? "无法停止工作流" : "无法停止后台任务",
          description: failure instanceof Error ? failure.message : "这条后台任务还在运行。",
        }),
      );
    }
  };

  return (
    <button
      type="button"
      className="fa-icon-btn ade-touch-target"
      aria-label={props.stopping ? "正在停止" : `停止 ${props.row.title}`}
      disabled={props.stopping}
      onClick={(event) => void stop(event)}
    >
      <SquareIcon className="fa-ic fill-current" aria-hidden />
    </button>
  );
}

function BackgroundTaskRow(props: {
  readonly row: BackgroundWorkRowInput;
  readonly environmentId: EnvironmentId;
  readonly stopping: boolean;
  readonly onStoppingStart: (id: string) => void;
  readonly onStoppingClear: (id: string) => void;
  readonly onOpen: (row: BackgroundWorkRowInput) => void;
}) {
  const { row } = props;
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const status = backgroundWorkStatusWord(row.status);
  const secondLine = backgroundWorkSecondLine(row, nowMs);
  const active = isActiveBackgroundWork(row.status);
  const stopping = active && props.stopping;
  const statusText = stopping ? "正在停止" : row.status === "running" ? null : status.label;
  const TypeIcon = SOURCE_ICONS[row.source];
  const initial = agentSlotInitial(row);
  const secondLineNodes: ReactNode[] = [];
  const secondLineFull = secondLine?.map((segment) => segment.text).join("") ?? "";
  if (secondLine !== null) {
    let offset = 0;
    for (const segment of secondLine) {
      secondLineNodes.push(
        <span key={offset} className={cn(segment.bad && "bad")}>
          {segment.text}
        </span>,
      );
      offset += segment.text.length;
    }
  }
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-label={row.title}
        className="fa-task"
        data-background-task
        data-background-task-status={row.status}
        onClick={() => props.onOpen(row)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onOpen(row);
          }
        }}
      >
        <span className={cn("ty", status.failed && "is-bad")}>
          <TypeIcon className="fa-ic" aria-hidden />
        </span>
        <span className="t">
          <Tooltip>
            <TooltipTrigger render={<span className="x" />}>{row.title}</TooltipTrigger>
            <TooltipPopup side="top">{row.title}</TooltipPopup>
          </Tooltip>
        </span>
        <span className="end">
          {initial !== null ? (
            <span className="fa-agent" aria-hidden>
              {initial}
              <span className={statusDotClass(row)} />
            </span>
          ) : (
            <span className={statusDotClass(row)} aria-hidden />
          )}
          {statusText !== null ? (
            <span className={cn("st", !stopping && status.failed && "is-bad")}>{statusText}</span>
          ) : null}
          {row.startedAt !== null ? (
            <span className="tm">
              <AgentElapsed
                agent={{
                  // Only subagent and command rows carry startedAt, and both use the subagent
                  // status vocabulary, so the runtime type holds here.
                  status: row.status as RuntimeSubagentStatus,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                }}
                compact
              />
            </span>
          ) : null}
          {active ? (
            <BackgroundTaskStopButton
              row={row}
              environmentId={props.environmentId}
              stopping={stopping}
              onStoppingStart={props.onStoppingStart}
              onStoppingClear={props.onStoppingClear}
            />
          ) : null}
        </span>
        {secondLineNodes.length > 0 ? (
          <Tooltip>
            <TooltipTrigger render={<span className="sub" />}>{secondLineNodes}</TooltipTrigger>
            <TooltipPopup side="top">{secondLineFull}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The 后台任务 section: active and errored background work for this session, with non-failed
 * finished entries folded into a count. Reads the thread projection and child summaries directly.
 */
export function ThreadDetailsTasks(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadProjection = useThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const projection = threadProjection?.projection ?? null;
  const navigate = useNavigate();
  const canOperateWorkflow = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(props.environmentId),
  );
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [completedOpen, setCompletedOpen] = useState(false);

  // The same roster the composer banner reads, so the count here and there agree.
  const pendingTasks = deriveThreadPendingBackgroundTasks(projection);
  const childrenQuery = useEnvironmentQuery(
    orchestrationEnvironment.commandChildren({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const children = childrenQuery.data?.children ?? [];

  if (projection === null) return null;

  const sessionDriver =
    projection.providerThreads.find(
      (entry) => entry.id === projection.thread.activeProviderThreadId,
    )?.driver ??
    projection.providerThreads.at(-1)?.driver ??
    projection.providerSessions.at(-1)?.driver ??
    null;

  const subagentRows = backgroundWorkRowsFromSubagents(projection.subagents, {
    canOperateWorkflow,
  });
  const shownChildThreadIds = new Set(
    subagentRows
      .map((row) => row.childThreadId)
      .filter((id): id is NonNullable<typeof id> => id !== null)
      .map(String),
  );
  const finishedCommandTasks = deriveCompletedBackgroundWork({
    providerThreads: projection.providerThreads,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
  });
  const commandRows = backgroundWorkRowsFromCommands(
    [...pendingTasks, ...finishedCommandTasks],
    sessionDriver,
  );
  const childRows = backgroundWorkRowsFromChildren(
    children.map(childSessionOf),
    shownChildThreadIds,
  );
  const section = presentBackgroundWorkSection([...subagentRows, ...commandRows, ...childRows]);
  const visibleRows = [...section.active, ...section.failed];

  const markStopping = (id: string) =>
    setStoppingIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });

  const clearStopping = (id: string) =>
    setStoppingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const openRow = (row: BackgroundWorkRowInput) => {
    // The detail pane lands with the next slice; a child session is already a place worth opening.
    if (row.childThreadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, row.childThreadId)),
    });
  };

  const scrollable = visibleRows.length > BACKGROUND_WORK_SCROLL_AFTER;
  const completedCount = section.completed.length;

  let rows: ReactNode;
  if (visibleRows.length === 0 && completedCount === 0) {
    rows = <li className="note">没有后台任务</li>;
  } else {
    rows = (
      <>
        {visibleRows.map((row) => (
          <BackgroundTaskRow
            key={row.id}
            row={row}
            environmentId={props.environmentId}
            stopping={stoppingIds.has(row.id)}
            onStoppingStart={markStopping}
            onStoppingClear={clearStopping}
            onOpen={openRow}
          />
        ))}
        {completedCount === 0 ? null : (
          <>
            {completedOpen
              ? section.completed.map((row) => (
                  <BackgroundTaskRow
                    key={row.id}
                    row={row}
                    environmentId={props.environmentId}
                    stopping={false}
                    onStoppingStart={markStopping}
                    onStoppingClear={clearStopping}
                    onOpen={openRow}
                  />
                ))
              : null}
            <li>
              <button
                type="button"
                className="note ade-touch-target"
                data-completed-count
                aria-expanded={completedOpen}
                onClick={() => setCompletedOpen((open) => !open)}
              >
                已完成 {completedCount}
              </button>
            </li>
          </>
        )}
      </>
    );
  }

  return (
    <section
      className="fa-sec"
      aria-labelledby="thread-details-tasks-heading"
      data-thread-details-tasks
    >
      <div className="fa-sec__h" id="thread-details-tasks-heading">
        后台任务
      </div>
      <div className="fa-sec__b">
        <ul
          aria-label="后台任务"
          data-background-task-list
          className={cn("m-0 list-none p-0", scrollable && "is-scrollable")}
        >
          {rows}
        </ul>
      </div>
    </section>
  );
}
