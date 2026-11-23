import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  computeFirstPaintTimelineWindowStart,
  computeInitialTimelineWindowStart,
  expandTimelineWindowStartForIndex,
  nextExpandedTimelineWindowStart,
  projectTimelineWindow,
} from "./timelineWindow";

const CREATED_AT = "2026-03-17T19:12:28.000Z";

function messageRow(id: string, role: "user" | "assistant", text: string): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
    },
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  };
}

describe("timelineWindow", () => {
  it("keeps short threads unwindowed and trims long threads to a recent tail", () => {
    const shortRows = Array.from({ length: 6 }, (_, index) =>
      messageRow(`s-${index}`, index % 2 === 0 ? "user" : "assistant", `Short ${index}`),
    );
    expect(computeInitialTimelineWindowStart(shortRows)).toBe(0);

    const longText = `${"检查这一段会话正文。".repeat(40)}\n\n- 第一条\n- 第二条\n`;
    const longRows = Array.from({ length: 200 }, (_, index) =>
      messageRow(`l-${index}`, index % 2 === 0 ? "user" : "assistant", longText),
    );
    const start = computeInitialTimelineWindowStart(longRows);
    expect(start).toBeGreaterThan(185);
    expect(start).toBeLessThan(200);
  });

  it("paints a smaller tail first only when a hidden prefix exists", () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        messageRow(`r-${index}`, index % 2 === 0 ? "user" : "assistant", `Row ${index}`),
      );
    expect(computeFirstPaintTimelineWindowStart(rows(6))).toBe(0);
    expect(computeFirstPaintTimelineWindowStart(rows(14))).toBe(0);
    expect(computeFirstPaintTimelineWindowStart(rows(15))).toBe(9);
    expect(computeFirstPaintTimelineWindowStart(rows(200))).toBe(194);
  });

  it("maps indices across a pinned leading message and the trailing window", () => {
    const rows = Array.from({ length: 50 }, (_, index) =>
      messageRow(`r-${index}`, index % 2 === 0 ? "user" : "assistant", `Row ${index}`),
    );
    const projection = projectTimelineWindow(rows, 42, 0);
    expect(projection.rows.map((row) => row.id)).toEqual([
      "r-0",
      "r-42",
      "r-43",
      "r-44",
      "r-45",
      "r-46",
      "r-47",
      "r-48",
      "r-49",
    ]);
    expect(projection.toFullIndex(0)).toBe(0);
    expect(projection.toFullIndex(1)).toBe(42);
    expect(projection.toFullIndex(8)).toBe(49);
    expect(projection.toVisibleIndex(0)).toBe(0);
    expect(projection.toVisibleIndex(1)).toBe(-1);
    expect(projection.toVisibleIndex(41)).toBe(-1);
    expect(projection.toVisibleIndex(42)).toBe(1);
    expect(projection.toVisibleIndex(49)).toBe(8);
  });

  it("expands upward in steps and opens to 0 near the start", () => {
    expect(nextExpandedTimelineWindowStart(60)).toBe(36);
    expect(nextExpandedTimelineWindowStart(25)).toBe(0);
    expect(expandTimelineWindowStartForIndex(40, 0)).toBe(0);
    expect(expandTimelineWindowStartForIndex(40, 1)).toBe(0);
    expect(expandTimelineWindowStartForIndex(40, 20)).toBe(16);
    expect(expandTimelineWindowStartForIndex(40, 45)).toBe(40);
  });
});
