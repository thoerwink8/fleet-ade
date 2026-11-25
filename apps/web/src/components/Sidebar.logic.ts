import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import * as React from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import {
  threadSearchMatchKey,
  threadSearchSubject,
  type ThreadSearchShell,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import {
  isBlockingApproval,
  isListedThreadLineage,
  isUserInputRequest,
  type ContextMenuItem,
  type EnvironmentId,
  type OrchestrationV2PendingRuntimeRequestSummary,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type { AsyncResult } from "effect/reactivity";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  getThreadSortTimestamp,
  planPinnedReorder,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarThreadSummary, Thread } from "../types";
import { normalizeSearchText } from "../lib/utils";
import { isLatestRunSettled } from "../session-logic";
import { THREAD_STATUS_TEXT } from "@t3tools/client-runtime/state/thread-activity-announcement";
import { observeIntersection } from "../lib/observeIntersection";
import { deadlineAfter, deadlineStore, type ClockStore } from "@t3tools/client-runtime/clock";
import { useDeadlinePassed } from "../hooks/useDeadline";
import { isElectron } from "../env";
import { shouldShowThreadJumpHintsForModifiers } from "../keybindings";
import { isRightPanelFocused } from "../lib/rightPanelFocus";
import { isTerminalFocused, subscribeToTerminalFocusChanges } from "../lib/terminalFocus";
import { isModelPickerOpen, subscribeToModelPickerVisibility } from "../modelPickerVisibility";
import { shortcutModifierStore } from "../shortcutModifierState";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useRightPanelStore } from "../rightPanelStore";
import {
  isEmptySidebarThread,
  type SidebarEmptyThreadCandidate,
} from "./sidebar/SidebarThreadRow.logic";

export function shouldNavigateAfterThreadSnooze(input: {
  readonly threadKey: string;
  readonly currentThreadKey: string | null;
  readonly now: string;
  readonly thread: ThreadSnoozeShell | null;
}): boolean {
  return (
    input.threadKey === input.currentThreadKey &&
    input.thread !== null &&
    effectiveSnoozed(input.thread, { now: input.now })
  );
}

export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;

export function resolveSidebarRowAccessibility(input: {
  readonly title: string;
  readonly statusLabel: string | null;
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
  readonly isCommander?: boolean;
}): { readonly label: string; readonly current: "page" | undefined } {
  return {
    label: [
      input.title,
      input.isCommander ? "指挥" : null,
      input.statusLabel,
      input.projectDisplayName,
    ]
      .filter(Boolean)
      .join(", "),
    current: input.isActive ? "page" : undefined,
  };
}

// Each prewarm retains growing thread detail and a live subscription, multiplying heap and server load.
const SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX = 160;

export function useSidebarRowSubscriptionLease(isActive: boolean): {
  readonly leaseLiveStatus: boolean;
  readonly rowRef: (row: HTMLElement | null) => (() => void) | undefined;
} {
  const [isNearViewport, setIsNearViewport] = React.useState(isActive);
  if (isActive && !isNearViewport) setIsNearViewport(true);
  const canObserve = typeof IntersectionObserver !== "undefined";

  return {
    leaseLiveStatus: isActive || isNearViewport || !canObserve,
    rowRef: (row) => {
      if (row === null || isActive || !canObserve) return undefined;
      // The overscan has to apply to the sidebar's own scroller; a viewport-rooted
      // margin is still clipped by it.
      return observeIntersection(row, (entry) => setIsNearViewport(entry.isIntersecting), {
        root: row.closest('[data-slot="scroll-area-viewport"]'),
        rootMargin: `${SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX}px 0px`,
      });
    },
  };
}

const fileDragClears = new Set<(active: false) => void>();
function clearFileDrags() {
  const clears = [...fileDragClears];
  fileDragClears.clear();
  for (const clear of clears) clear(false);
}

/**
 * A file drag that ends outside every drop target (Escape, or a drop elsewhere)
 * sends no dragleave to the row it last entered, so the window's dragend clears it.
 */
export function setFileDragActive(setActive: (active: boolean) => void, active: boolean) {
  setActive(active);
  if (typeof window === "undefined") return;
  if (!active) {
    if (fileDragClears.delete(setActive) && fileDragClears.size === 0) {
      window.removeEventListener("dragend", clearFileDrags);
    }
    return;
  }
  if (fileDragClears.size === 0) window.addEventListener("dragend", clearFileDrags, { once: true });
  fileDragClears.add(setActive);
}

/**
 * A clock that advances exactly when a snooze wake time passes, so a woken
 * thread leaves the shelf on time without a per-second clock.
 */
export function useSnoozeWakeClock(
  threads: ReadonlyArray<{ readonly snoozedUntil?: string | null | undefined }>,
): number {
  const [clockMs, setClockMs] = React.useState(() => Date.now());
  const wakeTimes: number[] = [];
  let nextWakeAt: number | null = null;
  for (const thread of threads) {
    const wakeAt = thread.snoozedUntil == null ? Number.NaN : Date.parse(thread.snoozedUntil);
    if (!(wakeAt > clockMs)) continue;
    wakeTimes.push(wakeAt);
    if (nextWakeAt === null || wakeAt < nextWakeAt) nextWakeAt = wakeAt;
  }
  const woke = useDeadlinePassed(nextWakeAt);
  // Advancing to the latest wake that has passed skips every wake that elapsed
  // meanwhile, e.g. across a laptop sleep. Stepping one wake at a time would
  // re-render once per elapsed wake and hit React's limit.
  if (woke && nextWakeAt !== null) {
    let nextClockMs = nextWakeAt;
    for (const wakeAt of wakeTimes) {
      if (wakeAt > nextClockMs && deadlineStore(wakeAt).getSnapshot()) nextClockMs = wakeAt;
    }
    setClockMs(nextClockMs);
    return nextClockMs;
  }
  return clockMs;
}

// Live status that says the cwd is not a repository means the checkout was removed.
export function withoutRemovedCheckout<
  T extends { readonly branch: string | null; readonly worktreePath: string | null },
>(thread: T, gitStatus: { readonly isRepo?: boolean | undefined } | null): T {
  return gitStatus?.isRepo === false ? { ...thread, branch: null, worktreePath: null } : thread;
}

export function useRetainedValue<T>(key: string | null, value: T | null): T | null {
  const [retained, setRetained] = React.useState<{
    readonly key: string;
    readonly value: T;
  } | null>(null);
  if (key !== null && value !== null && (retained?.key !== key || retained.value !== value)) {
    setRetained({ key, value });
  }
  if (value !== null) return value;
  return key !== null && retained?.key === key ? retained.value : null;
}

// Sortable owns drag transforms; replaying committed order would animate drops twice.
export const animateSidebarLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

// Snoozed rows cannot accept drops without a wake time. Working rows only drag out as chat context.

export type SidebarSection =
  | "commander"
  | "attention"
  | "pinned"
  | "active"
  | "working"
  | "snoozed"
  | "settled";

export function resolveSidebarThreadSection(input: {
  readonly commander?: boolean;
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
}): SidebarSection {
  if (input.commander) return "commander";
  if (input.snoozed) return "snoozed";
  if (input.settled) return "settled";
  if (input.pinned) return "pinned";
  return "active";
}

const SIDEBAR_MARKER_PREFIX = "sidebar-marker-";

export type SidebarListMarker =
  | "pinned-header"
  | "active-placeholder"
  | "settled-placeholder"
  | "pinned-divider"
  | "attention-header"
  | "attention-more"
  | "working-header"
  | "snoozed-header"
  | "settled-header";

export function sidebarMarkerId(marker: SidebarListMarker): string {
  return `${SIDEBAR_MARKER_PREFIX}${marker}`;
}

export type SidebarListItem =
  | { readonly kind: "thread"; readonly key: string; readonly section: SidebarSection }
  | { readonly kind: "marker"; readonly marker: SidebarListMarker };

export function sidebarListItemId(item: SidebarListItem): string {
  return item.kind === "thread" ? item.key : sidebarMarkerId(item.marker);
}

export function buildSidebarListItems(input: {
  readonly commanderKeys: readonly string[];
  readonly visibleAttentionKeys: readonly string[];
  readonly attentionCount: number;
  readonly hiddenAttentionCount: number;
  readonly pinnedKeys: readonly string[];
  readonly activeKeys: readonly string[];
  readonly visibleWorkingKeys: readonly string[];
  readonly workingCount: number;
  readonly visibleSnoozedKeys: readonly string[];
  readonly snoozedCount: number;
  readonly renderedSettledKeys: readonly string[];
  readonly settledCount: number;
  readonly isDragging: boolean;
}): SidebarListItem[] {
  const {
    commanderKeys,
    visibleAttentionKeys,
    attentionCount,
    hiddenAttentionCount,
    pinnedKeys,
    activeKeys,
    visibleWorkingKeys,
    workingCount,
    visibleSnoozedKeys,
    snoozedCount,
    renderedSettledKeys,
    settledCount,
    isDragging,
  } = input;
  if (
    commanderKeys.length +
      attentionCount +
      pinnedKeys.length +
      activeKeys.length +
      workingCount +
      snoozedCount +
      settledCount ===
    0
  ) {
    return [];
  }
  const rowsOf = (keys: readonly string[], section: SidebarSection): SidebarListItem[] =>
    keys.map((key) => ({ kind: "thread", key, section }));

  const items: SidebarListItem[] = rowsOf(commanderKeys, "commander");
  if (attentionCount > 0) {
    items.push({ kind: "marker", marker: "attention-header" });
    items.push(...rowsOf(visibleAttentionKeys, "attention"));
    if (hiddenAttentionCount > 0) items.push({ kind: "marker", marker: "attention-more" });
  }
  items.push({ kind: "marker", marker: "pinned-header" });
  items.push(...rowsOf(pinnedKeys, "pinned"));
  items.push({ kind: "marker", marker: "pinned-divider" });
  items.push({ kind: "marker", marker: "active-placeholder" });
  items.push(...rowsOf(activeKeys, "active"));
  if (workingCount > 0) {
    items.push({ kind: "marker", marker: "working-header" });
    items.push(...rowsOf(visibleWorkingKeys, "working"));
  }
  if (snoozedCount > 0) {
    items.push({ kind: "marker", marker: "snoozed-header" });
    items.push(...rowsOf(visibleSnoozedKeys, "snoozed"));
  }
  if (settledCount > 0 || isDragging) {
    items.push({ kind: "marker", marker: "settled-header" });
    items.push({ kind: "marker", marker: "settled-placeholder" });
    items.push(...rowsOf(renderedSettledKeys, "settled"));
  }
  return items;
}

export function shouldShowSidebarEmptyState(input: {
  readonly isSearchingThreads: boolean;
  readonly visibleDraftSessionCount: number;
  readonly commanderCount: number;
  readonly attentionCount: number;
  readonly pinnedCount: number;
  readonly activeCount: number;
  readonly workingCount: number;
  readonly snoozedCount: number;
  readonly settledCount: number;
  readonly hasProjectScope: boolean;
  readonly settledShelfExpanded: boolean;
}): boolean {
  if (input.isSearchingThreads || input.visibleDraftSessionCount > 0) return false;
  const nonSettledCount =
    input.commanderCount +
    input.attentionCount +
    input.pinnedCount +
    input.activeCount +
    input.workingCount +
    input.snoozedCount;
  return (
    nonSettledCount === 0 &&
    (input.settledCount === 0 || (input.hasProjectScope && !input.settledShelfExpanded))
  );
}

export function countArchivedThreadsInScope(input: {
  readonly snapshots: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly snapshot: {
      readonly threads: ReadonlyArray<{
        readonly id: string;
        readonly projectId: string;
        readonly archivedAt: unknown;
        readonly deletedAt?: unknown;
      }>;
    };
  }>;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
}): number {
  const seen = new Set<string>();
  for (const { environmentId, snapshot } of input.snapshots) {
    for (const thread of snapshot.threads) {
      if (thread.archivedAt == null || thread.deletedAt != null) continue;
      if (
        input.scopedProjectKeys !== null &&
        !input.scopedProjectKeys.has(`${environmentId}:${thread.projectId}`)
      ) {
        continue;
      }
      seen.add(`${environmentId}:${thread.id}`);
    }
  }
  return seen.size;
}

function sectionAtSidebarSlot(items: readonly SidebarListItem[], index: number): SidebarSection {
  let section: SidebarSection = "pinned";
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    if (item.marker === "pinned-header") section = "pinned";
    else if (item.marker === "pinned-divider") section = "active";
    else if (item.marker === "working-header") section = "working";
    else if (item.marker === "attention-header") section = "attention";
    else if (item.marker === "snoozed-header") section = "snoozed";
    else if (item.marker === "settled-header") section = "settled";
  }
  return section;
}

type SidebarDropTarget = {
  readonly section: "pinned" | "active" | "settled";
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
};

export function resolveSidebarDropTarget(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string,
): SidebarDropTarget | null {
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === activeKey);
  const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
  if (activeIndex === -1 || overIndex === -1 || items[activeIndex]?.kind !== "thread") return null;
  if (items[activeIndex].section === "commander") return null;
  const pinnedHeaderIndex = items.findIndex(
    (item) => item.kind === "marker" && item.marker === "pinned-header",
  );
  if (pinnedHeaderIndex !== -1 && overIndex < pinnedHeaderIndex) return null;
  if (items[overIndex]?.kind === "thread" && items[overIndex].section === "commander") return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, items[activeIndex]!);
  const section = sectionAtSidebarSlot(moved, overIndex);
  if (
    section === "commander" ||
    section === "working" ||
    section === "snoozed" ||
    section === "attention"
  )
    return null;
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let currentSection: SidebarSection = "pinned";
  for (const item of moved) {
    if (item.kind === "marker") {
      if (item.marker === "pinned-header") currentSection = "pinned";
      else if (item.marker === "pinned-divider") currentSection = "active";
      else if (
        item.marker === "working-header" ||
        item.marker === "snoozed-header" ||
        item.marker === "settled-header"
      )
        break;
    } else if (item.section === "commander") continue;
    else if (currentSection === "pinned") pinnedOrder.push(item.key);
    else activeOrder.push(item.key);
  }
  return { section, pinnedOrder, activeOrder };
}

type SidebarThreadDropPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "reorder-pinned";
      readonly order: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "pin";
      readonly order: readonly string[];
      readonly orderKey: string | undefined;
      readonly extraAssignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "move-active";
      readonly order: readonly string[] | null;
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
    }
  | { readonly kind: "settle" };

export type SidebarDropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

export function resolveSidebarDropVerb(
  from: SidebarSection,
  to: SidebarSection | null,
): SidebarDropVerb | null {
  if (to === null || to === from || to === "commander" || to === "working" || to === "snoozed")
    return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

export function resolveSidebarSweepKeys(
  orderedKeys: readonly string[],
  originKey: string,
  targetKey: string,
  canApply: (key: string) => boolean,
): string[] {
  const origin = orderedKeys.indexOf(originKey);
  const target = orderedKeys.indexOf(targetKey);
  if (origin === -1 || target === -1) return [];
  return orderedKeys.slice(Math.min(origin, target), Math.max(origin, target) + 1).filter(canApply);
}

export function sidebarThreadKeyAtY(list: HTMLElement, y: number): string | null {
  const viewport = list.closest('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect();
  const visibleY = viewport ? Math.min(Math.max(y, viewport.top), viewport.bottom - 1) : y;
  let key: string | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("li[data-thread-item]")) {
    if (key !== null && row.getBoundingClientRect().top > visibleY) break;
    key = row.dataset.threadItem ?? null;
  }
  return key;
}

export function resolveSidebarReorderableThreadKeys(input: {
  readonly threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId" | "id" | "commander">>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<EnvironmentServerConfig, "environment">>;
  readonly connectedEnvironmentIds: readonly EnvironmentId[];
}) {
  const connectedEnvironmentIds = new Set(input.connectedEnvironmentIds);
  const draggableThreadKeys = new Set<string>();
  const activeReorderableThreadKeys = new Set<string>();

  for (const thread of input.threads) {
    if (thread.commander === true) continue;
    // Config is cached for offline rendering, so its presence does not make a row writable.
    if (
      !connectedEnvironmentIds.has(thread.environmentId) ||
      !input.serverConfigs.has(thread.environmentId)
    ) {
      continue;
    }

    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    activeReorderableThreadKeys.add(threadKey);
    draggableThreadKeys.add(threadKey);
  }

  return { draggableThreadKeys, activeReorderableThreadKeys };
}

export function planSidebarThreadDrop(input: {
  readonly activeKey: string;
  readonly activeSection: SidebarSection;
  readonly activePinned?: boolean;
  readonly activeSettled?: boolean;
  readonly supportsSettlement?: boolean;
  readonly target: SidebarDropTarget;
  readonly pinnedOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableKeys?: ReadonlySet<string>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeReorderableKeys?: ReadonlySet<string>;
  readonly activeTimeOrdered?: boolean;
}): SidebarThreadDropPlan {
  const {
    activeKey,
    activeSection,
    activePinned = activeSection === "pinned",
    activeSettled = activeSection === "settled",
    target,
    pinnedOrder,
    pinnedKeysById,
    reorderableKeys,
    activeOrder,
    activeKeysById,
    activeReorderableKeys,
  } = input;
  if (activeSection === "working" || activeSection === "commander") return { kind: "none" };
  if (input.supportsSettlement === false && (target.section === "settled" || activeSettled)) {
    return { kind: "none" };
  }
  const arrange = (
    order: readonly string[],
    keysById: ReadonlyMap<string, string | null | undefined>,
    writable: ReadonlySet<string> | undefined,
  ) => {
    if (!writable) return planPinnedReorder({ orderedIds: order, keysById, movedId: activeKey });
    if (!writable.has(activeKey)) return null;
    const assignments = planPinnedReorder({
      orderedIds: order.filter((key) => writable.has(key) || keysById.get(key) != null),
      keysById,
      movedId: activeKey,
    });
    if (assignments.some(({ id }) => !writable.has(id))) return null;

    // Keyless Active rows sort before keyed rows; keyless Pinned rows sort after them.
    // Materializing any row across a frozen keyless boundary cannot persist that position.
    const assignedIds = new Set(assignments.map(({ id }) => id));
    let hasFrozenKeylessBefore = false;
    let hasAssignedBefore = false;
    for (const id of order) {
      const isFrozenKeyless = !writable.has(id) && keysById.get(id) == null;
      const isAssigned = assignedIds.has(id);
      if (
        (target.section === "active" && isFrozenKeyless && hasAssignedBefore) ||
        (target.section === "pinned" && isAssigned && hasFrozenKeylessBefore)
      ) {
        return null;
      }

      hasFrozenKeylessBefore ||= isFrozenKeyless;
      hasAssignedBefore ||= isAssigned;
    }

    return assignments;
  };
  switch (target.section) {
    case "active": {
      if (input.activeTimeOrdered) {
        return activeSection === "active"
          ? { kind: "none" }
          : {
              kind: "move-active",
              order: null,
              assignments: [],
              unpin: activePinned,
              unsettle: activeSettled,
              unsnooze: activeSection === "snoozed",
            };
      }
      const order = target.activeOrder;
      if (
        activeSection === "active" &&
        order.length === activeOrder.length &&
        order.every((key, index) => key === activeOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, activeKeysById, activeReorderableKeys);
      if (assignments === null) return { kind: "none" };
      return {
        kind: "move-active",
        order,
        assignments,
        unpin: activePinned,
        unsettle: activeSettled,
        unsnooze: activeSection === "snoozed",
      };
    }
    case "settled":
      return activeSection === "settled" ? { kind: "none" } : { kind: "settle" };
    case "pinned": {
      const order = target.pinnedOrder;
      if (
        activeSection === "pinned" &&
        order.length === pinnedOrder.length &&
        order.every((key, index) => key === pinnedOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, pinnedKeysById, reorderableKeys);
      if (assignments === null) return { kind: "none" };
      if (activeSection === "pinned") {
        return assignments.length === 0
          ? { kind: "none" }
          : { kind: "reorder-pinned", order, assignments };
      }
      return {
        kind: "pin",
        order,
        orderKey: assignments.find((assignment) => assignment.id === activeKey)?.orderKey,
        extraAssignments: activePinned
          ? assignments
          : assignments.filter((assignment) => assignment.id !== activeKey),
      };
    }
  }
}

export function applySidebarThreadDrop<
  T extends Pick<
    SidebarThreadSummary,
    | "pinnedAt"
    | "pinOrderKey"
    | "activeOrderKey"
    | "snoozedAt"
    | "snoozedUntil"
    | "settledAt"
    | "settledOverride"
    | "unsettledAt"
  >,
>(thread: T, section: "pinned" | "active" | "settled", now: string, orderKey?: string): T {
  const wasSettled = thread.settledOverride === "settled";
  const awake = { ...thread, snoozedAt: null, snoozedUntil: null };
  if (section === "settled") {
    return {
      ...awake,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      settledOverride: "settled",
      settledAt: wasSettled ? (thread.settledAt ?? now) : now,
      unsettledAt: null,
    };
  }
  const resumed = wasSettled
    ? { ...awake, settledOverride: "active" as const, settledAt: null, unsettledAt: now }
    : awake;
  return {
    ...resumed,
    pinnedAt: section === "pinned" ? (thread.pinnedAt ?? now) : null,
    pinOrderKey: section === "pinned" ? (orderKey ?? thread.pinOrderKey) : null,
    ...(section === "active" && orderKey !== undefined ? { activeOrderKey: orderKey } : {}),
  };
}

type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

type ScopedSidebarProject = SidebarProject & {
  environmentId: string;
};

type ScopedSidebarThread = ThreadSortInput & {
  environmentId: string;
  projectId: string;
  archivedAt: string | null;
};

type LogicalSidebarProject = SidebarProject & {
  projectKey: string;
  memberProjectRefs: readonly {
    environmentId: string;
    projectId: string;
  }[];
};

type ThreadTraversalDirection = "previous" | "next";

/** Exclude only successful deletions from shared-worktree checks. */
export async function deleteSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  delete: (
    entry: TEntry,
    deletedThreadKeys: ReadonlySet<string>,
  ) => Promise<AtomCommandResult<unknown, unknown> | null>;
}) {
  const deletedThreadKeys = new Set<string>();
  let firstFailure: AsyncResult.Failure<unknown, unknown> | null = null;

  for (const entry of input.entries) {
    const result = await input.delete(entry, deletedThreadKeys);
    if (result === null) continue;
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) break;
      firstFailure ??= result;
      continue;
    }
    deletedThreadKeys.add(entry.threadKey);
  }

  return { deletedThreadKeys, firstFailure };
}

function batchItemFailureLines(
  items: ReadonlyArray<{ readonly status: string; readonly title: string }>,
): string[] {
  return items.flatMap((item) => {
    if (item.status === "running") return [`${item.title} 正在跑，未删除`];
    if (item.status === "rejected") return [`${item.title} 未处理`];
    return [];
  });
}

function groupThreadIdsByEnvironment(
  threads: readonly { readonly environmentId: EnvironmentId; readonly id: ThreadId }[],
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly threadIds: ThreadId[] }> {
  const groups = new Map<EnvironmentId, ThreadId[]>();
  for (const thread of threads) {
    const ids = groups.get(thread.environmentId);
    if (ids) ids.push(thread.id);
    else groups.set(thread.environmentId, [thread.id]);
  }
  return [...groups].map(([environmentId, threadIds]) => ({ environmentId, threadIds }));
}

export async function applyThreadBatch(input: {
  readonly threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
    readonly key: string;
  }>;
  readonly dispatch: (group: {
    readonly environmentId: EnvironmentId;
    readonly threadIds: ReadonlyArray<ThreadId>;
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<{ readonly prunedKeys: ReadonlySet<string>; readonly failures: readonly string[] }> {
  const prunedKeys = new Set<string>();
  const failures: string[] = [];
  const keyById = new Map(input.threads.map((thread) => [String(thread.id), thread.key]));
  const titleById = new Map(input.threads.map((thread) => [String(thread.id), thread.title]));
  for (const group of groupThreadIdsByEnvironment(input.threads)) {
    const result = await input.dispatch(group);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) break;
      const error = squashAtomCommandFailure(result);
      failures.push(error instanceof Error ? error.message : "请求失败");
      continue;
    }
    // The atom wraps the RPC payload; `batch` lives on the dispatch result, not the envelope.
    const value = result.value as {
      readonly batch?: {
        readonly items: ReadonlyArray<{ readonly threadId: string; readonly status: string }>;
      };
    };
    for (const item of value.batch?.items ?? []) {
      if (item.status !== "applied" && item.status !== "deleted" && item.status !== "not_found") {
        continue;
      }
      const key = keyById.get(item.threadId);
      if (key) prunedKeys.add(key);
    }
    failures.push(
      ...batchItemFailureLines(
        (value.batch?.items ?? []).map((item) => ({
          status: item.status,
          title: titleById.get(item.threadId) ?? item.threadId,
        })),
      ),
    );
  }
  return { prunedKeys, failures };
}

export function isSidebarHiddenThread(thread: Pick<SidebarThreadSummary, "lineage">): boolean {
  return !isListedThreadLineage(thread.lineage);
}

// Subagent and side-chat threads have no sidebar row, so an open one is represented by
// its nearest listed ancestor. A broken chain (missing parent, cycle,
// other environment) resolves to the thread itself, which then matches no row.
export function resolveSidebarRowThreadId(
  threadId: ThreadId,
  environmentId: EnvironmentId,
  threads: readonly Pick<SidebarThreadSummary, "id" | "environmentId" | "lineage">[],
): ThreadId {
  const findThread = (id: ThreadId) =>
    threads.find((thread) => thread.id === id && thread.environmentId === environmentId);
  const visited = new Set<ThreadId>();
  let thread = findThread(threadId);
  while (thread !== undefined && isSidebarHiddenThread(thread)) {
    if (thread.lineage.parentThreadId === null || visited.has(thread.id)) return threadId;
    visited.add(thread.id);
    thread = findThread(thread.lineage.parentThreadId);
  }
  return thread?.id ?? threadId;
}

/**
 * `delegatedUnderParent` holds the tasks linked environments run for a thread
 * the sidebar lists, by thread key; they show under that thread, as subagents do.
 */
export function filterSidebarV2VisibleThreads<
  T extends Pick<SidebarThreadSummary, "archivedAt" | "environmentId" | "id" | "lineage"> &
    Partial<SidebarEmptyThreadCandidate> & {
      projectId: string;
    },
>(
  threads: readonly T[],
  scopedProjectKeys: ReadonlySet<string> | null,
  delegatedUnderParent: ReadonlySet<string>,
  routeRowThreadKey: string | null = null,
): T[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !isShownUnderParent(
        { environmentId: thread.environmentId, threadId: thread.id },
        thread.lineage,
        delegatedUnderParent,
      ) &&
      (!isEmptySidebarThread(thread) ||
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeRowThreadKey) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
}

export type MultiSelectThreadMenuId =
  | "unpin"
  | "settle"
  | "snooze"
  | `snooze:${string}`
  | "regenerate-title"
  | "archive"
  | "select-all"
  | "mark-unread"
  | "delete";

export interface MultiSelectThreadMenuInput {
  readonly selectedCount: number;
  readonly totalSelectableCount: number;
  readonly pinnedCount: number;
  readonly canOperatePinned: boolean;
  readonly unsettledCount: number;
  readonly canOperateUnsettled: boolean;
  readonly snoozeableCount: number;
  readonly canOperateSnoozeable: boolean;
  readonly snoozePresets: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly whenLabel: string;
  }>;
  readonly titleRegenerationSupportedCount: number;
  readonly titleRegenerationInFlightCount: number;
  readonly canOperateRegeneratable: boolean;
  readonly archiveableCount: number;
  readonly canOperateArchiveable: boolean;
  readonly canOperateAll: boolean;
}

export function buildMultiSelectThreadMenuItems(
  input: MultiSelectThreadMenuInput,
): ReadonlyArray<ContextMenuItem<MultiSelectThreadMenuId>> {
  const regeneratableCount = Math.max(
    0,
    input.titleRegenerationSupportedCount - input.titleRegenerationInFlightCount,
  );
  return [
    ...(input.pinnedCount > 0
      ? [
          {
            id: "unpin" as const,
            label: `取消置顶（${input.pinnedCount}）`,
            disabled: !input.canOperatePinned,
          },
        ]
      : []),
    ...(input.unsettledCount > 0
      ? [
          {
            id: "settle" as const,
            label: `标为完成（${input.unsettledCount}）`,
            disabled: !input.canOperateUnsettled,
          },
        ]
      : []),
    ...(input.snoozeableCount > 0
      ? [
          {
            id: "snooze" as const,
            label: `暂缓（${input.snoozeableCount}）`,
            disabled: !input.canOperateSnoozeable,
            children: [
              ...input.snoozePresets.map((preset) => ({
                id: `snooze:${preset.id}` as const,
                label: preset.label,
                detail: preset.whenLabel,
                disabled: !input.canOperateSnoozeable,
              })),
              {
                id: "snooze:custom" as const,
                label: "自定义…",
                separatorBefore: input.snoozePresets.length > 0,
                disabled: !input.canOperateSnoozeable,
              },
            ],
          },
        ]
      : []),
    ...(input.titleRegenerationSupportedCount > 0
      ? [
          regeneratableCount === 0
            ? {
                id: "regenerate-title" as const,
                label: `正在重新生成…（${input.titleRegenerationSupportedCount}）`,
                disabled: true,
              }
            : {
                id: "regenerate-title" as const,
                label: `重新生成标题（${regeneratableCount}）`,
                disabled: !input.canOperateRegeneratable,
              },
        ]
      : []),
    {
      id: "archive",
      label: `归档（${input.archiveableCount > 0 ? input.archiveableCount : input.selectedCount}）`,
      ...(input.archiveableCount === 0
        ? { disabled: true, detail: "运行中，请先停止" }
        : { disabled: !input.canOperateArchiveable }),
    },
    ...(input.totalSelectableCount > input.selectedCount
      ? [{ id: "select-all" as const, label: "全选当前列表" }]
      : []),
    { id: "mark-unread", label: `标为未读（${input.selectedCount}）` },
    {
      id: "delete",
      label: `删除（${input.selectedCount}）`,
      destructive: true,
      separatorBefore: true,
      disabled: !input.canOperateAll,
    },
  ];
}

export interface ThreadStatusPill {
  label:
    | "出错了"
    | "有新结果"
    | "等你批准"
    | "等你回答"
    | "正在连接"
    | "等空位"
    | "等待中"
    | "计划已就绪"
    | "运行中";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  lastVisitedAt?: string | null | undefined;
  pendingBackgroundTasks?: SidebarThreadSummary["pendingBackgroundTasks"] | undefined;
  blockedOnThreadWait?: boolean | undefined;
};

// Read at event time: subscribing Sidebar to terminal or modifier state re-renders every row.
export function threadShortcutContext(routeThreadRef: ScopedThreadRef | null) {
  return {
    terminalFocus: isTerminalFocused(),
    rightPanelFocus: isRightPanelFocused(),
    terminalOpen:
      routeThreadRef !== null &&
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        routeThreadRef,
      ).terminalOpen,
    modelPickerOpen: isModelPickerOpen(),
    isWeb: !isElectron,
    isDesktop: isElectron,
  };
}

/** Whether the current modifier combination, including none, has been held unchanged for `delayMs`. */
function createModifierHoldStore(delayMs: number): ClockStore<boolean> {
  const listeners = new Set<() => void>();
  let held = false;
  // Counts arms, not subscriptions: a deadline whose timer outlives the last
  // subscriber must not flip `held` for whoever subscribes next.
  let arm = 0;
  let stopDeadline = () => {};
  let stopModifiers: (() => void) | null = null;

  const setHeld = (next: boolean, fromArm: number) => {
    if (fromArm !== arm || held === next) return;
    held = next;
    for (const listener of listeners) listener();
  };
  const onModifiersChange = () => {
    stopDeadline();
    const fromArm = ++arm;
    const deadline = deadlineStore(deadlineAfter(delayMs));
    stopDeadline = deadline.subscribe(() => setHeld(true, fromArm));
    // A deadline another subscriber already passed never notifies a late joiner.
    setHeld(deadline.getSnapshot(), fromArm);
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (stopModifiers === null) {
        stopModifiers = shortcutModifierStore.subscribe(onModifiersChange);
        onModifiersChange();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopModifiers?.();
        stopModifiers = null;
        stopDeadline();
        stopDeadline = () => {};
        // Retire the in-flight deadline too: its timer keeps the store alive.
        arm += 1;
        held = false;
      };
    },
    getSnapshot: () => held,
  };
}

const threadJumpModifierHold = createModifierHoldStore(THREAD_JUMP_HINT_SHOW_DELAY_MS);

function subscribeToThreadJumpHintInputs(listener: () => void): () => void {
  const unsubscribeHold = threadJumpModifierHold.subscribe(listener);
  // The snapshot reads the modifiers too; a hold that stays true across a new combination never notifies.
  const unsubscribeModifiers = shortcutModifierStore.subscribe(listener);
  const unsubscribeFocus = subscribeToTerminalFocusChanges(listener);
  const unsubscribeTerminals = useTerminalUiStateStore.subscribe(listener);
  const unsubscribeRightPanels = useRightPanelStore.subscribe(listener);
  const unsubscribeModelPicker = subscribeToModelPickerVisibility(listener);
  return () => {
    unsubscribeHold();
    unsubscribeModifiers();
    unsubscribeFocus();
    unsubscribeTerminals();
    unsubscribeRightPanels();
    unsubscribeModelPicker();
  };
}

/**
 * Thread jump hints appear once the jump modifier has been held for a moment,
 * so a quick shortcut never flashes them, and hide as soon as it is released.
 * The snapshot is the visibility itself, so a quick shortcut never re-renders the caller.
 */
export function useThreadJumpHintsVisible(
  keybindings: ResolvedKeybindingsConfig,
  routeThreadRef: ScopedThreadRef | null,
): boolean {
  return React.useSyncExternalStore(
    subscribeToThreadJumpHintInputs,
    () =>
      threadJumpModifierHold.getSnapshot() &&
      shouldShowThreadJumpHintsForModifiers(shortcutModifierStore.getSnapshot(), keybindings, {
        platform: navigator.platform,
        context: threadShortcutContext(routeThreadRef),
      }),
  );
}

/**
 * Time to send when dismissing attention on a server that still stores the
 * client's `visitedAt`. Only stamps the server already issued: a device clock
 * ahead of those stamps hides later activity, and one behind leaves this item unread.
 */
export function attentionDismissVisitedAt(
  thread: {
    readonly updatedAt: string;
    readonly latestRun?: { readonly completedAt?: string | null } | null;
    readonly runtime?: { readonly updatedAt?: string | null } | null;
  },
  wokeAt: string | null,
): string {
  let latest = thread.updatedAt;
  let latestMs = Date.parse(latest);
  for (const candidate of [thread.latestRun?.completedAt, thread.runtime?.updatedAt, wokeAt]) {
    if (candidate == null) continue;
    const candidateMs = Date.parse(candidate);
    if (Number.isNaN(candidateMs)) continue;
    if (Number.isNaN(latestMs) || candidateMs > latestMs) {
      latest = candidate;
      latestMs = candidateMs;
    }
  }
  return latest;
}

export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  // Server visits override local watermarks, including mark-unread rewinds; use local values only on older
  // servers.
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** Unopened threads' failures still count as unseen, unlike completions. */
function hasUnseenFailure(thread: ThreadStatusInput): boolean {
  if (thread.latestRun?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const completedAt = Date.parse(thread.latestRun.completedAt ?? "");
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export type ThreadAttentionCategory = "approval" | "input" | "failed" | "limited" | "completed";

export interface ThreadAttention {
  readonly category: ThreadAttentionCategory;
  /** Blocking requests park the agent until answered; visiting does not clear them. */
  readonly blocking: boolean;
  readonly unseen: boolean;
}

export type ThreadAttentionInput = ThreadStatusInput & {
  /** Raw request carries `blocking`; without it the derived flags decide. */
  readonly pendingRuntimeRequest?: Pick<
    OrchestrationV2PendingRuntimeRequestSummary,
    "kind" | "blocking"
  > | null;
  readonly source?: {
    readonly pendingRuntimeRequest?: Pick<
      OrchestrationV2PendingRuntimeRequestSummary,
      "kind" | "blocking"
    > | null;
  };
};

function resolvePendingRuntimeRequest(
  thread: Pick<ThreadAttentionInput, "pendingRuntimeRequest" | "source">,
) {
  return thread.pendingRuntimeRequest !== undefined
    ? thread.pendingRuntimeRequest
    : thread.source?.pendingRuntimeRequest;
}

function isLiveWorkingStatus(
  status: SidebarThreadStatus,
  thread: Pick<
    SidebarThreadSummary,
    "interactionMode" | "hasActionableProposedPlan" | "latestRun" | "runtime"
  >,
): boolean {
  if (
    status !== "preparing" &&
    status !== "queued" &&
    status !== "working" &&
    status !== "waiting"
  ) {
    return false;
  }
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan === true &&
    runSettled
  );
}

export function isSidebarLiveWorking(
  thread: SidebarThreadStatusInput &
    Pick<
      SidebarThreadSummary,
      "interactionMode" | "hasActionableProposedPlan" | "latestRun" | "runtime"
    >,
): boolean {
  return isLiveWorkingStatus(resolveSidebarThreadStatus(thread), thread);
}

export function resolveThreadAttention(
  thread: ThreadAttentionInput,
  lastVisitedAt: string | null | undefined = thread.lastVisitedAt,
): ThreadAttention | null {
  const request = resolvePendingRuntimeRequest(thread);
  const statusThread = { ...thread, lastVisitedAt };
  if (
    (request !== null && request !== undefined
      ? isBlockingApproval(request.kind, request.blocking)
      : thread.hasPendingApprovals) ||
    thread.pendingSubagentRequest === "approval"
  ) {
    return { category: "approval", blocking: true, unseen: true };
  }
  if (
    (request !== null && request !== undefined
      ? isUserInputRequest(request.kind, request.blocking)
      : thread.hasPendingUserInput) ||
    thread.pendingSubagentRequest === "user_input"
  ) {
    return { category: "input", blocking: true, unseen: true };
  }
  const status = resolveSidebarThreadStatus({
    ...thread,
    blockedOnThreadWait: thread.blockedOnThreadWait ?? false,
  });
  // Active work or awaited background work supersedes any stale completion/failure from an earlier run.
  if (
    status === "preparing" ||
    status === "queued" ||
    status === "working" ||
    status === "waiting"
  ) {
    return null;
  }
  if (status === "failed" || status === "limited" || thread.latestRun?.status === "failed") {
    const category = status === "limited" ? "limited" : "failed";
    if (thread.latestRun?.status === "failed") {
      return { category, blocking: false, unseen: hasUnseenFailure(statusThread) };
    }
    const failedAt = Date.parse(thread.runtime?.updatedAt ?? "");
    const visitedAt = Date.parse(lastVisitedAt ?? "");
    const unseen =
      lastVisitedAt == null || Number.isNaN(failedAt) || Number.isNaN(visitedAt)
        ? true
        : failedAt > visitedAt;
    return { category, blocking: false, unseen };
  }
  if (thread.latestRun?.status === "completed" && thread.latestRun.completedAt) {
    return { category: "completed", blocking: false, unseen: hasUnseenCompletion(statusThread) };
  }
  return null;
}

export function isThreadAttentionRowDisabled(input: {
  readonly attention: ThreadAttention | undefined;
  readonly attentionOffline: boolean | undefined;
}): boolean {
  return input.attention !== undefined && input.attentionOffline === true;
}

export function isThreadAttentionDismissible(input: {
  readonly attention: (ThreadAttention & { readonly demoted?: boolean }) | undefined;
  readonly attentionOffline: boolean;
}): boolean {
  return (
    input.attention !== undefined &&
    !input.attention.blocking &&
    !input.attention.demoted &&
    !input.attentionOffline
  );
}

export function threadAttentionSubtitleText(input: {
  readonly attention: ThreadAttention;
  readonly attentionOffline?: boolean | undefined;
  readonly isRoute?: boolean | undefined;
}): string {
  switch (input.attention.category) {
    case "approval":
      return input.isRoute ? "等你批准" : "等你批准，点开处理";
    case "input":
      return input.isRoute ? "等你回答" : "等你回答，点开处理";
    case "failed":
      return "上一轮出错了，点开处理";
    case "limited":
      return "用量受限，点开处理";
    case "completed":
      return "有新结果，点开查看";
  }
}

export interface SidebarThreadRowMark {
  readonly dot: string;
  readonly label: string;
}

export interface SidebarThreadHoverDot {
  readonly variant: "dot-attention" | "dot-active" | "dot-blocked" | "dot-waiting" | "dot-done";
  readonly label: string;
}

export interface SidebarRowPresentation {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly subtitle: string | null;
  readonly rowMark: SidebarThreadRowMark | null;
  readonly statusLabel: string | null;
  readonly hoverDot: SidebarThreadHoverDot;
}

export type SidebarRowPresentationThread = ThreadAttentionInput &
  Pick<SidebarThreadSummary, "latestRun" | "runtime"> & {
    readonly goal?: SidebarThreadSummary["goal"];
    readonly turnCount?: number | undefined;
    readonly visibleItemCount?: number | undefined;
  };

/** Derive row dot, unread highlight, subtitle, accessibility label, and hover status from one judgment. */
export function resolveSidebarRowPresentation(input: {
  readonly section: SidebarSection;
  readonly thread: SidebarRowPresentationThread;
  readonly attention: ThreadAttention | null;
  readonly lastVisitedAt: string | null | undefined;
  readonly isRoute: boolean;
  readonly isWoke: boolean;
}): SidebarRowPresentation {
  const { section, thread, attention, lastVisitedAt, isRoute, isWoke } = input;
  const rawStatus = resolveSidebarThreadStatus({
    ...thread,
    blockedOnThreadWait: thread.blockedOnThreadWait ?? false,
  });
  let status: SidebarThreadStatus =
    rawStatus === "ready" && thread.latestRun?.status === "failed" ? "failed" : rawStatus;
  // Hold the row visually running during the inbox 2s exit grace so section and row never disagree.
  if (section === "working" && status === "ready") {
    status = "working";
  }
  if (section === "attention" && attention !== null) {
    if (attention.category === "approval") status = "approval";
    else if (attention.category === "input") status = "input";
    else if (attention.category === "limited") status = "limited";
    else if (attention.category === "failed") status = "failed";
  }

  const isUnread =
    !isRoute &&
    section !== "settled" &&
    section !== "snoozed" &&
    section !== "working" &&
    status === "ready" &&
    (attention?.category === "completed" || hasUnseenCompletion({ ...thread, lastVisitedAt }));

  const subtitle =
    section === "attention" &&
    attention !== null &&
    (!isRoute || attention.blocking) &&
    !(isRoute && attention.category === "completed")
      ? threadAttentionSubtitleText({ attention, isRoute })
      : null;

  const hasRun =
    thread.latestRun != null || (thread.turnCount ?? 0) > 0 || (thread.visibleItemCount ?? 0) > 0;

  let rowMark: SidebarThreadRowMark | null = null;
  let statusLabel: string | null = null;
  let hoverDot: SidebarThreadHoverDot;

  switch (status) {
    case "approval":
      rowMark = { dot: "fa-dot--needs", label: "等你批准" };
      statusLabel = "等你批准";
      hoverDot = { variant: "dot-attention", label: "等你批准" };
      break;
    case "input":
      rowMark = { dot: "fa-dot--needs", label: "等你回答" };
      statusLabel = "等你回答";
      hoverDot = { variant: "dot-attention", label: "等你回答" };
      break;
    case "preparing":
      rowMark = { dot: "fa-dot--running", label: "正在设置" };
      statusLabel = "正在设置";
      hoverDot = { variant: "dot-active", label: "正在设置" };
      break;
    case "working": {
      const label = thread.goal?.status === "active" ? "目标" : "运行中";
      rowMark = { dot: "fa-dot--running", label: "运行中" };
      statusLabel = label;
      hoverDot = { variant: "dot-active", label: "运行中" };
      break;
    }
    case "queued":
      rowMark = { dot: "fa-dot--ring", label: "等空位" };
      statusLabel = "等空位";
      hoverDot = { variant: "dot-waiting", label: "等空位" };
      break;
    case "waiting":
      rowMark =
        section === "working" || (thread.runtime !== null && thread.runtime.status !== "idle")
          ? { dot: "fa-dot--ring", label: "等待中" }
          : null;
      statusLabel = "等待中";
      hoverDot = { variant: "dot-waiting", label: "等待中" };
      break;
    case "limited":
      rowMark = { dot: "fa-dot--error", label: "用量受限" };
      statusLabel = "用量受限";
      hoverDot = { variant: "dot-blocked", label: "用量受限" };
      break;
    case "failed":
      rowMark = { dot: "fa-dot--error", label: "出错了" };
      statusLabel = "出错了";
      hoverDot = { variant: "dot-blocked", label: "出错了" };
      break;
    case "ready":
      if (isUnread) {
        rowMark = { dot: "fa-dot--new", label: "有新结果" };
        statusLabel = "有新结果";
        hoverDot = { variant: "dot-done", label: "有新结果" };
      } else if (isWoke) {
        rowMark = null;
        statusLabel = "暂缓结束";
        hoverDot = { variant: "dot-done", label: "暂缓结束" };
      } else {
        rowMark = null;
        statusLabel = null;
        hoverDot = { variant: "dot-done", label: hasRun ? "空闲" : "新会话" };
      }
      break;
  }

  return { status, isUnread, subtitle, rowMark, statusLabel, hoverDot };
}

export interface SidebarResolvedThreadState extends SidebarRowPresentation {
  readonly section: SidebarSection;
  readonly attention: (ThreadAttention & { readonly demoted: boolean }) | null;
}

export type SidebarThreadStateInput = SidebarRowPresentationThread &
  ThreadSnoozeShell &
  Pick<SidebarThreadSummary, "commander" | "pinnedAt" | "settledOverride" | "settledAt">;

/** Compute sidebar section, attention membership, and row presentation from a single judgment. */
export function resolveSidebarThreadState(input: {
  readonly thread: SidebarThreadStateInput;
  readonly lastVisitedAt: string | null | undefined;
  readonly isRoute: boolean;
  readonly configLoaded: boolean;
  readonly workingShelfEnabled: boolean;
  readonly isWorkingGrace: boolean;
  readonly now: string;
  readonly isWoke?: boolean;
}): SidebarResolvedThreadState {
  const {
    thread,
    lastVisitedAt,
    isRoute,
    configLoaded,
    workingShelfEnabled,
    isWorkingGrace,
    now,
    isWoke = false,
  } = input;
  const snoozedNow = configLoaded && effectiveSnoozed(thread, { now });
  const settledNow = configLoaded && thread.settledOverride === "settled";
  const rawStatus = resolveSidebarThreadStatus({
    ...thread,
    blockedOnThreadWait: thread.blockedOnThreadWait ?? false,
  });

  let section: SidebarSection;
  let attention: (ThreadAttention & { readonly demoted: boolean }) | null = null;

  if (thread.commander === true) {
    section = "commander";
  } else {
    const rawAttention = resolveThreadAttention(thread, lastVisitedAt);
    const holdInWorkingGrace =
      workingShelfEnabled &&
      isWorkingGrace &&
      !snoozedNow &&
      !settledNow &&
      thread.pinnedAt == null &&
      rawAttention?.blocking !== true;
    // Open non-blocking threads drop back to their base section instead of lingering with click-to-open copy.
    if (
      !holdInWorkingGrace &&
      rawAttention !== null &&
      (rawAttention.blocking || (!snoozedNow && !settledNow && !isRoute && rawAttention.unseen))
    ) {
      section = "attention";
      attention = { ...rawAttention, demoted: isRoute };
    } else {
      const baseSection = resolveSidebarThreadSection({
        commander: false,
        snoozed: snoozedNow,
        settled: settledNow,
        pinned: thread.pinnedAt != null,
      });
      if (baseSection !== "active") {
        section = baseSection;
      } else {
        const liveWorking = isLiveWorkingStatus(rawStatus, thread);
        section = workingShelfEnabled && (liveWorking || isWorkingGrace) ? "working" : "active";
      }
    }
  }

  const presentation = resolveSidebarRowPresentation({
    section,
    thread,
    attention,
    lastVisitedAt,
    isRoute,
    isWoke,
  });

  return { section, attention, ...presentation };
}

export function resolveSidebarOfflineBanner(input: {
  readonly visibleThreads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string>;
}): {
  readonly offlineEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly message: string;
} | null {
  const connected = new Set(input.connectedEnvironmentIds);
  const offlineEnvironmentIds: EnvironmentId[] = [];
  const seen = new Set<EnvironmentId>();
  for (const thread of input.visibleThreads) {
    if (connected.has(thread.environmentId) || seen.has(thread.environmentId)) continue;
    seen.add(thread.environmentId);
    offlineEnvironmentIds.push(thread.environmentId);
  }
  if (offlineEnvironmentIds.length === 0) return null;
  if (offlineEnvironmentIds.length === 1) {
    const onlyId = offlineEnvironmentIds[0]!;
    const label = input.environmentLabelById.get(onlyId);
    const message =
      input.environmentLabelById.size > 1 && label
        ? `${label} 已断线，连上后处理`
        : "电脑已断线，连上后处理";
    return { offlineEnvironmentIds, message };
  }
  return {
    offlineEnvironmentIds,
    message: `${offlineEnvironmentIds.length} 台电脑已断线，连上后处理`,
  };
}

// Suppress trailing double-click navigation; keyboard and synthetic clicks use detail 0.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

function nodeClosest(node: object | null, selector: string): unknown {
  if (node === null || !("closest" in node) || typeof node.closest !== "function") return null;
  return node.closest(selector);
}

export function isSidebarNestedLinkClick(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  if (nodeClosest(target, "a[href]") !== null) return true;
  const parent =
    "parentElement" in target &&
    target.parentElement !== null &&
    typeof target.parentElement === "object"
      ? target.parentElement
      : null;
  return nodeClosest(parent, "a[href]") !== null;
}

/** Creates directly when in a current project (unless Shift-overridden) or when <=1 open project exists. */
export function shouldCreateNewThreadInCurrentProject(input: {
  readonly shiftKey: boolean;
  readonly hasCurrentProject: boolean;
  readonly openProjectGroupCount: number;
  readonly projectGroupCount: number;
}): boolean {
  if (input.projectGroupCount === 0) return true;
  if (input.hasCurrentProject) {
    return !(input.shiftKey && input.openProjectGroupCount > 1);
  }
  return input.shiftKey || input.openProjectGroupCount === 1;
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "preparing"
  | "queued"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function shouldRecedeSidebarThread(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
}): boolean {
  if (input.isActive || input.isSelected || input.status === "input") {
    return false;
  }
  if (input.status === "preparing" || input.status === "working" || input.status === "waiting") {
    return true;
  }
  if (input.status === "ready" || input.status === "approval") {
    return !input.isUnread && !input.isWoke;
  }
  return false;
}

type SidebarThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "runtime"
  | "blockedOnThreadWait"
> & {
  readonly pendingRuntimeRequest?: Pick<
    OrchestrationV2PendingRuntimeRequestSummary,
    "kind" | "blocking"
  > | null;
  readonly source?: {
    readonly pendingRuntimeRequest?: Pick<
      OrchestrationV2PendingRuntimeRequestSummary,
      "kind" | "blocking"
    > | null;
  };
};

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  const request = resolvePendingRuntimeRequest(thread);
  const hasApprovals =
    request !== null && request !== undefined
      ? isBlockingApproval(request.kind, request.blocking)
      : thread.hasPendingApprovals;
  const hasUserInput =
    request !== null && request !== undefined
      ? isUserInputRequest(request.kind, request.blocking)
      : thread.hasPendingUserInput;
  if (hasApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (hasUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (thread.runtime?.status === "preparing") {
    return "preparing";
  }
  if (
    thread.runtime?.status === "queued" ||
    (thread.runtime?.status === "starting" && thread.runtime.awaitingSlot === true)
  ) {
    return "queued";
  }
  if (
    thread.runtime !== null &&
    ["starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

/** What the window title says the open thread is doing, in the words its announcer uses. */
export function resolveWindowTitleThreadStatus(thread: SidebarThreadStatusInput): string | null {
  switch (resolveSidebarThreadStatus(thread)) {
    case "approval":
      return THREAD_STATUS_TEXT.approval;
    case "input":
      return THREAD_STATUS_TEXT.input;
    case "queued":
      return "等空位";
    case "preparing":
    case "working":
      return THREAD_STATUS_TEXT.working;
    case "waiting":
      // Waiting on a child thread is still this turn, so it must not read as finished.
      return thread.runtime?.status === "running" ? THREAD_STATUS_TEXT.working : null;
    default:
      return null;
  }
}

export type SidebarV2TopStatusKind =
  | "approval"
  | "done"
  | "failed"
  | "limited"
  | "input"
  | "waiting"
  | "woke"
  | "working";

export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export { sortActiveThreadsByOrderKey as sortThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";
export {
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";

export { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
export { sortCommanderThreads as sortCommanderThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";
export { sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";

const EMPTY_CONTENT_MATCH_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Sidebar search results: title, branch, and pull request matches ranked as
 * the command palette ranks them, then threads listed only because their
 * messages match, in `contentMatchKeys` order.
 */
export function searchSidebarThreads<
  T extends ThreadSearchShell & {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  },
>(
  threads: readonly T[],
  query: string,
  contentMatchKeys: ReadonlySet<string> = EMPTY_CONTENT_MATCH_KEYS,
  now = Date.now(),
): { readonly titleMatches: T[]; readonly contentMatches: T[] } {
  const normalizedQuery = foldSearchQuery(query);
  if (normalizedQuery.length === 0) return { titleMatches: [], contentMatches: [] };
  const titleMatches = rankSearchItems(threads, (thread, options) =>
    scoreThreadSearch(normalizedQuery, threadSearchSubject(thread, null), now, {
      ...options,
      picks: false,
    }),
  ).map(({ item }) => item);
  const listed = new Set(titleMatches);
  // In the order the server ranked their messages, as the palette lists them.
  const threadByKey = new Map(
    threads.map((thread) => [
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      thread,
    ]),
  );
  const contentMatches = [...contentMatchKeys].flatMap((key) => {
    const thread = threadByKey.get(key);
    return thread && !listed.has(thread) ? [thread] : [];
  });
  return { titleMatches, contentMatches };
}

export function pullRequestMatchesSearchQuery(
  pullRequest: Parameters<typeof threadPullRequestSearchTerms>[0],
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return false;
  const haystack = normalizeSearchText(threadPullRequestSearchTerms(pullRequest).join(" "));
  return normalizedQuery.split(" ").every((token) => haystack.includes(token));
}

export function filterSidebarProjectScopeItems<TItem extends { readonly value: string }>(input: {
  items: readonly TItem[];
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  return input.items.filter((item) => item.value !== "all" && input.matches(item, query));
}

interface SidebarProjectScopeMenuState {
  readonly open: boolean;
  readonly query: string;
}

type SidebarProjectScopeMenuAction =
  | { readonly type: "query-changed"; readonly query: string }
  | { readonly type: "open-changed"; readonly open: boolean }
  | { readonly type: "project-settings-opened" };

export function reduceSidebarProjectScopeMenuState(
  state: SidebarProjectScopeMenuState,
  action: SidebarProjectScopeMenuAction,
): SidebarProjectScopeMenuState {
  switch (action.type) {
    case "query-changed":
      return { ...state, query: action.query };
    case "open-changed":
      return { open: action.open, query: "" };
    case "project-settings-opened":
      return { open: false, query: "" };
  }
}

export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestRun" | "runtime">,
): string | null {
  return resolveThreadWorkingStartedAt(thread);
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return {
      label: "等你批准",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return {
      label: "等你回答",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }
  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait !== true) ||
    thread.runtime?.status === "waiting"
  ) {
    return {
      label: "运行中",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    thread.runtime?.status === "queued" ||
    (thread.runtime?.status === "starting" && thread.runtime.awaitingSlot === true)
  ) {
    return {
      label: "等空位",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };
  }

  if (thread.runtime?.status === "preparing" || thread.runtime?.status === "starting") {
    return {
      label: "正在连接",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return {
      label: "等待中",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };
  }

  if (hasUnseenFailure(thread)) {
    return {
      label: "出错了",
      colorClass: "text-red-600 dark:text-red-300/90",
      dotClass: "bg-red-500 dark:bg-red-300/90",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "计划已就绪",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "有新结果",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<
    Thread,
    "id" | "projectId" | "createdAt" | "updatedAt" | "settledOverride" | "lineage"
  > &
    ThreadSortInput &
    ThreadSnoozeShell,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  now: string;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, now, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id) &&
          thread.settledOverride !== "settled" &&
          !effectiveSnoozed(thread, { now }) &&
          !isSidebarHiddenThread(thread),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function sortProjectsByActivity<TProject extends SidebarProject>(
  projects: readonly TProject[],
  sortOrder: SidebarProjectSortOrder,
  getProjectThreads: (project: TProject) => readonly ThreadSortInput[],
  compareTies: (left: TProject, right: TProject) => number,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  // Project timestamps scan all threads; compute once per project instead of per comparison.
  return projects
    .map((project) => ({
      project,
      timestamp: getProjectSortTimestamp(project, getProjectThreads(project), sortOrder),
    }))
    .sort((left, right) => {
      const byTimestamp =
        right.timestamp === left.timestamp ? 0 : right.timestamp > left.timestamp ? 1 : -1;
      return byTimestamp || compareTies(left.project, right.project);
    })
    .map(({ project }) => project);
}

export function sortLogicalProjectsForSidebar<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const groupKeyByProjectRef = new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) =>
          [`${projectRef.environmentId}\0${projectRef.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectKey.get(project.projectKey) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) || left.projectKey.localeCompare(right.projectKey),
  );
}

export function sortSidebarV2ProjectGroups<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread &
    Pick<SidebarThreadSummary, "environmentId" | "id" | "lineage">,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
  delegatedUnderParent: ReadonlySet<string>,
): TProject[] {
  return sortLogicalProjectsForSidebar(
    projects,
    filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent),
    sortOrder,
  );
}

export function sortScopedProjectsForSidebar<
  TProject extends ScopedSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const scopedKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const threadsByProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const key = scopedKey(thread.environmentId, thread.projectId);
    const existing = threadsByProject.get(key) ?? [];
    existing.push(thread);
    threadsByProject.set(key, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProject.get(scopedKey(project.environmentId, project.id)) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
}
