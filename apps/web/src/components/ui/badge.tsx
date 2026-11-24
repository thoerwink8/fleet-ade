import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center whitespace-nowrap outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
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
        destructive: "fa-status ade-badge--status",
        error: "fa-status ade-badge--status",
        info: "fa-status ade-badge--status",
        success: "fa-status ade-badge--status",
        warning: "fa-status ade-badge--status",
        "dot-attention": "fa-status ade-badge--status",
        "dot-active": "fa-status ade-badge--status",
        "dot-blocked": "fa-status ade-badge--status",
        "dot-waiting": "fa-status ade-badge--status",
        "dot-done": "fa-status ade-badge--status",
      },
    },
  },
);

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

const badgeDotVariants = {
  label: "ade-badge__dot--label",
  destructive: "fa-dot--error",
  error: "fa-dot--error",
  info: "fa-dot--needs",
  success: "fa-dot--running",
  warning: "fa-dot--needs",
  "dot-attention": "fa-dot--needs",
  "dot-active": "fa-dot--running",
  "dot-blocked": "fa-dot--error",
  "dot-waiting": "fa-dot--ring",
  "dot-done": "",
} as const satisfies Partial<Record<BadgeVariant, string>>;

interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
}

function Badge({ className, variant, size, render, children, ...props }: BadgeProps) {
  const resolvedVariant = variant ?? "secondary";
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant: resolvedVariant })),
    "data-slot": "badge",
  };
  const dotClassName = (badgeDotVariants as Partial<Record<BadgeVariant, string>>)[resolvedVariant];
  const content =
    dotClassName === undefined ? (
      children
    ) : (
      <>
        <span aria-hidden="true" className={cn("fa-dot", dotClassName)} />
        {children}
      </>
    );

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, { ...props, children: content }),
    render,
  });
}

export { Badge, badgeVariants };
