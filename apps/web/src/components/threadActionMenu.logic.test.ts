import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
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

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("toggles mark-commander and unmark-commander independently of pin state", () => {
    const pinnedNotCommander = buildThreadActionMenuItems({
      ...baseState,
      isPinned: true,
      isCommander: false,
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
      supports: { ...baseState.supports, commander: true },
    });
    expect(readOnly.find((item) => item.id === "mark-commander")?.disabled).toBe(true);
  });
});
