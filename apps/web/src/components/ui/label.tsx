import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

import { cn } from "~/lib/utils";

function Label({ className, render, ...props }: useRender.ComponentProps<"label">) {
  const defaultProps = {
    className: cn(
      "fa-control inline-flex items-center gap-2 text-foreground in-disabled:text-(--fa-fg-muted) group-data-disabled/field:text-(--fa-fg-muted) peer-disabled:text-(--fa-fg-muted) data-disabled:text-(--fa-fg-muted) aria-disabled:text-(--fa-fg-muted)",
      className,
    ),
    "data-slot": "label",
  };

  return useRender({
    defaultTagName: "label",
    props: mergeProps<"label">(defaultProps, props),
    render,
  });
}

export { Label };
