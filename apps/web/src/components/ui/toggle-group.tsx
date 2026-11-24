import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "~/lib/utils";
import { type toggleVariants } from "~/components/ui/toggle";

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: "default",
  variant: "default",
});

function ToggleGroup({
  className,
  variant = "segmented",
  size: sizeProp,
  orientation = "horizontal",
  children,
  ...props
}: ToggleGroupPrimitive.Props & VariantProps<typeof toggleVariants>) {
  const size =
    sizeProp === undefined ? (variant === "segmented" ? "segmented" : "default") : sizeProp;
  const value = { size, variant };
  const isSegmented = variant === "segmented";
  return (
    <ToggleGroupPrimitive
      className={cn(isSegmented ? "fa-seg" : "fa-toggle-group", className)}
      data-size={size}
      data-slot="toggle-group"
      data-variant={variant}
      orientation={orientation}
      {...props}
    >
      <ToggleGroupContext value={value}>{children}</ToggleGroupContext>
    </ToggleGroupPrimitive>
  );
}

function Toggle({
  className,
  children,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.use(ToggleGroupContext);

  const resolvedVariant = variant ?? context.variant;
  const resolvedSize = size ?? context.size;

  return (
    <TogglePrimitive
      className={cn(resolvedVariant !== "segmented" && "fa-toggle-item", className)}
      data-size={resolvedSize}
      data-slot="toggle"
      data-variant={resolvedVariant}
      {...props}
    >
      {children}
    </TogglePrimitive>
  );
}

export { ToggleGroup, Toggle, Toggle as ToggleGroupItem };
