import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import { SearchIcon } from "lucide-react";
import { useRef } from "react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import { useHideKeyboardShortcutHints } from "~/hooks/useKeyboardShortcutHints";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";
import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteListHeading,
  AutocompleteListVirtualized,
} from "~/components/ui/autocomplete";
import { COMMAND_POPUP_CLASS, DIALOG_BACKDROP_BASE_CLASS } from "~/components/ui/dialog-styles";
import { Button } from "~/components/ui/button";

const CommandDialog = CommandDialogPrimitive.Root;

const CommandDialogPortal = CommandDialogPrimitive.Portal;

function CommandDialogTrigger(props: CommandDialogPrimitive.Trigger.Props) {
  return <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;
}

function CommandDialogBackdrop({ className, ...props }: CommandDialogPrimitive.Backdrop.Props) {
  return (
    <CommandDialogPrimitive.Backdrop
      className={cn(
        "fa-backdrop",
        DIALOG_BACKDROP_BASE_CLASS,
        "data-ending-style:pointer-events-none",
        className,
      )}
      data-slot="command-dialog-backdrop"
      {...props}
    />
  );
}

function CommandDialogViewport({ className, ...props }: CommandDialogPrimitive.Viewport.Props) {
  // Short desktop windows would put the search field under the native window controls.
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const titlebarStyle = {
    "--command-titlebar-height": `${nativeTitlebarHeight}px`,
  } as React.CSSProperties;
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 pt-[max(--spacing(4),4vh,calc(var(--command-titlebar-height)+--spacing(2)))] pb-[max(--spacing(4),4vh)] sm:pt-[max(10vh,calc(var(--command-titlebar-height)+--spacing(2)))] sm:pb-[10vh]",
        className,
      )}
      data-slot="command-dialog-viewport"
      style={titlebarStyle}
      {...props}
    />
  );
}

function CommandDialogPopup({
  className,
  children,
  onBackdropPointerDown,
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <CommandDialogPortal>
      <CommandDialogBackdrop onPointerDown={onBackdropPointerDown} />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          // The first tabbable can be an input addon, such as a submenu's Back button.
          initialFocus={() => popupRef.current?.querySelector("input") ?? true}
          ref={popupRef}
          className={cn(
            COMMAND_POPUP_CLASS,
            "pointer-events-auto max-h-[70vh] text-foreground data-ending-style:pointer-events-none",
            className,
          )}
          data-slot="command-dialog-popup"
          {...props}
        >
          {children}
        </CommandDialogPrimitive.Popup>
      </CommandDialogViewport>
    </CommandDialogPortal>
  );
}

function Command({
  autoHighlight = "always",
  keepHighlight = true,
  ...props
}: React.ComponentProps<typeof Autocomplete>) {
  return (
    <Autocomplete
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      open
      {...props}
    />
  );
}

function CommandInput({
  className,
  placeholder,
  ...props
}: React.ComponentProps<typeof AutocompleteInput>) {
  return (
    <div className="fa-cmd__in" data-slot="command-input-row">
      <AutocompleteInput
        autoFocus
        className={cn(
          "h-full border-0 bg-transparent shadow-none *:data-[slot=autocomplete-input]:ps-9!",
          className,
        )}
        placeholder={placeholder}
        startAddon={<SearchIcon className="text-icon-muted" />}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof AutocompleteList>) {
  return (
    <AutocompleteList
      className={cn("not-empty:scroll-py-2 not-empty:p-2", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandListVirtualized({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListVirtualized>) {
  return (
    <AutocompleteListVirtualized
      className={cn("flex max-h-[inherit] min-h-0 flex-col", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandListHeading({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListHeading>) {
  return (
    <AutocompleteListHeading className={className} data-slot="command-group-label" {...props} />
  );
}

function CommandPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden rounded-t-xl not-has-[+[data-slot=command-footer]]:rounded-b-2xl bg-transparent **:data-[slot=scroll-area-scrollbar]:mt-2 [touch-action:pan-y]",
        className,
      )}
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof AutocompleteGroup>) {
  return <AutocompleteGroup className={className} data-slot="command-group" {...props} />;
}

function CommandGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>) {
  return (
    <AutocompleteGroupLabel className={className} data-slot="command-group-label" {...props} />
  );
}

function CommandCollection({ ...props }: React.ComponentProps<typeof AutocompleteCollection>) {
  return <AutocompleteCollection data-slot="command-collection" {...props} />;
}

// `active` is the palette's own highlight. Composer rows still pass it and keep
// the previous accent fill; palette rows map it to data-palette-active.
function CommandItem({
  className,
  active,
  lines = 1,
  hasLead = false,
  ...props
}: React.ComponentProps<typeof AutocompleteItem> & {
  active?: boolean;
  lines?: 1 | 2;
  hasLead?: boolean;
}) {
  const composer = "data-composer-item-id" in props;
  return (
    <AutocompleteItem
      className={cn(
        composer
          ? cn(
              "py-1.5 data-selected:bg-foreground/[0.06] data-highlighted:bg-foreground/[0.09] data-highlighted:text-foreground [&[data-highlighted][data-selected]]:bg-foreground/[0.09] [&[data-highlighted][data-selected]]:text-foreground",
              active !== undefined &&
                "cursor-pointer hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-selected:bg-transparent data-selected:text-inherit [&[data-highlighted][data-selected]]:bg-transparent [&[data-highlighted][data-selected]]:text-inherit",
              active && "bg-accent! text-accent-foreground!",
            )
          : cn(
              "fa-cmd__row",
              lines === 2 ? "fa-cmd__row--2" : "fa-cmd__row--1",
              hasLead && "has-lead",
            ),
        className,
      )}
      data-active={composer ? active || undefined : undefined}
      data-palette-active={composer || !active ? undefined : ""}
      data-slot="command-item"
      {...props}
    />
  );
}

function CommandShortcut({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"kbd"> & { variant?: "default" | "hint" }) {
  const hideKeyboardHints = useHideKeyboardShortcutHints();
  if (hideKeyboardHints) return null;
  return (
    <kbd
      className={cn(
        variant === "hint"
          ? "st ms-auto"
          : "ms-auto font-medium font-sans text-secondary-label text-meta tracking-normal",
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    />
  );
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("fa-cmd__foot justify-between", className)}
      data-slot="command-footer"
      {...props}
    />
  );
}

function CommandFooterAction({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "variant">) {
  return (
    <Button
      {...props}
      variant="ghost-muted"
      size="xs"
      className={cn("h-auto px-2 text-meta hover:bg-transparent", className)}
    />
  );
}

export {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandFooter,
  CommandFooterAction,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandListHeading,
  CommandListVirtualized,
  CommandPanel,
  CommandShortcut,
};
