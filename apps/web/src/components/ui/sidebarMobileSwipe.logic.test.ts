import { describe, expect, it } from "vite-plus/test";

import {
  finishMobileSidebarSwipe,
  isMobileSidebarSwipeIgnoredTarget,
  startMobileSidebarSwipe,
  updateMobileSidebarSwipe,
} from "./sidebarMobileSwipe.logic";

describe("sidebarMobileSwipe.logic", () => {
  it("stays pending within touch slop (< 10px) without translating", () => {
    const start = startMobileSidebarSwipe({
      side: "left",
      pointerId: 1,
      drawerWidth: 342,
      x: 240,
      y: 300,
      timeMs: 100,
    });

    const step = updateMobileSidebarSwipe(start, { x: 233, y: 304, timeMs: 120 });
    expect(step.session.phase).toBe("pending");
    expect(step.offsetPx).toBe(0);

    const end = finishMobileSidebarSwipe(step.session, { x: 233, y: 304, timeMs: 130 });
    expect(end.shouldClose).toBe(false);
    expect(end.suppressClick).toBe(false);
    expect(end.offsetPx).toBe(0);
  });

  it("ignores vertical scrolls and wrong-direction swipes once past slop", () => {
    const verticalStart = startMobileSidebarSwipe({
      side: "left",
      pointerId: 1,
      drawerWidth: 342,
      x: 200,
      y: 200,
      timeMs: 0,
    });
    const verticalMove = updateMobileSidebarSwipe(verticalStart, { x: 194, y: 220, timeMs: 16 });
    expect(verticalMove.session.phase).toBe("ignored");
    expect(verticalMove.offsetPx).toBe(0);

    const furtherHorizontalAfterVertical = updateMobileSidebarSwipe(verticalMove.session, {
      x: 80,
      y: 225,
      timeMs: 32,
    });
    expect(furtherHorizontalAfterVertical.session.phase).toBe("ignored");
    expect(furtherHorizontalAfterVertical.offsetPx).toBe(0);

    const wrongDirStart = startMobileSidebarSwipe({
      side: "left",
      pointerId: 2,
      drawerWidth: 342,
      x: 150,
      y: 200,
      timeMs: 0,
    });
    const wrongDirMove = updateMobileSidebarSwipe(wrongDirStart, { x: 170, y: 201, timeMs: 16 });
    expect(wrongDirMove.session.phase).toBe("ignored");
    expect(wrongDirMove.offsetPx).toBe(0);
  });

  it("clamps distance threshold to 30% of drawerWidth within [56, 96]px for left drawer", () => {
    // 30% of 342 = 102.6 -> clamped to 96px
    const startWide = startMobileSidebarSwipe({
      side: "left",
      pointerId: 1,
      drawerWidth: 342,
      x: 260,
      y: 300,
      timeMs: 0,
    });
    const moveBelow = updateMobileSidebarSwipe(startWide, { x: 165, y: 302, timeMs: 1000 });
    expect(moveBelow.session.phase).toBe("dragging");
    expect(moveBelow.offsetPx).toBe(-95);
    expect(finishMobileSidebarSwipe(moveBelow.session, { x: 165, y: 302, timeMs: 1016 })).toEqual({
      shouldClose: false,
      offsetPx: 0,
      suppressClick: true,
    });

    const moveAtThreshold = updateMobileSidebarSwipe(startWide, { x: 164, y: 300, timeMs: 1000 });
    expect(moveAtThreshold.offsetPx).toBe(-96);
    expect(
      finishMobileSidebarSwipe(moveAtThreshold.session, { x: 164, y: 300, timeMs: 1016 }),
    ).toEqual({
      shouldClose: true,
      offsetPx: 0,
      suppressClick: true,
    });

    // 30% of 120 = 36 -> clamped to min 56px
    const startNarrow = startMobileSidebarSwipe({
      side: "left",
      pointerId: 2,
      drawerWidth: 120,
      x: 110,
      y: 200,
      timeMs: 0,
    });
    const narrowShort = updateMobileSidebarSwipe(startNarrow, { x: 55, y: 200, timeMs: 1000 });
    expect(
      finishMobileSidebarSwipe(narrowShort.session, { x: 55, y: 200, timeMs: 1016 }).shouldClose,
    ).toBe(false);
    const narrowEnough = updateMobileSidebarSwipe(startNarrow, { x: 54, y: 200, timeMs: 1000 });
    expect(
      finishMobileSidebarSwipe(narrowEnough.session, { x: 54, y: 200, timeMs: 1016 }).shouldClose,
    ).toBe(true);
  });

  it("supports right drawer closing swipes (+X) and rejects dragging beyond drawerWidth", () => {
    const startRight = startMobileSidebarSwipe({
      side: "right",
      pointerId: 3,
      drawerWidth: 260, // 30% = 78px (within 56..96)
      x: 100,
      y: 200,
      timeMs: 0,
    });
    const wrongDirRight = updateMobileSidebarSwipe(startRight, { x: 80, y: 200, timeMs: 16 });
    expect(wrongDirRight.session.phase).toBe("ignored");

    const dragRight = updateMobileSidebarSwipe(startRight, { x: 179, y: 202, timeMs: 800 });
    expect(dragRight.session.phase).toBe("dragging");
    expect(dragRight.offsetPx).toBe(79);
    expect(finishMobileSidebarSwipe(dragRight.session, { x: 179, y: 202, timeMs: 816 })).toEqual({
      shouldClose: true,
      offsetPx: 0,
      suppressClick: true,
    });

    const overDragRight = updateMobileSidebarSwipe(startRight, { x: 500, y: 200, timeMs: 100 });
    expect(overDragRight.offsetPx).toBe(260);
  });

  it("closes on fast flicks (>= 0.45 px/ms with >= 32px travel) and cancels on drag-back", () => {
    const start = startMobileSidebarSwipe({
      side: "left",
      pointerId: 4,
      drawerWidth: 342,
      x: 240,
      y: 300,
      timeMs: 0,
    });
    // Only 40px travel (< 96px threshold) at 40/50 = 0.8 px/ms -> closes
    const flick1 = updateMobileSidebarSwipe(start, { x: 220, y: 300, timeMs: 25 });
    const flick2 = updateMobileSidebarSwipe(flick1.session, { x: 200, y: 300, timeMs: 50 });
    expect(
      finishMobileSidebarSwipe(flick2.session, { x: 200, y: 300, timeMs: 55 }).shouldClose,
    ).toBe(true);

    // 25px travel (< 32px min travel even at high velocity) -> stays open
    const tinyFlick = updateMobileSidebarSwipe(start, { x: 215, y: 300, timeMs: 15 });
    expect(
      finishMobileSidebarSwipe(tinyFlick.session, { x: 215, y: 300, timeMs: 20 }).shouldClose,
    ).toBe(false);

    // Drag past threshold then reverse back toward open edge -> cancels close
    const dragOut = updateMobileSidebarSwipe(start, { x: 120, y: 300, timeMs: 100 });
    const dragBack = updateMobileSidebarSwipe(dragOut.session, { x: 205, y: 300, timeMs: 140 });
    expect(
      finishMobileSidebarSwipe(dragBack.session, { x: 205, y: 300, timeMs: 150 }).shouldClose,
    ).toBe(false);
  });

  it("identifies ignored interactive/editable and horizontally scrollable targets", () => {
    expect(
      isMobileSidebarSwipeIgnoredTarget([
        { tagName: "SPAN" },
        { tagName: "BUTTON" },
        { tagName: "DIV", overflowX: "visible", scrollWidth: 300, clientWidth: 300 },
      ]),
    ).toBe(false);

    expect(isMobileSidebarSwipeIgnoredTarget([{ tagName: "INPUT" }])).toBe(true);
    expect(isMobileSidebarSwipeIgnoredTarget([{ tagName: "TEXTAREA" }])).toBe(true);
    expect(isMobileSidebarSwipeIgnoredTarget([{ tagName: "SELECT" }])).toBe(true);
    expect(isMobileSidebarSwipeIgnoredTarget([{ tagName: "DIV", isContentEditable: true }])).toBe(
      true,
    );
    expect(isMobileSidebarSwipeIgnoredTarget([{ tagName: "DIV", role: "slider" }])).toBe(true);
    expect(isMobileSidebarSwipeIgnoredTarget([{ tagName: "DIV", hasSwipeIgnoreAttr: true }])).toBe(
      true,
    );
    expect(
      isMobileSidebarSwipeIgnoredTarget([
        { tagName: "SPAN" },
        { tagName: "DIV", overflowX: "auto", scrollWidth: 420, clientWidth: 280 },
      ]),
    ).toBe(true);
    expect(
      isMobileSidebarSwipeIgnoredTarget([
        { tagName: "SPAN" },
        { tagName: "DIV", overflowX: "hidden", scrollWidth: 420, clientWidth: 280 },
      ]),
    ).toBe(false);
  });
});
