import type { ComponentPropsWithoutRef } from "react";
import { cn } from "~/lib/utils";

interface RightPanelResizeHandleProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  handlers: Record<string, unknown>;
  label: string;
}

export function RightPanelResizeHandle({
  handlers,
  label,
  className,
  ...props
}: RightPanelResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className={cn(
        "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize select-none",
        className,
      )}
      {...handlers}
      {...props}
    />
  );
}
