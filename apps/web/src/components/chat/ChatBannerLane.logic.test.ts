import { describe, expect, it } from "vite-plus/test";

import {
  createChatBannerAppearance,
  orderChatBannerItems,
  registerChatBannerAppearance,
  visibleChatBannerItems,
} from "./ChatBannerLane.logic";

describe("orderChatBannerItems", () => {
  it("keeps a single banner as-is", () => {
    const items = [{ id: "engine", severity: "error" as const, appearedAt: 0 }];
    expect(orderChatBannerItems(items)).toEqual(items);
  });

  it("puts errors before warnings and other banners", () => {
    const ordered = orderChatBannerItems([
      { id: "note", severity: "other" as const, appearedAt: 2 },
      { id: "provider", severity: "warning" as const, appearedAt: 1 },
      { id: "thread", severity: "error" as const, appearedAt: 0 },
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["thread", "provider", "note"]);
  });

  it("orders the newest banner first within one severity", () => {
    const ordered = orderChatBannerItems([
      { id: "engine", severity: "error" as const, appearedAt: 0 },
      { id: "thread", severity: "error" as const, appearedAt: 1 },
      { id: "provider", severity: "warning" as const, appearedAt: 2 },
      { id: "older-warning", severity: "warning" as const, appearedAt: 0 },
    ]);
    expect(ordered.map((item) => item.id)).toEqual([
      "thread",
      "engine",
      "provider",
      "older-warning",
    ]);
  });
});

describe("visibleChatBannerItems", () => {
  const ordered = [
    { id: "thread", severity: "error" as const, appearedAt: 2 },
    { id: "engine", severity: "error" as const, appearedAt: 0 },
    { id: "provider", severity: "warning" as const, appearedAt: 1 },
  ];

  it("shows only the highest-priority strip when collapsed", () => {
    const { visible, hiddenCount } = visibleChatBannerItems(ordered, false);
    expect(visible.map((item) => item.id)).toEqual(["thread"]);
    expect(hiddenCount).toBe(2);
  });

  it("lists every strip when expanded", () => {
    const { visible, hiddenCount } = visibleChatBannerItems(ordered, true);
    expect(visible.map((item) => item.id)).toEqual(["thread", "engine", "provider"]);
    expect(hiddenCount).toBe(0);
  });

  it("hides the summary for a single banner", () => {
    const { visible, hiddenCount } = visibleChatBannerItems(ordered.slice(0, 1), false);
    expect(visible).toHaveLength(1);
    expect(hiddenCount).toBe(0);
  });
});

describe("registerChatBannerAppearance", () => {
  it("assigns increasing sequences to newly appearing banners", () => {
    const first = createChatBannerAppearance(["engine"]);
    const second = registerChatBannerAppearance(first, ["engine", "thread"]);
    expect(second.order.get("engine")).toBe(0);
    expect(second.order.get("thread")).toBe(1);
    expect(registerChatBannerAppearance(second, ["engine", "thread"])).toBe(second);
  });
});
