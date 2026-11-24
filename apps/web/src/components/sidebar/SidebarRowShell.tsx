import { EllipsisIcon } from "lucide-react";
import type {
  ComponentPropsWithoutRef,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  Ref,
} from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Subscribes to the minute tick itself, so only the label re-renders each minute.
 * The minute is passed as the clock so it is the formatter's input.
 */
export function SidebarRelativeTimeLabel(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  return props.timestamp === null
    ? null
    : formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`));
}

/**
 * Compact 24px row icon button styled by `.fa-icon-btn` and expanded to an accessible
 * coarse-pointer hit area by `.ade-touch-target` inside `.ade-touch-row`.
 */
export function SidebarRowIconButton(props: {
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
            className={cn("fa-icon-btn ade-touch-target", props.className)}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

type SidebarRowLiAttrs = Omit<ComponentPropsWithoutRef<"li">, "ref" | "className"> & {
  [key: `data-${string}`]: string | undefined;
};

/**
 * Shared `.fa-trow` row shell used by both sidebar thread rows and sidebar draft rows.
 * Owns single-line/two-line height, hover/selected/focus styling, touch-row action spacing,
 * and the lazy details card (`TooltipPopup variant="panel"`).
 */
export function SidebarRowShell({
  liRef,
  liClassName,
  liProps,
  multiline,
  rowRef,
  rowKey,
  navigationParent,
  testId,
  ariaLabel,
  ariaCurrent,
  selected,
  disabled,
  busy,
  rowClassName,
  onClick,
  onDoubleClick,
  onKeyDown,
  onContextMenu,
  tooltipDisabled,
  detailsOpen,
  onDetailsOpenChange,
  detailsLabel,
  details,
  lead,
  body,
  endClassName,
  endOverride,
  endPrefix,
  meta,
  actions,
  endSuffix,
}: {
  liRef?: Ref<HTMLLIElement> | undefined;
  liClassName?: string | undefined;
  liProps?: SidebarRowLiAttrs | undefined;
  multiline?: boolean | undefined;
  rowRef?: Ref<HTMLDivElement> | undefined;
  rowKey: string;
  navigationParent?: string | undefined;
  testId?: string | undefined;
  ariaLabel: string;
  ariaCurrent?: "page" | undefined;
  selected?: boolean | undefined;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  rowClassName?: string | undefined;
  onClick?: ((event: ReactMouseEvent) => void) | undefined;
  onDoubleClick?: ((event: ReactMouseEvent) => void) | undefined;
  onKeyDown?: ((event: ReactKeyboardEvent) => void) | undefined;
  onContextMenu?: ((event: ReactMouseEvent) => void) | undefined;
  tooltipDisabled?: boolean | undefined;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
  detailsLabel: string;
  details: ReactNode;
  lead: ReactNode;
  body: ReactNode;
  endClassName?: string | undefined;
  endOverride?: ReactNode | null | undefined;
  endPrefix?: ReactNode | undefined;
  meta?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  endSuffix?: ReactNode | undefined;
}) {
  return (
    <li
      ref={liRef}
      {...liProps}
      className={cn(
        "list-none [content-visibility:auto]",
        multiline ? "[contain-intrinsic-size:auto_52px]" : "[contain-intrinsic-size:auto_32px]",
        liClassName,
      )}
    >
      <Tooltip disabled={tooltipDisabled} open={detailsOpen} onOpenChange={onDetailsOpenChange}>
        <TooltipTrigger
          render={
            <div
              ref={rowRef}
              role="button"
              tabIndex={0}
              data-sidebar-row={rowKey}
              data-sidebar-parent={navigationParent}
              aria-label={ariaLabel}
              aria-current={ariaCurrent}
              aria-selected={selected || undefined}
              aria-disabled={disabled || undefined}
              data-testid={testId}
              aria-busy={busy || undefined}
              className={cn(
                "fa-trow w-full text-left select-none",
                !multiline && "fa-trow--1",
                rowClassName,
              )}
              onClick={onClick}
              onDoubleClick={onDoubleClick}
              onKeyDown={onKeyDown}
              onContextMenu={onContextMenu}
            />
          }
        >
          <span className="lead">{lead}</span>
          <div className="min-w-0">{body}</div>
          <span className={cn("end", endClassName)}>
            {endOverride != null ? (
              endOverride
            ) : (
              <>
                {endPrefix}
                <span className="tm">{meta}</span>
                <span className="acts ade-touch-row ade-touch-row--gap-2 pointer-coarse:gap-2">
                  {actions}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={detailsLabel}
                    className="fa-icon-btn ade-trow-details ade-touch-target"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onDetailsOpenChange(true);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <EllipsisIcon className="size-4" />
                  </button>
                </span>
                {endSuffix}
              </>
            )}
          </span>
        </TooltipTrigger>
        <TooltipPopup variant="panel" side="right" align="start" sideOffset={8}>
          {detailsOpen ? details : null}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}
