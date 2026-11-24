import type * as React from "react";

import { cn } from "~/lib/utils";

const emptySizeClassName = {
  compact: "p-4",
  "compact-prose": "p-4",
  default: "",
  hero: "md:p-12",
} as const;

function Empty({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: keyof typeof emptySizeClassName }) {
  return (
    <div
      className={cn("fa-empty min-w-0 flex-1 justify-center", emptySizeClassName[size], className)}
      data-slot="empty"
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex w-full max-w-[min(22.5rem,100%)] min-w-0 flex-col items-center gap-1",
        className,
      )}
      data-slot="empty-header"
      {...props}
    />
  );
}

function EmptyMedia({
  className,
  variant = "icon",
  ...props
}: React.ComponentProps<"div"> & { variant?: "icon" | "warning" }) {
  return (
    <div
      className={cn(
        "mb-4 flex shrink-0 items-center justify-center",
        variant === "warning" ? "text-warning" : "fa-muted",
        className,
      )}
      data-slot="empty-media"
      data-variant={variant}
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("fa-title", className)} data-slot="empty-title" {...props} />;
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("fa-control fa-muted max-w-90", className)}
      data-slot="empty-description"
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex w-full max-w-sm min-w-0 flex-col items-center gap-3", className)}
      data-slot="empty-content"
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
