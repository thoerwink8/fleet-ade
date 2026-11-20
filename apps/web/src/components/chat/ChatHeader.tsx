import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, FlagOffIcon, SettingsIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { useClientSettings } from "../../hooks/useSettings";
import { issueNumberFromBranch } from "./threadHeaderMeta.logic";
import { ThreadHeaderChips } from "./ThreadHeaderMeta";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeThreadLinkOrigin?: string | null | undefined;
  isCommander?: boolean | undefined;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
  onOpenCommanderSettings?: (() => void) | undefined;
  onUnmarkCommander?: (() => void) | undefined;
  onFindInThread?: ((threadRef: ScopedThreadRef) => void) | undefined;
  /** The thread's branch, as a tag after the title. */
  branch?: string | null | undefined;
  pullRequest?: Pick<ThreadLinkedPullRequest, "number" | "url"> | null | undefined;
  /** Sits at the right edge, left of the window's panel toggles. */
  trailing?: ReactNode;
}

function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  activeThreadLinkOrigin,
  isCommander = false,
  isServerThread,
  activeProject,
  parentThreadLink,
  onOpenThread,
  rightPanelOpen,
  onNewThreadInProject,
  onOpenProjectSettings,
  onOpenCommanderSettings,
  onUnmarkCommander,
  onFindInThread,
  branch = null,
  pullRequest = null,
  trailing,
}: ChatHeaderProps) {
  const activeProjectName = activeProject?.isScratch ? "无项目" : activeProject?.title;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const interfaceFont = useClientSettings((settings) => settings.fontFamilySans);
  const breadcrumbContainerRef = useRef<HTMLDivElement>(null);
  const [collapseParentTitle, setCollapseParentTitle] = useState(false);
  const [commanderMenuOpen, setCommanderMenuOpen] = useState(false);
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const isRenamingTitle = renamingTitle !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the breadcrumb list DOM via ResizeObserver, a frame and font loads to collapse the parent title
  useEffect(() => {
    const list = breadcrumbContainerRef.current?.querySelector("ol");
    if (!list || !parentThreadLink) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const width = Array.from(list.children).reduce(
        (total, item) => {
          const label = item.querySelector('[data-slot="workspace-breadcrumb-text"]');
          const ellipsis = item.querySelector("[data-parent-breadcrumb-ellipsis]");
          return (
            total +
            (item.firstElementChild?.getBoundingClientRect().width ?? 0) +
            (label && getComputedStyle(label).maxWidth === "none"
              ? label.scrollWidth - label.clientWidth
              : 0) -
            (ellipsis?.getBoundingClientRect().width ?? 0)
          );
        },
        gap * (list.children.length - 1),
      );
      setCollapseParentTitle(width > list.clientWidth);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener("loadingdone", measure);
    const stopObserving = observeResize(list, measure);
    return () => {
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", measure);
      stopObserving();
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Title, font and rename changes resize the breadcrumb text without resizing the list, so it re-measures.
    activeProjectName,
    activeThreadTitle,
    parentThreadLink,
    interfaceFont,
    isRenamingTitle,
  ]);
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveRenameCommit({
      title,
      originalTitle: renamingTitle ?? activeThreadTitle,
    });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "会话标题不能为空" });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "重命名会话失败",
          description: error instanceof Error ? error.message : "发生错误。",
        });
      }
    });
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
    onFind: onFindInThread,
  });
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  // A native menu takes the second click, so only the in-page menu lets a double-click reach here.
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    if (!isServerThread && onOpenProjectSettings === undefined) return;
    event.preventDefault();
    if (!isServerThread) {
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "project-settings", label: "项目设置", icon: "settings" }], {
          x: event.clientX,
          y: event.clientY,
        })
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
        });
      return;
    }
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  return (
    <div
      ref={breadcrumbContainerRef}
      className={cn("flex min-w-0 flex-1 items-center gap-2", rightPanelOpen ? "pr-10" : "pr-24")}
      onContextMenu={handleHeaderContextMenu}
    >
      <WorkspaceBreadcrumb
        ariaLabel="会话路径导航"
        className="min-w-0 shrink overflow-clip [overflow-clip-margin:2px]"
        listClassName="gap-2 sm:gap-2"
      >
        {activeProject ? (
          <>
            <WorkspaceBreadcrumbItem className="shrink font-normal text-secondary-label">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`在 ${activeProjectName} 中新建会话`}
                      onClick={onNewThreadInProject}
                      className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-secondary-label transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <ProjectFavicon project={activeProject} className="size-3.5" />
                  <WorkspaceBreadcrumbText className="max-w-40">
                    {activeProjectName}
                  </WorkspaceBreadcrumbText>
                </TooltipTrigger>
                <TooltipPopup side="top">在 {activeProjectName} 中新建会话</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        {parentThreadLink ? (
          <>
            <WorkspaceBreadcrumbItem>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`打开父会话：${parentThreadLink.title}`}
                      onClick={() => onOpenThread(parentThreadLink.threadId)}
                      className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <WorkspaceBreadcrumbText
                    aria-hidden
                    className={collapseParentTitle ? "w-0" : undefined}
                  >
                    {parentThreadLink.title}
                  </WorkspaceBreadcrumbText>
                  {collapseParentTitle ? (
                    <span aria-hidden data-parent-breadcrumb-ellipsis>
                      ...
                    </span>
                  ) : null}
                </TooltipTrigger>
                <TooltipPopup side="top">{parentThreadLink.title}</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
          {renamingTitle !== null ? (
            <input
              autoFocus
              dir="auto"
              aria-label="会话标题"
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.closest("button")
                ) {
                  setRenaming(null);
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ) : isServerThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${activeThreadTitle} 的会话操作`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                    className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              >
                <h2 className="min-w-0" dir={textDirection(activeThreadTitle)}>
                  <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
                </h2>
                <ChevronDownIcon
                  aria-hidden
                  data-thread-title-chevron
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <h2
                    aria-label={activeThreadTitle}
                    className="min-w-0 flex-1"
                    dir={textDirection(activeThreadTitle)}
                  />
                }
              >
                <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          )}
          {renamingTitle === null && activeThreadLinkOrigin ? (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="info" size="sm" />}>
                来源 {activeThreadLinkOrigin}
              </TooltipTrigger>
              <TooltipPopup side="top">
                由关联环境上的智能体在 {activeThreadLinkOrigin} 发起。
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {renamingTitle === null && isCommander ? (
            <Popover open={commanderMenuOpen} onOpenChange={setCommanderMenuOpen}>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label="指挥会话操作"
                    className="inline-flex shrink-0 cursor-pointer items-center rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              >
                <Badge variant="accent-chip" size="sm">
                  指挥
                </Badge>
              </PopoverTrigger>
              <PopoverPopup side="bottom" align="start" sideOffset={6}>
                <div className="flex w-48 flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      setCommanderMenuOpen(false);
                      onOpenCommanderSettings?.();
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-row text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <SettingsIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span>打开「指挥」设置</span>
                  </button>
                  <button
                    type="button"
                    disabled={!canOperateThread || !isServerThread || !onUnmarkCommander}
                    onClick={() => {
                      setCommanderMenuOpen(false);
                      onUnmarkCommander?.();
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-row text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                  >
                    <FlagOffIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span>取消指挥</span>
                  </button>
                </div>
              </PopoverPopup>
            </Popover>
          ) : null}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <ThreadHeaderChips
        issueNumber={issueNumberFromBranch(branch)}
        branch={branch}
        pullRequest={pullRequest}
      />
      {trailing ? <div className="ms-auto flex shrink-0 items-center">{trailing}</div> : null}
    </div>
  );
});
