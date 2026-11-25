import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import {
  Button as FleetButton,
  type ButtonProps as FleetButtonProps,
} from "@fleet/design/react/button";

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

type FleetButtonVariant = NonNullable<FleetButtonProps["variant"]>;

const buttonExtensionVariants = cva("", {
  defaultVariants: {
    size: "md",
    variant: "primary",
  },
  variants: {
    size: {
      lg: "",
      md: "",
      sm: "",
      xs: "",
    },
    multiline: {
      true: "ade-btn--multiline",
    },
    touchTarget: {
      compact: "ade-btn--touch-compact",
    },
    variant: {
      danger: "",
      "danger-ghost": "",
      "danger-secondary": "",
      ghost: "",
      glass: "ade-btn--glass",
      link: "ade-btn--link",
      "media-close": "ade-btn--media-close",
      "media-navigation": "absolute top-1/2 z-20 -translate-y-1/2 ade-btn--media-navigation",
      muted: "",
      overlay: "ade-btn--overlay",
      primary: "",
      secondary: "",
      "warning-outline": "ade-btn--warning-outline",
    },
  },
});

type ButtonVariant = NonNullable<VariantProps<typeof buttonExtensionVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonExtensionVariants>["size"]>;
type ButtonTouchTarget = NonNullable<VariantProps<typeof buttonExtensionVariants>["touchTarget"]>;
const FLEET_VARIANT_BY_VARIANT: Readonly<Record<ButtonVariant, FleetButtonVariant>> = {
  danger: "danger",
  "danger-ghost": "danger-ghost",
  "danger-secondary": "danger-secondary",
  ghost: "ghost",
  glass: "ghost",
  link: "ghost",
  "media-close": "ghost",
  "media-navigation": "ghost",
  muted: "muted",
  overlay: "ghost",
  primary: "primary",
  secondary: "secondary",
  "warning-outline": "ghost",
};

type ButtonVariantOptions = {
  variant?: ButtonVariant | null | undefined;
  size?: ButtonSize | null | undefined;
  icon?: boolean | null | undefined;
  multiline?: boolean | null | undefined;
  touchTarget?: ButtonTouchTarget | null | undefined;
  className?: string | undefined;
};

function buttonVariants({
  className,
  icon = false,
  multiline = false,
  size = "md",
  touchTarget,
  variant = "primary",
}: ButtonVariantOptions = {}) {
  const resolvedSize = size ?? "md";
  const resolvedVariant = variant ?? "primary";
  const fleetVariant = FLEET_VARIANT_BY_VARIANT[resolvedVariant];
  return cn(
    "fa-btn",
    fleetVariant !== "ghost" && `fa-btn--${fleetVariant}`,
    resolvedSize !== "md" && `fa-btn--${resolvedSize}`,
    icon && "fa-btn--icon",
    buttonExtensionVariants({
      size: resolvedSize,
      ...(multiline ? { multiline: true } : {}),
      ...(touchTarget !== undefined ? { touchTarget } : {}),
      variant: resolvedVariant,
    }),
    className,
  );
}

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: boolean;
  multiline?: boolean;
  touchTarget?: ButtonTouchTarget;
}

function RenderedButton({
  className,
  icon = false,
  multiline = false,
  size = "md",
  touchTarget,
  variant = "primary",
  render,
  ...props
}: ButtonProps & { render: NonNullable<ButtonProps["render"]> }) {
  const defaultProps = {
    className: buttonVariants({ className, icon, multiline, size, touchTarget, variant }),
    "data-slot": "button",
    type: undefined,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

function Button({
  className,
  icon = false,
  multiline = false,
  size = "md",
  touchTarget,
  variant = "primary",
  render,
  ...props
}: ButtonProps) {
  if (render !== undefined) {
    return (
      <RenderedButton
        render={render}
        size={size}
        icon={icon}
        multiline={multiline}
        variant={variant}
        {...(className !== undefined ? { className } : {})}
        {...(touchTarget !== undefined ? { touchTarget } : {})}
        {...props}
      />
    );
  }

  const fleetVariant = FLEET_VARIANT_BY_VARIANT[variant];
  const { ref, style, type, ...restProps } = props;

  return (
    <FleetButton
      className={cn(buttonExtensionVariants({ size, multiline, touchTarget, variant }), className)}
      data-slot="button"
      icon={icon}
      size={size}
      variant={fleetVariant}
      {...(ref !== undefined ? { ref } : {})}
      {...(style !== undefined ? { style } : {})}
      {...(type !== undefined ? { type } : {})}
      {...restProps}
    />
  );
}

export { Button, buttonVariants, type ButtonSize, type ButtonVariant };

const inlineButtonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 [text-align:var(--inline-button-text-align,center)] [white-space:var(--inline-button-white-space,nowrap)] hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64",
  {
    defaultVariants: { size: "default", tone: "default" },
    variants: {
      size: {
        default: "",
        row: "relative min-h-6 text-row after:absolute after:inset-x-0 after:-inset-y-0.5",
      },
      touchTarget: {
        compact:
          "justify-center max-md:-my-1.5 max-md:min-h-8 max-md:min-w-8 pointer-coarse:-my-1.5 pointer-coarse:min-h-8 pointer-coarse:min-w-8",
        expand: "ade-touch-target",
        padded: "pointer-coarse:min-h-11 pointer-coarse:px-1.5",
      },
      tone: {
        default: "text-foreground",
        muted: "text-muted-foreground hover:text-foreground",
        destructive: "text-destructive/80 hover:text-destructive",
        picker:
          "gap-1 text-foreground decoration-from-font underline-offset-4 data-popup-open:underline",
      },
    },
  },
);

export function InlineButton({
  className,
  size,
  tone,
  touchTarget,
  render,
  ...props
}: useRender.ComponentProps<"button"> & VariantProps<typeof inlineButtonVariants>) {
  const defaultProps = {
    className: cn(inlineButtonVariants({ size, tone, touchTarget }), className),
    "data-slot": "inline-button",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
