import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  hasCommanderDispatchConfig,
  shouldShowCommanderMenuAction,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  surface: "sidebar",
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running, with an inline reason", () => {
    const runningItems = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(runningItems.find((item) => item.id === "archive")).toMatchObject({
      disabled: true,
      detail: "运行中，请先停止",
    });
    expect(runningItems.find((item) => item.id === "turn-into-project")).toMatchObject({
      disabled: true,
      detail: "运行中，请先停止",
    });

    const idleItems = buildThreadActionMenuItems({
      ...baseState,
      isRunning: false,
      canTurnIntoProject: true,
    });
    expect(idleItems.find((item) => item.id === "archive")?.disabled).toBe(false);
    expect(idleItems.find((item) => item.id === "archive")?.detail).toBeUndefined();
  });

  it("toggles mark-commander and unmark-commander independently of pin state", () => {
    const pinnedNotCommander = buildThreadActionMenuItems({
      ...baseState,
      isPinned: true,
      isCommander: false,
      hasCommanderConfig: true,
      supports: { ...baseState.supports, commander: true },
    });
    expect(pinnedNotCommander.some((item) => item.id === "unpin")).toBe(true);
    expect(pinnedNotCommander.some((item) => item.id === "mark-commander")).toBe(true);

    const commanderNotPinned = buildThreadActionMenuItems({
      ...baseState,
      isPinned: false,
      isCommander: true,
      supports: { ...baseState.supports, commander: true },
    });
    expect(commanderNotPinned.some((item) => item.id === "pin")).toBe(true);
    expect(commanderNotPinned.some((item) => item.id === "unmark-commander")).toBe(true);

    const readOnly = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      isCommander: false,
      hasAnyCommanderThread: true,
      supports: { ...baseState.supports, commander: true },
    });
    expect(readOnly.find((item) => item.id === "mark-commander")?.disabled).toBe(true);
  });

  it("keeps common menu items identical across sidebar and chat-header while isolating declared surface items", () => {
    const sharedInput: Omit<ThreadActionMenuState, "surface"> = {
      ...baseState,
      canFind: true,
      canExport: true,
      branch: "feature/b11",
      projectFilter: { label: "Demo", isActive: false },
      attentionDismissible: true,
      canTurnIntoProject: true,
      hasCommanderConfig: true,
      supports: { ...baseState.supports, commander: true },
    };

    const sidebarItems = buildThreadActionMenuItems({ ...sharedInput, surface: "sidebar" });
    const headerItems = buildThreadActionMenuItems({ ...sharedInput, surface: "chat-header" });

    expect(sidebarItems.some((item) => item.id === "find")).toBe(false);
    expect(headerItems.some((item) => item.id === "find")).toBe(true);
    expect(sidebarItems.some((item) => item.id === "filter-by-project")).toBe(true);
    expect(headerItems.some((item) => item.id === "filter-by-project")).toBe(false);

    expect(sidebarItems.some((item) => item.id === "export-markdown")).toBe(true);
    expect(headerItems.some((item) => item.id === "export-markdown")).toBe(true);
    expect(sidebarItems.some((item) => item.id === "dismiss-attention")).toBe(true);
    expect(headerItems.some((item) => item.id === "dismiss-attention")).toBe(true);

    const commonFromSidebar = sidebarItems.filter((item) => item.id !== "filter-by-project");
    const commonFromHeader = headerItems.filter((item) => item.id !== "find");
    expect(commonFromSidebar).toEqual(commonFromHeader);
  });

  it("gates commander menu actions on commander usage or dispatch config", () => {
    expect(hasCommanderDispatchConfig(undefined)).toBe(false);
    expect(
      hasCommanderDispatchConfig({
        commanderInstructions: "   ",
        dispatchCodeModelSelection: null,
        dispatchReviewModelSelection: null,
        dispatchReadonlyModelSelection: null,
        dispatchPlanModelSelection: null,
        dispatchCommanderModelSelection: null,
        dispatchConcurrencyLimit: null,
        dispatchTimeoutMs: null,
        dispatchStopOnTimeout: false,
      }),
    ).toBe(false);
    expect(hasCommanderDispatchConfig({ commanderInstructions: "先检查测试" })).toBe(true);
    expect(
      hasCommanderDispatchConfig({ dispatchCodeModelSelection: { instanceId: "x", model: "y" } }),
    ).toBe(true);
    expect(hasCommanderDispatchConfig({ dispatchConcurrencyLimit: 2 })).toBe(true);
    expect(hasCommanderDispatchConfig({ dispatchStopOnTimeout: true })).toBe(true);

    expect(
      shouldShowCommanderMenuAction({
        commanderSupported: true,
        isCommander: false,
        hasAnyCommanderThread: false,
        hasCommanderConfig: false,
      }),
    ).toBe(false);
    expect(
      shouldShowCommanderMenuAction({
        commanderSupported: false,
        isCommander: true,
        hasAnyCommanderThread: true,
        hasCommanderConfig: true,
      }),
    ).toBe(false);

    const hiddenItems = buildThreadActionMenuItems({
      ...baseState,
      isCommander: false,
      hasAnyCommanderThread: false,
      hasCommanderConfig: false,
      supports: { ...baseState.supports, commander: true },
    });
    expect(
      hiddenItems.some((item) => item.id === "mark-commander" || item.id === "unmark-commander"),
    ).toBe(false);

    const shownByThread = buildThreadActionMenuItems({
      ...baseState,
      isCommander: false,
      hasAnyCommanderThread: true,
      hasCommanderConfig: false,
      supports: { ...baseState.supports, commander: true },
    });
    expect(shownByThread.some((item) => item.id === "mark-commander")).toBe(true);
  });

  it("keeps export-markdown enabled for read-only clients when canExport is true", () => {
    const hidden = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
    });
    expect(hidden.some((item) => item.id === "export-markdown")).toBe(false);

    const visible = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      canExport: true,
    });
    const exportIndex = visible.findIndex((item) => item.id === "export-markdown");
    const copyIndex = visible.findIndex((item) => item.id === "copy");
    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBe(copyIndex - 1);
    expect(visible[exportIndex]).toMatchObject({
      id: "export-markdown",
      label: "导出为 Markdown",
      icon: "download",
      separatorBefore: true,
    });
    expect(visible[exportIndex]?.disabled).not.toBe(true);
  });
});
