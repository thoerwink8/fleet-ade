import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ControlledOpenContext, renderRetainedPopup } from "~/components/ui/dialog";

function Sheet<Payload>(props: SheetPrimitive.Root.Props<Payload>) {
  return (
    <ControlledOpenContext value={props.open}>
      <SheetPrimitive.Root {...props} />
    </ControlledOpenContext>
  );
}

const SheetPortal = SheetPrimitive.Portal;

// A sheet opened from inside a z-50 route modal has to sit above it; docked sheets stay at --z-sheet (46).
type SheetLayer = "base" | "nested";

function SheetBackdrop({
  className,
  layer = "base",
  ...props
}: SheetPrimitive.Backdrop.Props & { layer?: SheetLayer }) {
  return (
    <SheetPrimitive.Backdrop
      className={cn("ade-sheet-backdrop", className)}
      data-layer={layer}
      data-slot="sheet-backdrop"
      // Base UI skips the backdrop of a dialog rendered inside another dialog tree; the app shell is one.
      forceRender
      {...props}
    />
  );
}

function SheetViewport({
  className,
  side,
  variant = "default",
  layer = "base",
  ...props
}: SheetPrimitive.Viewport.Props & {
  side?: "right" | "left" | "top" | "bottom";
  variant?: "default" | "inset";
  layer?: SheetLayer;
}) {
  return (
    <SheetPrimitive.Viewport
      className={cn("ade-sheet-viewport", className)}
      data-layer={layer}
      data-side={side}
      data-slot="sheet-viewport"
      data-variant={variant}
      {...props}
    />
  );
}

function SheetPopup({
  className,
  children,
  showCloseButton = true,
  keepMounted = false,
  transitionDurationMs,
  side = "right",
  variant = "default",
  layer = "base",
  style,
  ...props
}: SheetPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  keepMounted?: boolean;
  transitionDurationMs?: number;
  side?: "right" | "left" | "top" | "bottom";
  variant?: "default" | "inset";
  layer?: SheetLayer;
}) {
  const transitionStyle =
    transitionDurationMs === undefined
      ? undefined
      : ({ transitionDuration: `${transitionDurationMs}ms` } satisfies CSSProperties);
  const instant = transitionDurationMs === 0;

  return (
    <SheetPortal keepMounted={keepMounted}>
      <SheetBackdrop
        data-instant={instant ? "" : undefined}
        layer={layer}
        style={transitionStyle}
      />
      <SheetViewport side={side} variant={variant} layer={layer}>
        <SheetPrimitive.Popup
          className={cn("fa-drawer ade-sheet-popup", className)}
          data-instant={instant ? "" : undefined}
          data-side={side}
          data-slot="sheet-popup"
          data-variant={variant}
          render={keepMounted ? undefined : renderRetainedPopup}
          style={{ ...transitionStyle, ...style }}
          {...props}
        >
          {children}
          {showCloseButton && (
            <SheetPrimitive.Close
              aria-label="关闭"
              className="absolute end-2 top-2"
              render={<Button size="md" icon variant="ghost" />}
            >
              <XIcon />
            </SheetPrimitive.Close>
          )}
        </SheetPrimitive.Popup>
      </SheetViewport>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("ade-sheet-header", className)} data-slot="sheet-header" {...props} />;
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      className={cn("ade-sheet-title font-medium text-dialog-title", className)}
      data-slot="sheet-title"
      {...props}
    />
  );
}

function SheetDescription({
  className,
  size = "default",
  ...props
}: SheetPrimitive.Description.Props & { size?: "default" | "prose" }) {
  return (
    <SheetPrimitive.Description
      className={cn(
        "ade-sheet-description",
        size === "prose" ? "text-prose" : "text-sm",
        className,
      )}
      data-slot="sheet-description"
      {...props}
    />
  );
}

export {
  Sheet,
  SheetPortal,
  SheetBackdrop,
  SheetBackdrop as SheetOverlay,
  SheetPopup,
  SheetPopup as SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
};
