import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { MinusIcon, PlusIcon } from "lucide-react";
import * as React from "react";
import { cn } from "~/lib/utils";

export function NumberField({
  id,
  className,
  size = "default",
  ...props
}: NumberFieldPrimitive.Root.Props & {
  size?: "sm" | "default";
}): React.ReactElement {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  return (
    <NumberFieldPrimitive.Root
      className={cn("fa-field w-full", className)}
      data-size={size}
      data-slot="number-field"
      id={fieldId}
      {...props}
    />
  );
}

export function NumberFieldGroup({
  className,
  ...props
}: NumberFieldPrimitive.Group.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Group
      className={cn("fa-input fa-input--group ade-number-field-group", className)}
      data-slot="number-field-group"
      {...props}
    />
  );
}

export function NumberFieldDecrement({
  className,
  ...props
}: NumberFieldPrimitive.Decrement.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Decrement
      className={cn("fa-input__affix ade-number-field-step", className)}
      data-slot="number-field-decrement"
      {...props}
    >
      <MinusIcon />
    </NumberFieldPrimitive.Decrement>
  );
}

export function NumberFieldIncrement({
  className,
  ...props
}: NumberFieldPrimitive.Increment.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Increment
      className={cn("fa-input__affix ade-number-field-step", className)}
      data-slot="number-field-increment"
      {...props}
    >
      <PlusIcon />
    </NumberFieldPrimitive.Increment>
  );
}

export function NumberFieldInput({
  className,
  ...props
}: NumberFieldPrimitive.Input.Props): React.ReactElement {
  return (
    <NumberFieldPrimitive.Input
      className={cn("fa-input__control fa-num ade-number-field-input", className)}
      data-slot="number-field-input"
      {...props}
    />
  );
}

export { NumberFieldPrimitive };
