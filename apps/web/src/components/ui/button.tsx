import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import {
  Button as FleetButton,
  type ButtonProps as FleetButtonProps,
} from "@fleet/design/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

type FleetButtonVariant = NonNullable<FleetButtonProps["variant"]>;
type FleetButtonSize = NonNullable<FleetButtonProps["size"]>;

const buttonExtensionVariants = cva("", {
  defaultVariants: {
    size: "default",
    variant: "default",
  },
  variants: {
    size: {
      action: "",
      compact: "",
      default: "",
      icon: "",
      "icon-lg": "",
      "icon-micro": "",
      "icon-tiny": "",
      "icon-sm": "",
      "icon-sm-pill": "",
      "icon-xl": "",
      "icon-xs": "",
      lg: "",
      micro: "",
      multiline: "ade-btn--multiline",
      sm: "",
      "sm-pill": "",
      "sm-multiline": "ade-btn--multiline",
      xl: "",
      xs: "",
    },
    touchTarget: {
      compact: "ade-btn--touch-compact",
    },
    variant: {
      default: "",
      destructive: "",
      "destructive-outline": "",
      ghost: "",
      "ghost-muted": "",
      "ghost-destructive": "",
      glass: "ade-btn--glass",
      link: "ade-btn--link",
      "media-close": "ade-btn--media-close",
      "media-navigation": "absolute top-1/2 z-20 -translate-y-1/2 ade-btn--media-navigation",
      outline: "",
      overlay: "ade-btn--overlay",
      secondary: "",
      "warning-outline": "ade-btn--warning-outline",
    },
  },
});

type ButtonVariant = NonNullable<VariantProps<typeof buttonExtensionVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonExtensionVariants>["size"]>;
type ButtonTouchTarget = NonNullable<VariantProps<typeof buttonExtensionVariants>["touchTarget"]>;

const FLEET_VARIANT_BY_VARIANT: Readonly<Record<ButtonVariant, FleetButtonVariant>> = {
  default: "primary",
  destructive: "danger",
  "destructive-outline": "danger-secondary",
  ghost: "ghost",
  "ghost-muted": "muted",
  "ghost-destructive": "danger-ghost",
  glass: "ghost",
  link: "ghost",
  "media-close": "ghost",
  "media-navigation": "ghost",
  outline: "secondary",
  overlay: "ghost",
  secondary: "secondary",
  "warning-outline": "ghost",
};

const FLEET_SIZE_BY_SIZE: Readonly<
  Record<ButtonSize, { readonly size: FleetButtonSize; readonly icon: boolean }>
> = {
  action: { size: "sm", icon: false },
  compact: { size: "sm", icon: false },
  default: { size: "md", icon: false },
  icon: { size: "md", icon: true },
  "icon-lg": { size: "lg", icon: true },
  "icon-micro": { size: "xs", icon: true },
  "icon-tiny": { size: "xs", icon: true },
  "icon-sm": { size: "sm", icon: true },
  "icon-sm-pill": { size: "sm", icon: true },
  "icon-xl": { size: "lg", icon: true },
  "icon-xs": { size: "xs", icon: true },
  lg: { size: "lg", icon: false },
  micro: { size: "xs", icon: false },
  multiline: { size: "md", icon: false },
  sm: { size: "sm", icon: false },
  "sm-pill": { size: "sm", icon: false },
  "sm-multiline": { size: "sm", icon: false },
  xl: { size: "lg", icon: false },
  xs: { size: "xs", icon: false },
};

type ButtonVariantOptions = {
  variant?: ButtonVariant | null | undefined;
  size?: ButtonSize | null | undefined;
  touchTarget?: ButtonTouchTarget | null | undefined;
  className?: string | undefined;
};

function buttonVariants({
  className,
  size = "default",
  touchTarget,
  variant = "default",
}: ButtonVariantOptions = {}) {
  const resolvedSize = size ?? "default";
  const resolvedVariant = variant ?? "default";
  const fleetVariant = FLEET_VARIANT_BY_VARIANT[resolvedVariant];
  const { size: fleetSize, icon } = FLEET_SIZE_BY_SIZE[resolvedSize];
  return cn(
    "fa-btn",
    fleetVariant !== "ghost" && `fa-btn--${fleetVariant}`,
    fleetSize !== "md" && `fa-btn--${fleetSize}`,
    icon && "fa-btn--icon",
    buttonExtensionVariants({
      size: resolvedSize,
      ...(touchTarget !== undefined ? { touchTarget } : {}),
      variant: resolvedVariant,
    }),
    className,
  );
}

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  touchTarget?: ButtonTouchTarget;
}

function RenderedButton({
  className,
  variant = "default",
  size = "default",
  touchTarget,
  render,
  ...props
}: ButtonProps & { render: NonNullable<ButtonProps["render"]> }) {
  const defaultProps = {
    className: buttonVariants({ className, size, touchTarget, variant }),
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
  variant = "default",
  size = "default",
  touchTarget,
  render,
  ...props
}: ButtonProps) {
  if (render !== undefined) {
    return (
      <RenderedButton
        render={render}
        size={size}
        variant={variant}
        {...(className !== undefined ? { className } : {})}
        {...(touchTarget !== undefined ? { touchTarget } : {})}
        {...props}
      />
    );
  }

  const fleetVariant = FLEET_VARIANT_BY_VARIANT[variant];
  const { size: fleetSize, icon } = FLEET_SIZE_BY_SIZE[size];
  const { ref, style, type, ...restProps } = props;

  return (
    <FleetButton
      className={cn(buttonExtensionVariants({ size, touchTarget, variant }), className)}
      data-slot="button"
      icon={icon}
      size={fleetSize}
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
