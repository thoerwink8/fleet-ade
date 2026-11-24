import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "~/lib/utils";

type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, "size"> & {
  size?: "sm" | "compact" | "default" | "lg" | number;
  font?: "default" | "mono";
  unstyled?: boolean;
  nativeInput?: boolean;
};

function Input({
  className,
  size = "default",
  font = "default",
  unstyled = false,
  nativeInput = false,
  ...props
}: InputProps) {
  const inputClassName = cn(
    unstyled ? "fa-input__control w-full min-w-0 bg-transparent outline-none" : "fa-input min-w-0",
    font === "mono" && "fa-mono tabular-nums",
    unstyled && size === "compact" && "text-meta",
  );
  const sizeAttr = typeof size === "number" ? undefined : size;
  let inputElement: React.ReactElement;

  if (nativeInput) {
    const { style, onValueChange: _onValueChange, ...nativeInputProps } = props;
    const nativeStyle = typeof style === "function" ? undefined : style;

    inputElement = (
      <input
        className={inputClassName}
        data-size={sizeAttr}
        data-slot="input"
        size={typeof size === "number" ? size : undefined}
        style={nativeStyle}
        {...(nativeInputProps as React.ComponentProps<"input">)}
      />
    );
  } else {
    inputElement = (
      <InputPrimitive
        className={inputClassName}
        data-size={sizeAttr}
        data-slot="input"
        size={typeof size === "number" ? size : undefined}
        {...props}
      />
    );
  }

  return (
    <span
      className={cn(
        "relative inline-flex w-full min-w-0",
        !unstyled && "has-disabled:cursor-not-allowed",
        className,
      )}
      data-size={size}
      data-slot="input-control"
    >
      {inputElement}
    </span>
  );
}

export { Input, type InputProps };
