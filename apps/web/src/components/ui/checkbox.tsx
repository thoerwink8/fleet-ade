import type { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import {
  Checkbox as FleetCheckbox,
  type CheckboxProps as FleetCheckboxProps,
} from "@fleet/design/react/checkbox";

import { cn } from "~/lib/utils";

type CheckboxVariant = "default" | "contrast";

type CheckboxProps = Omit<CheckboxPrimitive.Root.Props, "className" | "style" | "onCheckedChange"> &
  Pick<FleetCheckboxProps, "label" | "onCheckedChange" | "className" | "style"> & {
    variant?: CheckboxVariant;
  };

function Checkbox({
  className,
  variant = "default",
  label,
  checked,
  defaultChecked,
  onCheckedChange,
  indeterminate,
  disabled,
  name,
  value,
  style,
  "aria-label": ariaLabel,
  ...props
}: CheckboxProps) {
  // @fleet/design's Checkbox only forwards `checked` to onCheckedChange, dropping Base UI's eventDetails.
  return (
    <FleetCheckbox
      className={cn(variant === "contrast" && "border-foreground/55", className)}
      data-slot="checkbox"
      {...(label !== undefined ? { label } : {})}
      {...(checked !== undefined ? { checked } : {})}
      {...(defaultChecked !== undefined ? { defaultChecked } : {})}
      {...(onCheckedChange !== undefined ? { onCheckedChange } : {})}
      {...(indeterminate !== undefined ? { indeterminate } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(name !== undefined ? { name } : {})}
      {...(value !== undefined ? { value } : {})}
      {...(style !== undefined ? { style } : {})}
      {...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})}
      {...props}
    />
  );
}

// Checkbox's look without its hidden input, for a row that is itself the button.
function CheckboxMark({
  checked,
  variant = "default",
}: {
  checked: boolean;
  variant?: CheckboxVariant;
}) {
  const state = checked ? { "data-checked": "" } : { "data-unchecked": "" };
  return (
    <span
      aria-hidden
      className={cn("fa-checkbox", variant === "contrast" && "border-foreground/55")}
      data-slot="checkbox"
      {...state}
    >
      {checked ? (
        <svg
          aria-hidden="true"
          className="fa-ic"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          viewBox="0 0 16 16"
        >
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      ) : null}
    </span>
  );
}

export { Checkbox, CheckboxMark };
