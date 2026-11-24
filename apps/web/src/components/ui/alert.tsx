import { cva, type VariantProps } from "class-variance-authority";
import { Children, isValidElement } from "react";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";

const alertVariants = cva("fa-strip", {
  defaultVariants: {
    surface: "default",
    variant: "default",
  },
  variants: {
    surface: {
      default: "",
      glass: "",
    },
    variant: {
      default: "",
      sidebar: "",
      error: "fa-strip--danger",
      info: "fa-strip--info",
      success: "fa-strip--success",
      warning: "fa-strip--warning",
    },
  },
});

function alertChildSlot(child: React.ReactElement): string | undefined {
  const propsSlot = (child.props as Record<string, string | undefined>)["data-slot"];
  if (propsSlot) {
    return propsSlot;
  }

  const type = child.type as { displayName?: string; name?: string };
  switch (type.displayName ?? type.name) {
    case "AlertAction":
      return "alert-action";
    case "AlertTitle":
      return "alert-title";
    case "AlertDescription":
      return "alert-description";
    default:
      return undefined;
  }
}

/** The strip carries its meaning in the marker alone, so a semantic Alert without one gets this. */
const DEFAULT_MARKERS = {
  error: <CircleAlertIcon aria-hidden />,
  info: <InfoIcon aria-hidden />,
  success: <CircleCheckIcon aria-hidden />,
  warning: <TriangleAlertIcon aria-hidden />,
} as const;

function Alert({
  className,
  variant,
  surface,
  controlAlignment = "center",
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    controlAlignment?: "center" | "first-line";
  }) {
  const icon: React.ReactNode[] = [];
  const content: React.ReactNode[] = [];
  const action: React.ReactNode[] = [];

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) {
      content.push(child);
      return;
    }
    const slot = alertChildSlot(child);
    if (slot === "alert-action") {
      action.push(child);
    } else if (slot === "alert-title" || slot === "alert-description") {
      content.push(child);
    } else {
      icon.push(child);
    }
  });

  if (icon.length === 0 && variant != null && variant in DEFAULT_MARKERS) {
    icon.push(DEFAULT_MARKERS[variant as keyof typeof DEFAULT_MARKERS]);
  }

  return (
    <div
      className={cn(
        alertVariants({ surface, variant }),
        controlAlignment === "first-line" && "items-start",
        className,
      )}
      data-slot="alert"
      data-variant={variant ?? "default"}
      role="alert"
      {...props}
    >
      {icon.length > 0 && (
        <div
          className={cn(
            "mk items-center justify-center [&>svg]:size-4",
            controlAlignment === "first-line" ? "h-5 self-start" : "self-center",
            (variant === undefined || variant === "default" || variant === "sidebar") &&
              "text-muted-foreground",
          )}
        >
          {icon}
        </div>
      )}
      {content.length > 0 && <div className="grow flex min-w-0 flex-col gap-1">{content}</div>}
      {action.length > 0 && (
        <div
          className={cn(
            "flex shrink-0 flex-wrap items-center justify-end gap-1",
            controlAlignment === "first-line" ? "self-start" : "self-center",
          )}
        >
          {action}
        </div>
      )}
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={className} data-slot="alert-title" {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      data-slot="alert-description"
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex gap-1", className)} data-slot="alert-action" {...props} />;
}

AlertTitle.displayName = "AlertTitle";
AlertDescription.displayName = "AlertDescription";
AlertAction.displayName = "AlertAction";

export { Alert, AlertTitle, AlertDescription, AlertAction };
