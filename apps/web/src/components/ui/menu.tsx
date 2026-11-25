import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { useHideKeyboardShortcutHints } from "~/hooks/useKeyboardShortcutHints";
import { renderClosingPositioner } from "./closing-positioner";
import { Input, type InputProps } from "./input";
import { Spinner } from "./spinner";

const Menu = MenuPrimitive.Root;

function MenuTrigger({ className, children, ...props }: MenuPrimitive.Trigger.Props) {
  return (
    <MenuPrimitive.Trigger className={className} data-slot="menu-trigger" {...props}>
      {children}
    </MenuPrimitive.Trigger>
  );
}

function MenuPopup({
  children,
  className,
  sideOffset = 4,
  align = "center",
  alignOffset,
  side = "bottom",
  collisionAvoidance,
  anchor,
  keepMounted = false,
  width = "default",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
  collisionAvoidance?: MenuPrimitive.Positioner.Props["collisionAvoidance"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  keepMounted?: boolean;
  width?: "default" | "content";
}) {
  return (
    <MenuPrimitive.Portal keepMounted={keepMounted}>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        className="z-[130]"
        data-slot="menu-positioner"
        render={renderClosingPositioner}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "fa-pop relative flex max-w-[calc(100vw-2rem)] origin-(--transform-origin) flex-col outline-none",
            // Electron drag hit-testing ignores z-index; opt portaled menus out to keep overlapping rows
            // hoverable.
            "[-webkit-app-region:no-drag]",
            width === "content" ? "w-max min-w-0" : "min-w-[min(10rem,calc(100vw-2rem))]",
            className,
          )}
          data-slot="menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-x-clip overflow-y-auto">
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** A menu's filter field, drawn like `ComboboxSearchInput` so every searchable popup matches. */
function MenuSearchInput({
  busy = false,
  onKeyDown,
  ...props
}: Omit<InputProps, "className" | "size" | "unstyled" | "nativeInput"> & { busy?: boolean }) {
  return (
    <div className="min-w-0 shrink-0 px-2 pt-1.5 pb-1">
      <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
        {busy ? (
          <Spinner
            aria-hidden="true"
            size="md"
            tone="muted"
            className="pointer-events-none absolute top-1.5 left-0"
          />
        ) : (
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
          />
        )}
        <Input
          {...props}
          className="rounded-none bg-transparent text-row [&_input]:h-7 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-7"
          size="sm"
          unstyled
          onKeyDown={(event) => {
            // Menu typeahead would otherwise take the letters; arrows still reach the items.
            if (event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation();
            onKeyDown?.(event);
          }}
        />
      </div>
    </div>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuItem({
  className,
  inset: _inset,
  density = "default",
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  density?: "default" | "touch";
  variant?: "default" | "destructive" | "ghost";
}) {
  return (
    <MenuPrimitive.Item
      className={cn("fa-item", variant === "destructive" && "fa-item--danger", className)}
      data-density={density}
      data-inset={_inset}
      data-slot="menu-item"
      data-variant={variant}
      {...props}
    />
  );
}

function MenuItemLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="menu-item-label"
      className={cn(
        "min-w-0 truncate in-data-[density=touch]:[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:in-data-[density=touch]:py-[0.5em]",
        className,
      )}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  variant = "default",
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  variant?: "default" | "icon" | "switch";
}) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn("fa-item", className)}
      data-slot="menu-checkbox-item"
      {...props}
    >
      {variant === "switch" ? (
        <>
          <span className="grow">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator className="ade-menu-switch" keepMounted>
            <span className="ade-menu-switch__thumb" />
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      ) : (
        <>
          <MenuPrimitive.CheckboxItemIndicator
            className={cn("tick", variant === "icon" && "-mx-0.5")}
            keepMounted
          >
            {variant === "icon" ? (
              <svg
                aria-hidden="true"
                className="fa-ic"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.75"
                viewBox="0 0 24 24"
              >
                <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
              </svg>
            ) : (
              <CheckIcon aria-hidden="true" className="fa-ic" />
            )}
          </MenuPrimitive.CheckboxItemIndicator>
          <span className="grow">{children}</span>
        </>
      )}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({
  className,
  children,
  hideIndicator: _hideIndicator = false,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  hideIndicator?: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem
      className={cn("fa-item", className)}
      data-slot="menu-radio-item"
      {...props}
    >
      <span className="grow">{children}</span>
    </MenuPrimitive.RadioItem>
  );
}

function MenuRadioItemIndicator({
  className,
  children,
  ...props
}: MenuPrimitive.RadioItemIndicator.Props) {
  return (
    <MenuPrimitive.RadioItemIndicator
      aria-hidden
      className={cn("tick", className)}
      data-slot="menu-radio-item-indicator"
      {...props}
    >
      {children ?? <CheckIcon aria-hidden="true" className="fa-ic" />}
    </MenuPrimitive.RadioItemIndicator>
  );
}

function MenuGroupLabel({
  className,
  inset: _inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn("fa-glabel", className)}
      data-inset={_inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("fa-sep", className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  const hideKeyboardHints = useHideKeyboardShortcutHints();
  if (hideKeyboardHints) return null;
  return <kbd className={cn("end", className)} data-slot="menu-shortcut" {...props} />;
}

// Trailing value on a menu row, such as the time a snooze preset wakes at.
// Reads as text at the row's size; MenuShortcut is only for key chords.
function MenuItemDetail({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("end", className)} data-slot="menu-item-detail" {...props} />;
}

function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />;
}

function MenuSubTrigger({
  className,
  inset: _inset,
  density = "default",
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
  density?: "default" | "touch";
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn("fa-item", className)}
      data-density={density}
      data-inset={_inset}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon aria-hidden="true" className="end fa-ic" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuSubPopup({
  className,
  sideOffset = 0,
  alignOffset,
  align = "start",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
}) {
  const defaultAlignOffset = align !== "center" ? -5 : undefined;

  return (
    <MenuPopup
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      data-slot="menu-sub-content"
      side="inline-end"
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export {
  Menu,
  Menu as DropdownMenu,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopup,
  MenuPopup as DropdownMenuContent,
  MenuSearchInput,
  MenuGroup,
  MenuGroup as DropdownMenuGroup,
  MenuItem,
  MenuItemLabel,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuRadioItemIndicator,
  MenuGroupLabel,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator,
  MenuSeparator as DropdownMenuSeparator,
  MenuItemDetail,
  MenuShortcut,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub,
  MenuSub as DropdownMenuSub,
  MenuSubTrigger,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuSubPopup,
  MenuSubPopup as DropdownMenuSubContent,
};
