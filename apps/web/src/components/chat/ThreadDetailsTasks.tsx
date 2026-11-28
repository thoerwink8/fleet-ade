import type { ChildSummaryListItem, EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
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
  };
}

const SOURCE_ICONS = {
  subagent: BotIcon,
  command: TerminalIcon,
  child: MessagesSquareIcon,
} as const;

function agentSlotInitial(row: BackgroundWorkRowInput): string | null {
  if (row.driver !== null) {
    const name = PROVIDER_DISPLAY_NAMES[row.driver];
    if (name !== undefined && name.length > 0) return name.charAt(0).toLocaleUpperCase();
  }
  // Only a child session has no provider of its own; the title initial still says whose row it is.
  const letter = row.title.trim().charAt(0);
  return letter.length === 0 ? null : letter.toLocaleUpperCase();
}

function statusDotClass(row: BackgroundWorkRowInput): string {
  switch (row.status) {
    case "running":
    case "pending":
      return "fa-dot fa-dot--running";
    case "waiting":
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
  readonly onStoppingChange: (id: string | null) => void;
}) {
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });

  if (props.row.stopThreadId === null) return null;

  const stop = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (props.stopping || props.row.stopThreadId === null) return;
    props.onStoppingChange(props.row.id);
    const input =
      props.row.subagentId === null
        ? { threadId: props.row.stopThreadId }
        : {
            threadId: props.row.stopThreadId,
            subagentId: props.row.subagentId as NodeId,
          };
    const result = await interruptTurn({
      environmentId: props.environmentId,
      input,
    });
    props.onStoppingChange(null);
    if (result._tag === "Failure") {
      // The row's live roster still shows the work running, so the word rolls itself back;
      // the toast carries the reason the server gave.
      const failure = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "无法停止后台任务",
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
      <SquareIcon className="fa-ic" aria-hidden />
    </button>
  );
}

function BackgroundTaskRow(props: {
  readonly row: BackgroundWorkRowInput;
  readonly environmentId: EnvironmentId;
  readonly stoppingId: string | null;
  readonly onStoppingChange: (id: string | null) => void;
  readonly onOpen: (row: BackgroundWorkRowInput) => void;
}) {
  const { row } = props;
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const status = backgroundWorkStatusWord(row.status);
  const secondLine = backgroundWorkSecondLine(row, nowMs);
  const stopping = props.stoppingId === row.id;
  const active = row.status === "pending" || row.status === "running" || row.status === "waiting";
  const TypeIcon = SOURCE_ICONS[row.source];
  const secondLineNodes: ReactNode[] = [];
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
          <span className="fa-agent" aria-hidden>
            {agentSlotInitial(row)}
            <span className={statusDotClass(row)} />
          </span>
          <span className={cn("st", status.failed && "is-bad")}>
            {stopping ? "正在停止" : status.label}
          </span>
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
              onStoppingChange={props.onStoppingChange}
            />
          ) : null}
        </span>
        {secondLineNodes.length > 0 ? <span className="sub">{secondLineNodes}</span> : null}
      </div>
    </li>
  );
}

/**
 * The 后台任务 section: active background work for this session, finished entries folded into a
 * count. It reads the thread's subagent roster, its provider-thread background commands, and its
 * child-session summaries; it never asks the server for anything the projection already knows.
 */
export function ThreadDetailsTasks(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadProjection = useThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const projection = threadProjection?.projection ?? null;
  const navigate = useNavigate();
  const [stoppingId, setStoppingId] = useState<string | null>(null);
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

  const subagentRows = backgroundWorkRowsFromSubagents(projection.subagents);
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
    projection.turnItems,
    props.threadId,
  );
  const childRows = backgroundWorkRowsFromChildren(
    children.map(childSessionOf),
    shownChildThreadIds,
  );
  const section = presentBackgroundWorkSection([...subagentRows, ...commandRows, ...childRows]);

  const openRow = (row: BackgroundWorkRowInput) => {
    // The detail pane lands with the next slice; a child session is already a place worth opening.
    if (row.childThreadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, row.childThreadId)),
    });
  };

  const scrollable = section.active.length > BACKGROUND_WORK_SCROLL_AFTER;
  const completedCount = section.completed.length + section.droppedCompleted;

  let rows: ReactNode;
  if (section.active.length === 0 && completedCount === 0) {
    rows = <li className="note">没有后台任务</li>;
  } else {
    rows = (
      <>
        {section.active.map((row) => (
          <BackgroundTaskRow
            key={row.id}
            row={row}
            environmentId={props.environmentId}
            stoppingId={stoppingId}
            onStoppingChange={setStoppingId}
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
                    stoppingId={stoppingId}
                    onStoppingChange={setStoppingId}
                    onOpen={openRow}
                  />
                ))
              : null}
            <li>
              <button
                type="button"
                className="note"
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
