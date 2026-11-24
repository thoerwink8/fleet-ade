import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "relative [&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      variant: "secondary",
    },
    variants: {
      size: {
        default: "",
        row: "",
        sm: "",
      },
      variant: {
        secondary: "fa-tag",
        outline: "fa-tag",
        chip: "fa-tag ade-badge--chip",
        label: "fa-tag",
        destructive: "fa-status",
        error: "fa-status",
        info: "fa-status",
        success: "fa-status",
        warning: "fa-status",
        "dot-attention": "fa-status",
        "dot-active": "fa-status",
        "dot-blocked": "fa-status",
        "dot-waiting": "fa-status",
        "dot-done": "fa-status",
      },
    },
  },
);

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

const badgeDotClass: Partial<Record<BadgeVariant, string>> = {
  label: "ade-badge__dot--label",
  destructive: "fa-dot--error",
  error: "fa-dot--error",
  info: "fa-dot--needs",
  success: "fa-dot--running",
  warning: "fa-dot--warning",
  "dot-attention": "fa-dot--needs",
  "dot-active": "fa-dot--running",
  "dot-blocked": "fa-dot--error",
  "dot-waiting": "fa-dot--ring",
  "dot-done": "",
};

interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
}

function Badge({ className, variant, size, render, children, ...props }: BadgeProps) {
  const resolvedVariant = variant ?? "secondary";
  const dotClassName = badgeDotClass[resolvedVariant];
  const content =
    dotClassName === undefined ? (
      children
    ) : (
      <>
        <span aria-hidden="true" className={cn("fa-dot", dotClassName)} />
        {children}
      </>
    );

  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant: resolvedVariant })),
    "data-slot": "badge",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, { ...props, children: content }),
    render,
  });
}

export { Badge, badgeVariants };
