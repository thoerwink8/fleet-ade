import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { Input, type InputProps } from "~/components/ui/input";

const inputGroupVariants = cva(
  "fa-input fa-input--group w-full min-w-0 *:[[data-slot=input-control],[data-slot=textarea-control]]:contents",
  {
    defaultVariants: {
      variant: "default",
      size: "default",
    },
    variants: {
      size: {
        default: null,
        lg: "h-9",
      },
      variant: {
        default: null,
        popover: "dropdown-surface",
        ghost: null,
      },
    },
  },
);

function InputGroup({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupVariants>) {
  return (
    <div
      className={cn(inputGroupVariants({ variant, size }), className)}
      data-size={size}
      data-slot="input-group"
      data-variant={variant}
      role="group"
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "fa-input__affix cursor-text select-none justify-center gap-2 leading-none [&>kbd]:rounded-[calc(var(--radius)-5px)] in-[[data-slot=input-group]:has([data-slot=input-control],[data-slot=textarea-control])]:[&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      align: "inline-start",
    },
    compoundVariants: [
      {
        align: "inline-end",
        inset: "pill",
        className: "has-[>button]:me-0 pe-1 gap-0.5",
      },
      {
        align: "inline-start",
        inset: "pill",
        className: "has-[>button]:ms-0 ps-1 gap-0.5",
      },
    ],
    variants: {
      inset: {
        default: null,
        pill: "[&_button]:rounded-full",
      },
      align: {
        "block-end":
          "order-last w-full justify-start px-[calc(--spacing(3)-1px)] pb-[calc(--spacing(3)-1px)] [.border-t]:pt-[calc(--spacing(3)-1px)]",
        "block-start":
          "order-first w-full justify-start px-[calc(--spacing(3)-1px)] pt-[calc(--spacing(3)-1px)] [.border-b]:pb-[calc(--spacing(3)-1px)]",
        "inline-end":
          "has-[>:last-child[data-slot=badge]]:-me-1.5 has-[>button]:-me-2 order-last has-[>kbd:last-child]:me-[-0.35rem]",
        "inline-start":
          "has-[>:last-child[data-slot=badge]]:-ms-1.5 has-[>button]:-ms-2 order-first has-[>kbd:last-child]:ms-[-0.35rem]",
      },
    },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  inset,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      className={cn(inputGroupAddonVariants({ align, inset }), className)}
      data-align={align}
      data-slot="input-group-addon"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        const isInteractive = target.closest(
          "button, a, input, select, textarea, [role='button'], [role='combobox'], [role='listbox'], [data-slot='select-trigger']",
        );
        if (isInteractive) return;
        e.preventDefault();
        const parent = e.currentTarget.parentElement;
        const input = parent?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        );
        if (input && !parent?.querySelector("input:focus, textarea:focus")) {
          input.focus();
        }
      }}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: InputProps) {
  return <Input className={className} unstyled {...props} />;
}

export { InputGroup, InputGroupAddon, InputGroupInput };
