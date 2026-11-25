import { ListFilterIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import {
  useHideKeyboardShortcutHints,
  useVisibleShortcutLabel,
} from "~/hooks/useKeyboardShortcutHints";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";

import { SidebarInput, SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchShortcutLabel: string | null | undefined;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  searchInputRef,
  searchShortcutLabel,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const visibleSearchShortcutLabel = useVisibleShortcutLabel(searchShortcutLabel);
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;

  return (
    <div className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-sidebar-border/80 bg-sidebar-control-surface/90 px-3 text-row text-sidebar-foreground shadow-xs/30 transition-colors hover:border-sidebar-border hover:bg-sidebar-control-surface focus-within:border-ring/70 focus-within:bg-sidebar-control-surface focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/25">
      <SearchIcon className="size-3.5 shrink-0 text-(--sidebar-icon-color)" />
      <SidebarInput
        ref={searchInputRef}
        nativeInput
        type="search"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
        onKeyDown={onSearchKeyDown}
        placeholder="搜索会话"
        aria-label="搜索会话"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={resultsVisible}
        aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
        aria-activedescendant={
          activeResultExists ? `sidebar-thread-search-result-${activeSearchResultIndex}` : undefined
        }
        className="min-w-0 flex-1"
      />
      {isSearching ? (
        <Button
          type="button"
          size="xs"
          icon
          touchTarget="compact"
          variant="muted"
          className="shrink-0 max-md:-mr-2 pointer-coarse:-mr-2"
          aria-label="清除会话搜索"
          onClick={() => {
            onClearSearch();
            searchInputRef.current?.focus();
          }}
        >
          <XIcon className="size-3" />
        </Button>
      ) : visibleSearchShortcutLabel ? (
        <Kbd variant="outline">{visibleSearchShortcutLabel}</Kbd>
      ) : null}
    </div>
  );
}

export interface SidebarHeaderActionsProps {
  hasProjects: boolean;
  /** The project filter popup. It has no trigger of its own; the scope button opens it. */
  projectScope: ReactNode;
  projectScopeLabel: string;
  /** Wraps the scope button so the filter popup can anchor to it. */
  projectScopeAnchorRef: RefObject<HTMLSpanElement | null>;
  onOpenProjectScope: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadTooltipTitle?: string | undefined;
  newThreadSecondaryHint?: string | null | undefined;
}

export function SidebarHeaderActions({
  hasProjects,
  projectScope,
  projectScopeLabel,
  projectScopeAnchorRef,
  onOpenProjectScope,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadTooltipTitle,
  newThreadSecondaryHint,
}: SidebarHeaderActionsProps) {
  const hideKeyboardHints = useHideKeyboardShortcutHints();
  const visibleNewThreadShortcutLabel = hideKeyboardHints ? null : newThreadShortcutLabel;
  const newThreadBaseTitle = newThreadTooltipTitle ?? "新建会话";
  const newThreadLabel = visibleNewThreadShortcutLabel
    ? `${newThreadBaseTitle}（${visibleNewThreadShortcutLabel}）`
    : newThreadBaseTitle;

  return (
    <div className="ade-touch-row ade-touch-row--gap-3 flex shrink-0 items-center pointer-coarse:gap-3">
      {hasProjects ? (
        <span ref={projectScopeAnchorRef} className="flex min-w-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuButton
                  type="button"
                  aria-label={`按项目筛选会话，当前是${projectScopeLabel}`}
                  onClick={onOpenProjectScope}
                  // Hit testing must stay on the actual button; wrappers are not returned as buttons.
                  // oxlint-disable-next-line shadcn/no-restyle
                  className="ade-touch-target ade-touch-target--y max-w-40 min-w-0 shrink"
                />
              }
            >
              <ListFilterIcon />
              <span className="pointer-events-none min-w-0 truncate">{projectScopeLabel}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">按项目筛选会话</TooltipPopup>
          </Tooltip>
          {projectScope}
        </span>
      ) : null}
      <SidebarHeaderIconButton
        label="新建会话"
        tooltip={
          newThreadSecondaryHint && !hideKeyboardHints ? (
            <span className="flex flex-col gap-0.5">
              <span>{newThreadLabel}</span>
              <span className="text-muted-foreground">{newThreadSecondaryHint}</span>
            </span>
          ) : (
            newThreadLabel
          )
        }
        disabled={newThreadDisabled}
        onClick={onNewThread}
      >
        <SquarePenIcon />
      </SidebarHeaderIconButton>
    </div>
  );
}

function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon-sm"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative shrink-0", className)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
