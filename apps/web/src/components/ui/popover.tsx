import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "~/lib/utils";

import { renderClosingPositioner } from "./closing-positioner";

const PopoverCreateHandle = PopoverPrimitive.createHandle;

const Popover = PopoverPrimitive.Root;

function PopoverTrigger({ className, children, ...props }: PopoverPrimitive.Trigger.Props) {
  return (
    <PopoverPrimitive.Trigger className={className} data-slot="popover-trigger" {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  );
}

const popoverPopupWidthClassName = {
  auto: "",
  sm: "w-64",
  md: "w-80",
  lg: "w-96",
} as const;

type PopoverPadding = "default" | "compact" | "none";

function PopoverPopup({
  children,
  className,
  padding = "default",
  variant = "default",
  width = "auto",
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  collisionAvoidance,
  tooltipStyle = false,
  keepMounted = false,
  anchor,
  touchBackdrop = false,
  ...props
}: PopoverPrimitive.Popup.Props & {
  padding?: PopoverPadding;
  variant?: "default" | "panel";
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  collisionAvoidance?: PopoverPrimitive.Positioner.Props["collisionAvoidance"];
  tooltipStyle?: boolean;
  keepMounted?: PopoverPrimitive.Portal.Props["keepMounted"];
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  width?: keyof typeof popoverPopupWidthClassName;
  touchBackdrop?: boolean;
}) {
  // Viewport rekeys on close; persistent single-trigger forms need stable containers for drafts and submit
  // guards.
  const Viewport = keepMounted ? "div" : PopoverPrimitive.Viewport;
  return (
    <PopoverPrimitive.Portal keepMounted={keepMounted}>
      {touchBackdrop ? (
        // On touch, the backdrop consumes outside taps so closing cannot also activate the control beneath.
        <PopoverPrimitive.Backdrop
          className="fixed inset-0 z-[130] hidden pointer-coarse:block"
          data-slot="popover-backdrop"
        />
      ) : null}
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={variant === "panel" ? 0 : undefined}
        className={cn(
          "h-(--positioner-height) max-h-(--available-height) w-(--positioner-width) max-w-(--available-width)",
          // Kept-mounted positioners first paint at the window origin, so a transform transition slides them in from there.
          !keepMounted && "transition-transform data-instant:transition-none",
          variant === "panel"
            ? "z-(--z-sheet) w-[min(calc(var(--thread-details-panel-width)+--spacing(4)),calc(var(--anchor-width)---spacing(2)))] transition-[top] duration-150 ease-out data-instant:transition-[top] motion-reduce:transition-none motion-reduce:data-instant:transition-none"
            : "z-[130]",
        )}
        data-slot="popover-positioner"
        render={renderClosingPositioner}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) outline-none transition-[width,height,scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
            variant !== "panel" && "fa-pop",
            // default is the library card padding (16); compact and tooltip-style hints keep the base
            // popup padding (8), the same inset as a menu.
            variant !== "panel" &&
              (padding === "none"
                ? "ade-pop--flush"
                : padding === "default" && !tooltipStyle && "fa-pop--pad"),
            // Electron drag hit-testing ignores z-index; popups over a drag region would swallow hover.
            "[-webkit-app-region:no-drag]",
            tooltipStyle && "w-fit text-balance text-xs",
            width !== "auto" && ["max-w-[calc(100vw-2rem)]", popoverPopupWidthClassName[width]],
            variant === "panel" &&
              "w-full overflow-visible border-0 bg-transparent shadow-none [backdrop-filter:none] [-webkit-backdrop-filter:none]",
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          <Viewport
            className={cn(
              "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) py-0 [--viewport-inline-padding:0px] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
              !tooltipStyle && "not-data-transitioning:overflow-y-auto",
              variant === "panel" &&
                "overflow-visible py-2 [--viewport-inline-padding:--spacing(2)]",
            )}
            data-slot="popover-viewport"
          >
            {children}
          </Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      className={cn("font-medium text-sm leading-none", className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

export {
  PopoverCreateHandle,
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverPopup as PopoverContent,
  PopoverTitle,
  PopoverClose,
};
