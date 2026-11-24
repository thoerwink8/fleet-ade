import { useAtomMount } from "@effect/atom-react";
import { asLaunchingThread } from "@t3tools/client-runtime/state/thread-inbox";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadTerminalStatusButton } from "../ThreadStatusIndicators";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { useDeadlinePassed } from "~/hooks/useDeadline";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { useDraggable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  canSnooze,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveSettledThreadTimestamp,
  resolveThreadActivityTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import { type EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  EllipsisIcon,
  GitBranchIcon,
  PinIcon,
  PinOffIcon,
  TerminalIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { useUiStateStore } from "../../uiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useNowSecond } from "../../hooks/useNowSecond";
import { vcsEnvironment, vcsBranchRevalidation } from "../../state/vcs";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { formatRelativeTimeLabel, parseTimestampDate } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  animateSidebarLayoutChanges,
  hasUnseenCompletion,
  resolveSidebarRowAccessibility,
  type SidebarDropVerb,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
  resolveThreadLastVisitedAt,
  isThreadAttentionRowDisabled,
  threadAttentionSubtitleText,
  type ThreadAttention,
  resolveWorkingStartedAt,
  useRetainedValue,
  withoutRemovedCheckout,
  useSidebarRowSubscriptionLease,
  setFileDragActive,
} from "../Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic";
import {
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  terminalStatusFromRunningIds,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
  ThreadSearchPullRequestNumber,
} from "../ThreadStatusIndicators";
import { pickSnoozePreset, resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { useThreadShell } from "../../state/entities";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "../ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import { useThreadHasUnsentDraft } from "../../composerDraftStore";
import {
  formatSidebarRowCounts,
  formatSidebarRowDisplayTitle,
  resolveSidebarRowPreviewText,
} from "./SidebarThreadRow.logic";

// The fields thread rows show. Provider status pushes refresh `checkedAt`,
// status and auth on every provider; leaving those out keeps each
// environment's map, and every memoized row, stable across them.
export type SidebarProviderEntry = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "enabled"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "models"
>;
// Subscribes to the minute tick itself, so only the label re-renders each
// minute. The minute is passed as the clock so it is the formatter's input.
function RelativeTimeLabel(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  return props.timestamp === null
    ? null
    : formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`));
}

function JumpHintBadge(props: { label: string }) {
  return (
    <Kbd aria-hidden data-jump-hint>
      {props.label}
    </Kbd>
  );
}

const JUMP_HINT_SLOT_CLASS_NAME =
  "[&>:not([data-jump-hint])]:invisible [&>:not([data-jump-hint])]:absolute";

function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) return null;
  return <WorkingDurationLabel startedMs={startedMs} />;
}

// Self-ticking so only this span re-renders each second, not the whole row;
// the shared tick lands every working row's update in the same frame.
function WorkingDurationLabel(props: { startedMs: number }) {
  const nowMs = useNowSecond();
  return (
    <span className="tabular-nums">{formatWorkingDurationLabel(nowMs - props.startedMs)}</span>
  );
}

function terminalProcessLabel(count: number): string {
  return `${count} 个终端进程正在运行`;
}

function extractReasoningEffortLabel(
  options: SidebarThreadSummary["modelSelection"]["options"],
): string | null {
  if (!options) return null;
  for (const entry of options) {
    if (
      typeof entry.value === "string" &&
      (entry.id === "reasoningEffort" ||
        entry.id === "effort" ||
        entry.id === "thought_level" ||
        entry.id === "thinking_level")
    ) {
      return entry.value;
    }
  }
  return null;
}

type RowStatusDot = {
  variant: "dot-attention" | "dot-active" | "dot-blocked" | "dot-waiting" | "dot-done";
  label: string;
};

// The row names its state. The mark is the library dot: running, needs, error, ring, or muted.
function resolveRowStatusDot(status: SidebarThreadStatus, hasRun: boolean): RowStatusDot {
  switch (status) {
    case "preparing":
    case "working":
      return { variant: "dot-active", label: "在做" };
    case "queued":
      return { variant: "dot-waiting", label: "排队" };
    case "waiting":
      return { variant: "dot-waiting", label: "等待中" };
    case "approval":
      return { variant: "dot-attention", label: "待批准" };
    case "input":
      return { variant: "dot-attention", label: "待输入" };
    case "limited":
    case "failed":
      return { variant: "dot-blocked", label: "卡住" };
    case "ready":
      return { variant: "dot-done", label: hasRun ? "做完" : "空闲" };
  }
}

function SidebarThreadTooltip({
  thread,
  displayTitle,
  project,
  projectDisplayName,
  environmentLabel,
  environmentMachine,
  providerEntry,
  providerEntryByInstanceId,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  reasoningEffort,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
}: {
  thread: SidebarThreadSummary;
  displayTitle: string;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntry: SidebarProviderEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  reasoningEffort: string | null;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  const modelWithEffort = reasoningEffort ? `${modelLabel} · ${reasoningEffort}` : modelLabel;
  const previousProviderNames = thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== modelInstanceId)
    .map((instanceId) => providerEntryByInstanceId.get(instanceId)?.displayName ?? instanceId);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  return (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
      <ThreadHoverCard
        title={displayTitle}
        footer={
          supportsMultiplePullRequests && thread.pullRequests.length > 0 ? (
            <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
              <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
            </div>
          ) : null
        }
      >
        {projectDisplayName ? (
          <div className="flex min-w-0 items-center gap-2">
            {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
            <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
          </div>
        ) : null}
        {environmentLabel ? (
          <div className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon
              kind={environmentMachine}
              className="size-3 shrink-0 stroke-muted-foreground"
            />
            <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
          </div>
        ) : null}
        {thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={thread.branch} className="flex" />
          </div>
        ) : null}
        {branchMismatch ? (
          <div className="flex min-w-0 items-start gap-2 text-warning">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
            <div className="min-w-0 flex-1 wrap-break-word">你当前检出的是另一个分支。</div>
          </div>
        ) : null}
        {driverKind ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={
                providerEntry?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
              }
              accentColor={providerEntry?.accentColor}
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
              showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
              badgeContent="none"
              badgeClassName="h-2 min-w-2 px-0"
              iconClassName="size-3 shrink-0 grayscale opacity-60"
            />
            <div className="min-w-0 truncate text-foreground/75">
              {showInstanceBadge && providerEntry
                ? `${modelWithEffort} · ${providerEntry.displayName}`
                : modelWithEffort}
            </div>
          </div>
        ) : null}
        {previousProviderNames.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeftIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              从 {previousProviderNames.join("、")} 交接而来
            </div>
          </div>
        ) : null}
        {terminalStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("size-3 shrink-0", terminalStatus.colorClass)}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {terminalProcessLabel(terminalProcessCount)}
            </div>
          </div>
        ) : null}
        {thread.runtime?.lastError ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              thread.runtime.lastErrorClass === "usage_limit" ? "text-warning" : "text-error",
            )}
          >
            <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
            <div className="min-w-0 truncate">
              {thread.runtime.lastErrorClass === "usage_limit" ? "已达到用量上限" : "发生错误"}
            </div>
          </div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

function agentMarkLetter(name: string | null): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length === 0) return "·";
  return [...trimmed][0] ?? "·";
}

type RowMark = { readonly dot: string; readonly label: string };

// Colored marks only. Queued and waiting use the library's hollow ring; idle rows have none.
function resolveRowMark(
  status: SidebarThreadStatus,
  isUnread: boolean,
  runtimeStatus: string | null,
  attention: ThreadAttention["category"] | null,
): RowMark | null {
  if (attention === "approval") return { dot: "fa-dot--needs", label: "待批准" };
  if (attention === "input") return { dot: "fa-dot--needs", label: "待输入" };
  if (attention === "failed") return { dot: "fa-dot--error", label: "失败" };
  if (attention === "limited") return { dot: "fa-dot--error", label: "受限" };
  if (attention === "completed") return { dot: "fa-dot--new", label: "未读" };
  switch (status) {
    case "failed":
      return { dot: "fa-dot--error", label: "失败" };
    case "limited":
      return { dot: "fa-dot--error", label: "受限" };
    case "approval":
      return { dot: "fa-dot--needs", label: "待批准" };
    case "input":
      return { dot: "fa-dot--needs", label: "待输入" };
    case "preparing":
      return { dot: "fa-dot--running", label: "正在设置" };
    case "working":
      return { dot: "fa-dot--running", label: "运行中" };
    case "queued":
      return { dot: "fa-dot--ring", label: "排队" };
    case "waiting":
      if (isUnread) return { dot: "fa-dot--new", label: "未读" };
      // Idle runtime is a finished session. The hollow ring is only for a live wait.
      return runtimeStatus !== null && runtimeStatus !== "idle"
        ? { dot: "fa-dot--ring", label: "等待中" }
        : null;
    case "ready":
      return isUnread ? { dot: "fa-dot--new", label: "未读" } : null;
  }
}

// Mounted only while the details surface is open, so its queries stay off the closed row.
function SidebarThreadDetails(props: {
  thread: SidebarThreadSummary;
  displayTitle: string;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  workspaceRoot: string | null;
  status: SidebarThreadStatus;
  attentionReason: string | null;
  pinned: boolean;
  hasUnsentDraft: boolean;
  scratchMachineLabel: string | null;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const { thread } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const gitCwd = thread.worktreePath ?? props.workspaceRoot;
  const branchTarget =
    (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? { environmentId: thread.environmentId, cwd: gitCwd }
      : null;
  const gitStatus = useEnvironmentQuery(
    branchTarget === null
      ? null
      : vcsEnvironment.branch({
          environmentId: branchTarget.environmentId,
          input: { cwd: branchTarget.cwd },
        }),
  );
  useAtomMount(vcsBranchRevalidation(branchTarget));
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const checkoutThread = withoutRemovedCheckout(thread, visibleGitStatus);
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelName(selectedModel, providerEntry?.driverKind)
    : thread.modelSelection.model;
  const reasoningEffort = extractReasoningEffortLabel(thread.modelSelection.options);
  const modelWithEffort = reasoningEffort ? `${modelLabel} · ${reasoningEffort}` : modelLabel;
  const previousProviderNames = thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== modelInstanceId)
    .map(
      (instanceId) => props.providerEntryByInstanceId.get(instanceId)?.displayName ?? instanceId,
    );
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const previewText = resolveSidebarRowPreviewText(thread);
  const rowCountsText = formatSidebarRowCounts({
    turnCount: thread.turnCount,
    pendingTaskCount: thread.pendingBackgroundTasks.length,
  });
  const statusDot = resolveRowStatusDot(
    props.status,
    thread.latestRun != null || (thread.visibleItemCount ?? 0) > 0,
  );
  const duration =
    props.status === "preparing" || props.status === "working" ? (
      <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
    ) : props.status === "waiting" ? (
      <WorkingDuration startedAt={thread.latestRun?.completedAt ?? null} />
    ) : null;
  const driverKind = providerEntry?.driverKind ?? null;
  return (
    <div data-testid="sidebar-thread-details">
      <div className="ade-thread-details__title">{props.displayTitle}</div>
      {props.attentionReason !== null ? (
        <div className="fa-cap">{props.attentionReason}</div>
      ) : null}
      {previewText !== null ? (
        <div className="fa-cap" data-testid="sidebar-row-preview" dir={textDirection(previewText)}>
          {previewText}
        </div>
      ) : null}
      <div className="fa-cap">
        {statusDot.label}
        {duration}
      </div>
      {driverKind ? (
        <div className="fa-cap">
          {showInstanceBadge && providerEntry
            ? `${modelWithEffort} · ${providerEntry.displayName}`
            : modelWithEffort}
        </div>
      ) : null}
      {rowCountsText !== null ? (
        <div className="fa-cap" data-testid="sidebar-row-counts">
          {rowCountsText}
        </div>
      ) : null}
      {props.projectDisplayName ? (
        <div className="fa-cap">
          {props.project ? (
            <ProjectFavicon
              project={props.project}
              className="mr-1 inline-flex size-3 shrink-0 align-text-bottom"
            />
          ) : null}
          {props.projectDisplayName}
        </div>
      ) : null}
      {props.environmentLabel ? (
        <div className="fa-cap">
          <EnvironmentMachineIcon kind={props.environmentMachine} className="mr-1 inline size-3" />
          {props.environmentLabel}
        </div>
      ) : null}
      {props.scratchMachineLabel ? <div className="fa-cap">{props.scratchMachineLabel}</div> : null}
      {checkoutThread.branch ? (
        <div className="fa-cap">
          <GitBranchIcon className="mr-1 inline size-3" />
          {checkoutThread.branch}
        </div>
      ) : null}
      {branchMismatch ? <div className="fa-cap">你当前检出的是另一个分支。</div> : null}
      {previousProviderNames.length > 0 ? (
        <div className="fa-cap">从 {previousProviderNames.join("、")} 交接而来</div>
      ) : null}
      {terminalStatus ? (
        <div className="fa-cap">
          <ThreadTerminalStatusButton
            threadRef={threadRef}
            terminalIds={runningTerminalIds}
            onThreadActivate={props.onThreadActivate}
          />
          {terminalProcessLabel(runningTerminalIds.length)}
        </div>
      ) : null}
      {thread.runtime?.lastError ? (
        <div className="fa-cap">
          {thread.runtime.lastErrorClass === "usage_limit" ? "已达到用量上限" : "发生错误"}
        </div>
      ) : null}
      {thread.commander === true ? <div className="fa-cap">指挥</div> : null}
      {props.pinned ? <div className="fa-cap">已置顶</div> : null}
      {props.hasUnsentDraft ? <div className="fa-cap">未发送的草稿</div> : null}
      {supportsMultiplePullRequests && thread.pullRequests.length > 0 ? (
        <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
      ) : null}
    </div>
  );
}

function RowIconButton(props: {
  label: string;
  tooltip: string;
  onClick: (event: ReactMouseEvent) => void;
  onPointerDown?: (event: ReactPointerEvent) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-label={props.label}
            onClick={props.onClick}
            onDoubleClick={(event) => event.stopPropagation()}
            onPointerDown={props.onPointerDown}
            className={cn("fa-icon-btn", props.className)}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function SnoozeMenuButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  timestampFormat: TimestampFormat;
  environmentId: EnvironmentId;
}) {
  const { open, onOpenChange, onSnooze, timestampFormat, environmentId } = props;
  const presets = open
    ? // oxlint-disable-next-line react/purity -- Presets are resolved only while the menu is open, so each opening reads a fresh time.
      resolveSnoozePresets(new Date(), timestampFormat, environmentId)
    : [];
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="暂缓会话"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="fa-icon-btn"
                />
              }
            />
          }
        >
          <ClockIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>暂缓会话</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={(event) => {
              event.stopPropagation();
              const picked = pickSnoozePreset(presets, preset.id, timestampFormat, environmentId);
              if (picked) onSnooze(picked);
            }}
          >
            {preset.label}
            <MenuItemDetail>{preset.whenLabel}</MenuItemDetail>
          </MenuItem>
        ))}
        {presets.length > 0 ? <MenuSeparator /> : null}
        <MenuItem
          onClick={async (event) => {
            event.stopPropagation();
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice);
          }}
        >
          自定义…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

export const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";
export const draftPenClassName = "size-3 shrink-0 text-warning-foreground";
// Desktop keeps 24px inline buttons with a 28px pseudo hit area; touch and mobile
// viewports expand the button box to >= 32x32 without changing row height.
export const SIDEBAR_ROW_BUTTON_HIT_AREA =
  "relative after:absolute after:inset-x-0 after:-inset-y-0.5 max-md:min-h-8 max-md:min-w-8 pointer-coarse:min-h-8 pointer-coarse:min-w-8 [&_svg]:pointer-events-none";

// useSortable memoizes on its `disabled` object, so a fresh one per render
// re-renders every row and marker on each sidebar update.
export const SIDEBAR_SORTABLE_DRAG_DISABLED = { draggable: true } as const;
const SIDEBAR_SORTABLE_DRAG_ENABLED = { draggable: false } as const;

// Takes the row's props rather than a render function: a closure from the
// sidebar body is new on every sidebar render, which rebuilt the bag and
// re-rendered every memoized row with it.
export function SortableThreadRow(
  props: Omit<SidebarThreadRowProps, "sortable"> & {
    sortableId: string;
    sortableDisabled: boolean;
    contextDrag: boolean;
  },
) {
  const { sortableId, sortableDisabled, contextDrag, ...rowProps } = props;
  const canOperateThread = useEnvironmentScope(
    rowProps.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled:
      sortableDisabled || !canOperateThread
        ? SIDEBAR_SORTABLE_DRAG_DISABLED
        : SIDEBAR_SORTABLE_DRAG_ENABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // dnd-kit memoizes each field but not the bag, so the memoized row would
  // rerender on every shell update without this.
  const bag = {
    listeners,
    setNodeRef,
    transform: contextDrag ? null : transform,
    transition: contextDrag && isDragging ? "transform 150ms ease-out" : transition,
    isDragging: isDragging && !contextDrag,
  };
  // The sidebar arranges rows from quiet shells, which hold still while a
  // thread streams; reading the live shell here re-renders only this row.
  const liveThread = useThreadShell(
    scopeThreadRef(rowProps.thread.environmentId, rowProps.thread.id),
  );
  // A runtime on the arranged copy but not the run-less live shell is the list's launch overlay.
  const thread =
    liveThread === null
      ? rowProps.thread
      : rowProps.thread.runtime !== null
        ? asLaunchingThread(liveThread)
        : liveThread;
  // Keyed by variant so a card/slim switch remounts the row.
  return <SidebarThreadRow key={rowProps.variant} {...rowProps} thread={thread} sortable={bag} />;
}
export type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";
const dropVerbBadge: Record<SidebarDropVerb, ReactNode> = {
  pin: (
    <>
      <PinIcon aria-hidden className="size-3" />
      置顶
    </>
  ),
  unpin: (
    <>
      <PinOffIcon aria-hidden className="size-3" />
      取消置顶
    </>
  ),
  settle: (
    <>
      <CircleCheckIcon aria-hidden className="size-3" />
      收尾
    </>
  ),
  unsettle: (
    <>
      <Undo2Icon aria-hidden className="size-3" />
      取消收尾
    </>
  ),
  wake: (
    <>
      <AlarmClockOffIcon aria-hidden className="size-3" />
      唤醒
    </>
  ),
};

type SidebarThreadRowProps = {
  thread: SidebarThreadSummary;
  titleSuffix?: string | null | undefined;
  variant: "card" | "slim";
  navigationParent?: string | undefined;
  variantAction: SidebarSweepAction;
  settlementSupported: boolean;
  snoozeSupported: boolean;
  pinningSupported: boolean;
  isPinned: boolean;
  sortable?: SortableThreadRowBag | undefined;
  dropVerb: SidebarDropVerb | null;
  dragOverPinned: boolean;
  sweepAction: SidebarSweepAction | null;
  snoozeWakeLabelText: string | null;
  wokeAt: string | null;
  isActive: boolean;
  // Set on the active row only; scrolls it into view when a reveal is owed.
  revealRef?: ((row: HTMLElement, threadKey: string) => (() => void) | undefined) | undefined;
  // Unlike isActive, never true for the ancestor standing in for an open
  // subagent: drafts and PR clicks care about which composer is on screen.
  isRouteThread: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  scratchMachineLabel: string | null;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  timestampFormat: TimestampFormat;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onActionSweepStart: (
    threadRef: ScopedThreadRef,
    action: SidebarSweepAction,
    event: PointerEvent,
  ) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  onAcknowledgeWoke: (threadRef: ScopedThreadRef, visitedAt: string) => void;
  /** Set on rows inside the "等你处理" section. */
  attention?: (ThreadAttention & { readonly demoted?: boolean | undefined }) | undefined;
  /** Attention rows on a disconnected environment cannot be acted on until reconnected. */
  attentionOffline?: boolean | undefined;
  onFileDropThreads?: ((threadRef: ScopedThreadRef, files: File[]) => void) | undefined;
};

// Mounted only while renaming, so each rename starts uncommitted.
function ThreadRenameInput(props: {
  title: string;
  onTitleChange: (title: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={props.title}
      dir="auto"
      aria-label="会话标题"
      onChange={(event) => props.onTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCommit();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="ade-trow-rename"
    />
  );
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    isRenaming,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onAcknowledgeWoke,
    onFileDropThreads,
    onRenameTitleChange,
    onSettle,
    onActionSweepStart,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    onUnpin,
    openPullRequestsInRightPanel,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const { leaseLiveStatus, rowRef: leaseRowRef } = useSidebarRowSubscriptionLease(props.isActive);
  const { revealRef } = props;
  const rowRef = (row: HTMLElement | null) => {
    const stopReveal = row === null ? undefined : revealRef?.(row, threadKey);
    const releaseLease = leaseRowRef(row);
    if (!stopReveal) return releaseLease;
    return () => {
      stopReveal();
      releaseLease?.();
    };
  };
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isRouteThread;
  const handleDiscardDraftClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    discardComposerDraft(threadRef);
  };

  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;

  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus({
    ...thread,
    pendingRuntimeRequest: thread.source.pendingRuntimeRequest,
  });
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke =
    wokeAtDate !== null &&
    (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
    thread.settledOverride !== "settled";
  const topStatus =
    status === "queued"
      ? { label: "排队", icon: "waiting" as const, className: "text-muted-foreground" }
      : status === "preparing" || status === "working"
        ? {
            label:
              status === "preparing"
                ? "正在设置"
                : thread.goal?.status === "active"
                  ? "目标"
                  : "运行中",
            icon: "working" as const,
            className: "text-info-foreground",
          }
        : status === "waiting"
          ? {
              label: "等待中",
              icon: "waiting" as const,
              className: "text-muted-foreground",
            }
          : status === "approval"
            ? {
                label: "待批准",
                icon: "approval" as const,
                className: "text-warning-foreground",
              }
            : status === "input"
              ? {
                  label: "待输入",
                  icon: "input" as const,
                  className: "text-indigo-600 dark:text-indigo-300",
                }
              : status === "limited"
                ? {
                    label: "受限",
                    icon: "failed" as const,
                    className: "text-warning-foreground",
                  }
                : status === "failed"
                  ? {
                      label: "失败",
                      icon: "failed" as const,
                      className: "text-error-foreground",
                    }
                  : isWoke
                    ? {
                        label: "已唤醒",
                        icon: "woke" as const,
                        className: "text-warning-foreground",
                      }
                    : isUnread
                      ? {
                          label: "完成",
                          icon: "done" as const,
                          className: "text-success-foreground",
                        }
                      : null;
  const isWokeStatus = topStatus?.icon === "woke";
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const agentName = providerEntry?.displayName ?? thread.runtime?.providerName ?? null;
  const displayTitle = formatSidebarRowDisplayTitle(thread.title, props.titleSuffix ?? null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const attentionDisabled = isThreadAttentionRowDisabled({
    attention: props.attention,
    attentionOffline: props.attentionOffline,
  });
  const handleClick = (event: ReactMouseEvent) => {
    if (attentionDisabled) return;
    onThreadClick(event, threadRef);
  };
  const handleAcknowledgeWokeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (props.wokeAt === null) return;
    onAcknowledgeWoke(threadRef, props.wokeAt);
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (
      event.key === "F2" &&
      !isRenaming &&
      readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
    ) {
      event.preventDefault();
      onStartRename(threadRef, thread.title);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (attentionDisabled) return;
    onThreadActivate(threadRef);
  };
  const handleDoubleClick = (event: ReactMouseEvent) => {
    if (
      !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
      isRenaming ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    event.preventDefault();
    onStartRename(threadRef, thread.title);
  };
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = onFileDropThreads
    ? makeWorkspaceFileDropHandlers({
        setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      })
    : null;
  const handleSettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSettle(threadRef);
  };
  const handleActionPointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.stopPropagation();
    onActionSweepStart(threadRef, variantAction, event.nativeEvent);
  };
  const handleUnsettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsettle(threadRef);
  };
  const handleUnsnoozeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsnooze(threadRef);
  };
  const handleUnpinClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnpin(threadRef);
  };
  const handleSnoozePreset = (preset: Pick<SnoozePreset, "snoozedUntil">) => {
    onSnooze(threadRef, preset);
  };
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // The React Compiler caches render results on their inputs, so a clock read
  // here would stay frozen until `thread` changes and a queued-turn gate would
  // never reopen. The gate's clock is state, reset with the thread.
  const [snoozeGateClock, setSnoozeGateClock] = useState(() => ({
    thread,
    now: new Date().toISOString(),
  }));
  if (snoozeGateClock.thread !== thread) {
    // oxlint-disable-next-line react/purity -- Reseeds the snooze gate clock only in the render-phase adjustment that runs when the thread changes.
    setSnoozeGateClock({ thread, now: new Date().toISOString() });
  }
  const snoozeGateNow = snoozeGateClock.now;
  const snoozeGateExpiryMs = hasQueuedTurnStart(thread, { now: snoozeGateNow })
    ? Date.parse(thread.latestUserMessageAt ?? "") + QUEUED_TURN_START_GRACE_MS
    : Number.NaN;
  // A gate still closed past its expiry is held by runtime status, not time,
  // so no clock tick can open it.
  const snoozeGateOpensAt =
    Number.isFinite(snoozeGateExpiryMs) && snoozeGateExpiryMs > Date.parse(snoozeGateNow)
      ? snoozeGateExpiryMs + 50
      : null;
  const snoozeGateOpened = useDeadlinePassed(snoozeGateOpensAt);
  if (snoozeGateOpened && snoozeGateOpensAt !== null) {
    setSnoozeGateClock({ thread, now: new Date(snoozeGateOpensAt).toISOString() });
  }
  const showSnoozeButton =
    canOperateThread && props.snoozeSupported && canSnooze(thread, { now: snoozeGateNow });
  // Closing here, not just masking, keeps the menu from reopening when the button returns.
  if (snoozeMenuOpenRaw && !showSnoozeButton) setSnoozeMenuOpen(false);
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  const jumpHintLabel = snoozeMenuOpen ? null : props.jumpLabel;
  const handlePrClick = (event: ReactMouseEvent<HTMLElement>, targetUrl?: string) => {
    const url = targetUrl ?? pr?.url ?? currentLinkedPr?.url;
    if (!url) return;
    const showInRightPanel = targetUrl !== undefined || openPullRequestsInRightPanel;
    const openedInRightPanel = openPrLink(event, url, showInRightPanel ? threadRef : undefined);
    if (openedInRightPanel && showInRightPanel && !props.isRouteThread) {
      onThreadActivate(threadRef);
    }
  };

  const sortable = props.sortable;
  const sortableRootProps = sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          // A zero-height boundary also makes dnd-kit scale the source to
          // zero. Only projected peers use scaleY as a visibility sentinel.
          visibility:
            !sortable.isDragging && sortable.transform?.scaleY === 0
              ? ("hidden" as const)
              : undefined,
        },
        ...sortable.listeners,
      }
    : {};
  const destinationVerb = sortable?.isDragging
    ? props.dropVerb
    : props.sweepAction === "unsnooze"
      ? "wake"
      : props.sweepAction;
  const dragDestination =
    destinationVerb !== null ? (
      <span
        role="status"
        className="pointer-events-none ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-row font-medium text-primary"
      >
        {dropVerbBadge[destinationVerb]}
      </span>
    ) : null;

  const isCommander = thread.commander === true;
  const attentionReason =
    props.attention === undefined
      ? null
      : threadAttentionSubtitleText({
          attention: props.attention,
          attentionOffline: props.attentionOffline,
        });
  const needsYou = attentionReason !== null;
  const rowMark = resolveRowMark(
    status,
    isUnread,
    thread.runtime?.status ?? null,
    props.attention?.category ?? null,
  );
  const selected = props.isActive || isSelected || props.sweepAction !== null;
  const accessibility = resolveSidebarRowAccessibility({
    title: displayTitle,
    statusLabel: topStatus?.label ?? null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
    isCommander,
  });
  const showPin =
    props.isPinned && (!sortable?.isDragging || (props.dragOverPinned && props.dropVerb === null));
  const prBadgeShape = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const handlePrListClick = () => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
    if (!props.isRouteThread) onThreadActivate(threadRef);
  };
  const prBadge =
    prBadgeShape?.kind === "stack" || pr || currentLinkedPr ? (
      <ThreadPullRequestBadgeControl
        render={<button type="button" tabIndex={-1} className="fa-icon-btn ade-trow-pr" />}
        badge={prBadgeShape}
        pullRequests={thread.pullRequests}
        number={pr?.number ?? currentLinkedPr?.number}
        url={pr?.url ?? currentLinkedPr?.url}
        status={prStatus}
        onOpenList={handlePrListClick}
        onOpenPullRequest={handlePrClick}
      />
    ) : null;
  const detailProps = {
    thread,
    displayTitle,
    project: props.project,
    projectDisplayName: props.projectDisplayName,
    environmentLabel: props.environmentLabel,
    environmentMachine: props.environmentMachine,
    providerEntryByInstanceId: props.providerEntryByInstanceId,
    workspaceRoot: props.project?.workspaceRoot ?? null,
    status,
    attentionReason,
    pinned: props.isPinned,
    hasUnsentDraft,
    scratchMachineLabel: props.scratchMachineLabel,
    onThreadActivate,
  };
  const showSettle = props.settlementSupported && variantAction !== "unsnooze";
  const showUnsnooze = props.snoozeSupported && variantAction === "unsnooze";
  const activityTimestamp =
    variantAction === "unsettle"
      ? resolveSettledThreadTimestamp(thread)
      : resolveThreadActivityTimestamp(thread);

  return (
    <li
      data-thread-item={threadKey}
      {...sortableRootProps}
      {...(fileDropHandlers ?? {})}
      className={cn(
        "list-none [content-visibility:auto]",
        needsYou ? "[contain-intrinsic-size:auto_52px]" : "[contain-intrinsic-size:auto_32px]",
        sortable?.isDragging && "relative z-20",
      )}
    >
      <Tooltip
        disabled={snoozeMenuOpen || Boolean(sortable?.isDragging)}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      >
        <TooltipTrigger
          render={
            <div
              ref={rowRef}
              role="button"
              tabIndex={0}
              data-sidebar-row={threadKey}
              data-sidebar-parent={props.navigationParent}
              aria-label={accessibility.label}
              aria-current={accessibility.current}
              aria-selected={selected || undefined}
              aria-disabled={attentionDisabled || undefined}
              data-testid={variant === "card" ? "sidebar-row-card" : "sidebar-row-slim"}
              aria-busy={isRegeneratingTitle || undefined}
              className={cn(
                "fa-trow w-full text-left select-none",
                !needsYou && "fa-trow--1",
                isUnread && "ade-trow--unread",
                isFileDragOver && "ade-trow--file",
                sortable?.isDragging && "ade-trow--drag",
                attentionDisabled && "cursor-default",
              )}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          <span className="lead">
            <span className="fa-agent" aria-hidden>
              {agentMarkLetter(agentName)}
              {rowMark ? (
                <span className={cn("fa-dot", rowMark.dot)} role="img" aria-label={rowMark.label} />
              ) : null}
            </span>
          </span>
          <div className="min-w-0">
            {isRenaming ? (
              <ThreadRenameInput
                title={renamingTitle}
                onTitleChange={onRenameTitleChange}
                onCommit={() => onCommitRename(threadRef, renamingTitle)}
                onCancel={onCancelRename}
              />
            ) : (
              <div
                className={cn("t", isRegeneratingTitle && "ade-trow-title-pending")}
                dir={textDirection(displayTitle)}
                aria-hidden
              >
                {displayTitle}
              </div>
            )}
            {attentionReason !== null ? <div className="s">{attentionReason}</div> : null}
            {isRegeneratingTitle ? (
              <span role="status" className="sr-only">
                正在重新生成标题
              </span>
            ) : null}
          </div>
          <span className={cn("end", jumpHintLabel && JUMP_HINT_SLOT_CLASS_NAME)}>
            {sortable?.isDragging || props.sweepAction !== null ? (
              dragDestination
            ) : (
              <>
                {prBadge ? <span className="pr">{prBadge}</span> : null}
                <span className="tm">
                  {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                    <>
                      <AlarmClockIcon aria-hidden className="mr-1 inline size-3" />
                      {props.snoozeWakeLabelText}
                    </>
                  ) : isWokeStatus ? (
                    "已唤醒"
                  ) : (
                    <RelativeTimeLabel timestamp={activityTimestamp} />
                  )}
                </span>
                <span className="acts">
                  {showPin &&
                  props.pinningSupported &&
                  canOperateThread &&
                  !sortable?.isDragging ? (
                    <RowIconButton
                      label="取消置顶会话"
                      tooltip="取消置顶会话"
                      onClick={handleUnpinClick}
                    >
                      <PinIcon className="size-4" />
                    </RowIconButton>
                  ) : null}
                  {hasUnsentDraft ? (
                    <RowIconButton
                      label="丢弃草稿"
                      tooltip="丢弃草稿"
                      onClick={handleDiscardDraftClick}
                    >
                      <XIcon className="size-4" />
                    </RowIconButton>
                  ) : null}
                  {isWokeStatus ? (
                    <RowIconButton
                      label="忽略已唤醒通知"
                      tooltip="忽略已唤醒通知"
                      onClick={handleAcknowledgeWokeClick}
                    >
                      <AlarmClockIcon className="size-4" />
                    </RowIconButton>
                  ) : null}
                  {showSnoozeButton && variantAction === "settle" ? (
                    <SnoozeMenuButton
                      open={snoozeMenuOpen}
                      onOpenChange={setSnoozeMenuOpen}
                      onSnooze={handleSnoozePreset}
                      timestampFormat={props.timestampFormat}
                      environmentId={thread.environmentId}
                    />
                  ) : null}
                  {showUnsnooze ? (
                    <RowIconButton
                      label="立即唤醒会话"
                      tooltip="立即唤醒会话"
                      onClick={handleUnsnoozeClick}
                      onPointerDown={handleActionPointerDown}
                    >
                      <AlarmClockOffIcon className="size-4" />
                    </RowIconButton>
                  ) : null}
                  {showSettle ? (
                    variantAction === "unsettle" ? (
                      <RowIconButton
                        label="取消会话收尾"
                        tooltip="取消会话收尾"
                        onClick={handleUnsettleClick}
                        onPointerDown={handleActionPointerDown}
                      >
                        <Undo2Icon className="size-4" />
                      </RowIconButton>
                    ) : (
                      <RowIconButton
                        label="收尾会话"
                        tooltip="收尾会话"
                        onClick={handleSettleClick}
                        onPointerDown={handleActionPointerDown}
                      >
                        <CheckIcon className="size-4" />
                      </RowIconButton>
                    )
                  ) : null}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="会话详情"
                    className="fa-icon-btn ade-trow-details"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setDetailsOpen(true);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <EllipsisIcon className="size-4" />
                  </button>
                </span>
                {jumpHintLabel ? <JumpHintBadge label={jumpHintLabel} /> : null}
              </>
            )}
          </span>
        </TooltipTrigger>
        <TooltipPopup variant="panel" side="right" align="start" sideOffset={8}>
          {detailsOpen ? <SidebarThreadDetails {...detailProps} /> : null}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
});

// Attached only to the highlighted result, so React calls it each time the
// highlight lands on a different row: a new query, late rows replacing the first
// result, or arrow keys moving past the scrolled edge.
const scrollHighlightedResultIntoView = (node: HTMLLIElement | null) => {
  node?.scrollIntoView({ block: "nearest" });
};

export const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  isSettled: boolean;
  thread: SidebarThreadSummary;
  titleSuffix?: string | null | undefined;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  /** The query `searchMatch` was found for, which lags `searchQuery` while a search runs. */
  searchMatchQuery?: string;
  onHighlight: () => void;
  onSelect: () => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const thread =
    useThreadShell(scopeThreadRef(props.thread.environmentId, props.thread.id)) ?? props.thread;
  const displayTitle = formatSidebarRowDisplayTitle(thread.title, props.titleSuffix ?? null);
  const accessibility = resolveSidebarRowAccessibility({
    title: displayTitle,
    statusLabel: null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  // Results only drag out as chat context; the row keeps its own listbox attributes.
  const { listeners: dragListeners, setNodeRef: setDragNodeRef } = useDraggable({
    id: scopedThreadKey(threadRef),
  });
  const { leaseLiveStatus, rowRef: leaseRowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  const rowRef = (row: HTMLElement | null) => {
    setDragNodeRef(row);
    return leaseRowRef(row);
  };
  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const branchTarget =
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? { environmentId: thread.environmentId, cwd: gitCwd }
      : null;
  const gitStatus = useEnvironmentQuery(
    branchTarget === null
      ? null
      : vcsEnvironment.branch({
          environmentId: branchTarget.environmentId,
          input: { cwd: branchTarget.cwd },
        }),
  );
  useAtomMount(vcsBranchRevalidation(branchTarget));
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const checkoutThread = withoutRemovedCheckout(thread, visibleGitStatus);
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelName(selectedModel, providerEntry?.driverKind)
    : thread.modelSelection.model;
  const reasoningEffort = extractReasoningEffortLabel(thread.modelSelection.options);
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const onFileDropThreads = props.onFileDropThreads;
  const fileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
    addFiles: (files) => {
      onFileDropThreads(threadRef, files);
    },
    addFolders: () => {},
  });
  return (
    <li
      ref={props.isHighlighted ? scrollHighlightedResultIntoView : undefined}
      role="presentation"
      className="list-none"
      {...fileDropHandlers}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={rowRef}
              id={props.resultId}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={accessibility.current}
              aria-describedby={`${props.resultId}-pr`}
              aria-label={accessibility.label}
              {...dragListeners}
              onMouseMove={props.onHighlight}
              onClick={props.onSelect}
              className={cn(
                "group/sidebar-row group/v2-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                isFileDragOver && "ring-1 ring-inset ring-primary/70",
                isFileDragOver && !props.isRouteActive && "bg-sidebar-row-hover",
              )}
            />
          }
        >
          {props.project ? (
            <ProjectFavicon
              project={props.project}
              className={cn(
                "size-4 shrink-0 transition-opacity",
                props.isSettled &&
                  !props.isRouteActive &&
                  !props.isHighlighted &&
                  "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span
                  className={cn(
                    "min-w-0 truncate",
                    props.isSettled
                      ? "font-normal text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                      : "font-medium text-foreground",
                    (props.isHighlighted || props.isRouteActive) && "text-foreground",
                    thread.titleRegeneration != null && "opacity-55",
                  )}
                >
                  {displayTitle}
                </span>
                {thread.commander === true ? (
                  <Badge variant="info" size="row">
                    指挥
                  </Badge>
                ) : null}
              </span>
              <span id={`${props.resultId}-pr`} className="contents">
                <ThreadSearchPullRequestNumber
                  thread={thread}
                  query={props.searchQuery}
                  enabled={leaseLiveStatus}
                  settled={props.isSettled}
                />
              </span>
              <span className="min-w-8 shrink-0 text-right text-row text-muted-foreground/55 tabular-nums">
                <RelativeTimeLabel timestamp={resolveThreadActivityTimestamp(thread)} />
              </span>
            </span>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                size="row"
                match={{
                  source: props.searchMatch.source,
                  snippet: props.searchMatch.snippet,
                  query: props.searchMatchQuery ?? props.searchQuery,
                }}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={checkoutThread}
          displayTitle={displayTitle}
          project={props.project}
          projectDisplayName={props.projectDisplayName}
          environmentLabel={props.environmentLabel}
          environmentMachine={props.environmentMachine}
          providerEntry={providerEntry}
          providerEntryByInstanceId={props.providerEntryByInstanceId}
          showInstanceBadge={showInstanceBadge}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          reasoningEffort={reasoningEffort}
          branchMismatch={branchMismatch}
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
  );
});
