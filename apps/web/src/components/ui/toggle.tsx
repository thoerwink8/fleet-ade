import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "~/lib/utils";

// Names stay so callers compile unchanged; each one paints a fleet-design button
// height (24 / 28 / 32). `pill` and `lg` had no caller anywhere and are gone.
const toggleVariants = cva("", {
  defaultVariants: {
    size: "default",
    variant: "default",
  },
  variants: {
    size: {
      compact: "fa-btn--sm",
      default: "",
      segmented: "fa-btn--xs",
      sm: "fa-btn--sm",
      xs: "fa-btn--xs",
    },
    variant: {
      default: "",
      ghost: "",
      outline: "fa-btn--secondary",
      segmented: "",
    },
  },
});

// Icon-only toggles are square; a toggle that carries text keeps its padding.
function containsText(node: React.ReactNode): boolean {
  if (typeof node === "string") return node.trim().length > 0;
  if (typeof node === "number") return true;
  if (Array.isArray(node)) return node.some(containsText);
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return containsText(node.props.children);
  }
  return false;
}

function Toggle({
  className,
  variant,
  size,
  children,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      className={cn(
        "fa-btn ade-toggle ade-touch-target ade-touch-target--bordered",
        !containsText(children) && "fa-btn--icon",
        toggleVariants({ size, variant }),
        className,
      )}
      data-slot="toggle"
      {...props}
    >
      {children}
    </TogglePrimitive>
  );
}

export { Toggle, toggleVariants };
