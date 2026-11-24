import { startPaletteThreadDrag } from "./CommandPalette.drag";
import { useLegendListRef } from "~/hooks/useLegendListRef";
import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronRightIcon } from "lucide-react";
import { type RefObject, useState } from "react";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { toastManager } from "./ui/toast";
import { shortcutLabelForCommand } from "../keybindings";
import {
  commandPaletteDisabledReason,
  commandPaletteItemLineCount,
  commandPaletteRowMetric,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteRow,
  type CommandPaletteRowMetric,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { useHideCommandPaletteKeyboardHints } from "./CommandPaletteContent";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandListHeading,
  CommandListVirtualized,
  CommandShortcut,
} from "./ui/command";
import { getVirtualizedScrollFadeClassName } from "./ui/scroll-area";
import { ProjectPinButton } from "./ProjectPinButton";
import { SearchMatchHintLine, ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}

function CommandPaletteEmptyState(props: { emptyStateMessage?: string; isActionsOnly: boolean }) {
  return (
    <div className="fa-cmd__empty">
      {props.emptyStateMessage ??
        (props.isActionsOnly ? "没有匹配的操作。" : "没有匹配的命令、项目或会话。")}
    </div>
  );
}

/** Heights the virtualiser locks in. Read from the library tokens, plus the
 *  `.fa-glabel` line (12px on 16px) which has no height token of its own. */
export function commandPaletteFixedRowSize(metric: CommandPaletteRowMetric): number | undefined {
  if (typeof document === "undefined") return undefined;
  const root = getComputedStyle(document.documentElement);
  const px = (name: string) => {
    const value = Number.parseFloat(root.getPropertyValue(name));
    return Number.isFinite(value) ? value : undefined;
  };
  if (metric === "item-1") return px("--fa-row-1");
  if (metric === "item-2") return px("--fa-row-2");
  const padTop = px("--fa-space-2");
  const padBottom = px("--fa-space-1");
  if (padTop === undefined || padBottom === undefined) return undefined;
  return padTop + 16 + padBottom;
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  const hideKeyboardHints = useHideCommandPaletteKeyboardHints();

  if (props.groups.length === 0) {
    return <CommandPaletteEmptyState {...props} />;
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          {group.label ? <CommandGroupLabel>{group.label}</CommandGroupLabel> : null}
          <CommandCollection>
            {(item) =>
              item.disabled ? (
                <DisabledCommandPaletteResultRow item={item} key={item.value} />
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  hideShortcuts={hideKeyboardHints}
                  isActive={props.highlightedItemValue === item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

export function scrollCommandPaletteRowIntoView(
  list: LegendListRef | null,
  rowIndex: number,
  isFirstItem: boolean,
) {
  if (isFirstItem) {
    void list?.scrollToOffset({ offset: 0, animated: false });
    return;
  }
  void list?.scrollIndexIntoView({
    index: rowIndex,
    animated: false,
    viewportMargin: { start: 24, end: 24 },
  });
}

interface CommandPaletteVirtualizedResultsProps extends Omit<CommandPaletteResultsProps, "groups"> {
  rows: ReadonlyArray<CommandPaletteRow>;
  listRef: RefObject<LegendListRef | null>;
}

/** Pass flat items with virtualized to Command, scroll highlights via listRef, and handle Enter for
 * unmounted rows. */
export function CommandPaletteVirtualizedResults(props: CommandPaletteVirtualizedResultsProps) {
  const { listRef } = props;
  const hideKeyboardHints = useHideCommandPaletteKeyboardHints();
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });
  const updateScrollFade = () => {
    const metrics = listRef.current?.getState();
    if (!metrics) return;
    const top = !metrics.isAtStart;
    const bottom = !metrics.isAtEnd;
    setScrollFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  };
  const scrollRef = useLegendListRef(listRef, updateScrollFade);

  if (props.rows.length === 0) {
    return <CommandPaletteEmptyState {...props} />;
  }

  return (
    <CommandListVirtualized>
      <LegendList<CommandPaletteRow>
        ref={scrollRef}
        data={props.rows}
        initialScrollOffset={0}
        keyExtractor={(row) => row.key}
        extraData={`${hideKeyboardHints ? "1" : "0"}:${props.highlightedItemValue ?? ""}`}
        renderItem={({ item: row }) =>
          row.kind === "label" ? (
            <CommandListHeading>{row.label}</CommandListHeading>
          ) : row.itemIndex === null ? (
            <DisabledCommandPaletteResultRow item={row.item} />
          ) : (
            <CommandPaletteResultRow
              index={row.itemIndex}
              item={row.item}
              keybindings={props.keybindings}
              hideShortcuts={hideKeyboardHints}
              isActive={props.highlightedItemValue === row.item.value}
              onExecuteItem={props.onExecuteItem}
            />
          )
        }
        getItemType={(row) => commandPaletteRowMetric(row)}
        getFixedItemSize={(row, _index, type) =>
          commandPaletteFixedRowSize(
            type === "label" || type === "item-1" || type === "item-2"
              ? type
              : commandPaletteRowMetric(row),
          )
        }
        drawDistance={400}
        onLayout={updateScrollFade}
        onScroll={updateScrollFade}
        onReady={updateScrollFade}
        // Legend counts style padding (not class padding) in its size, end state and row positions.
        style={{ paddingTop: 8, paddingBottom: 8 }}
        contentContainerClassName="px-2"
        className={cn(
          "min-h-0 scroll-py-6 overflow-x-hidden overscroll-y-contain [&::-webkit-scrollbar-track]:my-2",
          getVirtualizedScrollFadeClassName(scrollFade),
        )}
      />
    </CommandListVirtualized>
  );
}

function CommandPaletteTitle({
  item,
}: {
  item: Pick<CommandPaletteActionItem | CommandPaletteSubmenuItem, "title">;
}) {
  const { title } = item;
  return (
    <span className="x grow" dir={typeof title === "string" ? textDirection(title) : undefined}>
      {title}
    </span>
  );
}

/**
 * Project and environment for a thread row whose second line shows a message
 * snippet or match hint instead, so similar rows can still be told apart.
 */
function ThreadRowContext({
  item,
}: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  if (!item.threadSearch || !(item.threadContentMatch || item.matchHint)) return null;
  // A "Project: …" hint already names the project.
  const context = [item.threadSearch.projectTitle, item.threadSearch.environmentLabel]
    .filter((part) => part && part !== item.matchHint?.text)
    .join(" · ");
  return context ? <span className="st max-w-[45%] shrink-0 truncate">{context}</span> : null;
}

function CommandPaletteResultLines(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  reason?: string | null;
  shortcutLabel?: string | null;
  hideShortcuts?: boolean;
  keybindings?: ResolvedKeybindingsConfig;
}) {
  const twoLine = commandPaletteItemLineCount(props.item) === 2;
  return (
    <>
      <span className="lead">{props.item.icon}</span>
      <span className="fa-cmd__body">
        <span className="l l1">
          {props.item.titleLeadingContent}
          <CommandPaletteTitle item={props.item} />
          <ThreadRowContext item={props.item} />
          {props.reason != null && props.reason !== props.item.description ? (
            <span className="st">{props.reason}</span>
          ) : null}
          {props.item.titleTrailingContent}
          {props.item.kind === "action" && props.item.pin && props.keybindings ? (
            <ProjectPinButton
              name={props.item.pin.name}
              pinned={props.item.pin.pinned}
              onToggle={props.item.pin.toggle}
              shortcutLabel={
                props.hideShortcuts
                  ? null
                  : shortcutLabelForCommand(props.keybindings, "thread.pin")
              }
            />
          ) : null}
          {props.item.timestamp ? <span className="tm">{props.item.timestamp}</span> : null}
          {props.shortcutLabel ? (
            <CommandShortcut variant="hint">{props.shortcutLabel}</CommandShortcut>
          ) : null}
          {props.item.kind === "submenu" ? <ChevronRightIcon className="fa-ic" /> : null}
        </span>
        {twoLine ? (
          <span className="l l2">
            <span className="x">
              {props.item.threadContentMatch ? (
                <ThreadSearchMatchExcerpt match={props.item.threadContentMatch} tone="neutral" />
              ) : props.item.matchHint ? (
                <SearchMatchHintLine hint={props.item.matchHint} />
              ) : (
                props.item.description
              )}
            </span>
          </span>
        ) : null}
      </span>
    </>
  );
}

function DisabledCommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  const reason =
    commandPaletteDisabledReason(props.item) ??
    (typeof props.item.description === "string" ? props.item.description : null);
  const twoLine = commandPaletteItemLineCount(props.item) === 2;
  return (
    <button
      type="button"
      aria-disabled="true"
      onClick={() => {
        if (reason !== null) {
          toastManager.add({ type: "info", title: "命令不可用", description: reason });
        }
      }}
      className={cn("fa-cmd__row has-lead", twoLine ? "fa-cmd__row--2" : "fa-cmd__row--1")}
    >
      <CommandPaletteResultLines item={props.item} reason={reason} />
    </button>
  );
}

function CommandPaletteResultRow(props: {
  index?: number;
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  hideShortcuts: boolean;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  const shortcutLabel =
    !props.hideShortcuts && props.item.shortcutCommand
      ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
      : null;

  const twoLine = commandPaletteItemLineCount(props.item) === 2;
  return (
    <CommandItem
      {...(props.index === undefined ? {} : { index: props.index })}
      lines={twoLine ? 2 : 1}
      hasLead
      value={props.item.value}
      active={props.isActive}
      {...(props.item.kind === "action" && props.item.checked !== undefined
        ? { "aria-checked": props.item.checked }
        : {})}
      onPointerDown={(event) => {
        if (props.item.threadRef) {
          startPaletteThreadDrag(
            event.nativeEvent,
            props.item.threadRef,
            props.item.searchTitle ??
              (typeof props.item.title === "string" ? props.item.title : "Thread"),
          );
        }
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      <CommandPaletteResultLines
        item={props.item}
        shortcutLabel={shortcutLabel}
        hideShortcuts={props.hideShortcuts}
        keybindings={props.keybindings}
      />
    </CommandItem>
  );
}
