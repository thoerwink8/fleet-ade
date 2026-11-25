export type MobileSidebarSide = "left" | "right";

const SWIPE_TOUCH_SLOP_PX = 10;
const SWIPE_MIN_THRESHOLD_PX = 56;
const SWIPE_MAX_THRESHOLD_PX = 96;
const SWIPE_WIDTH_RATIO = 0.3;
const SWIPE_FLICK_MIN_VELOCITY_PX_PER_MS = 0.45;
const SWIPE_FLICK_MIN_DISTANCE_PX = 32;
const SWIPE_DRAG_BACK_CANCEL_VELOCITY_PX_PER_MS = -0.25;

const SWIPE_IGNORE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export interface MobileSidebarSwipeSession {
  readonly side: MobileSidebarSide;
  readonly pointerId: number;
  readonly drawerWidth: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTimeMs: number;
  readonly lastX: number;
  readonly lastTimeMs: number;
  readonly prevX: number;
  readonly prevTimeMs: number;
  readonly phase: "pending" | "dragging" | "ignored";
  readonly offsetPx: number;
}

export interface MobileSidebarSwipeTargetDescriptor {
  readonly tagName?: string | undefined;
  readonly role?: string | null | undefined;
  readonly isContentEditable?: boolean | undefined;
  readonly hasSwipeIgnoreAttr?: boolean | undefined;
  readonly overflowX?: string | undefined;
  readonly scrollWidth?: number | undefined;
  readonly clientWidth?: number | undefined;
}

export function startMobileSidebarSwipe(input: {
  readonly side: MobileSidebarSide;
  readonly pointerId: number;
  readonly drawerWidth: number;
  readonly x: number;
  readonly y: number;
  readonly timeMs: number;
}): MobileSidebarSwipeSession {
  return {
    side: input.side,
    pointerId: input.pointerId,
    drawerWidth: Math.max(0, input.drawerWidth),
    startX: input.x,
    startY: input.y,
    startTimeMs: input.timeMs,
    lastX: input.x,
    lastTimeMs: input.timeMs,
    prevX: input.x,
    prevTimeMs: input.timeMs,
    phase: "pending",
    offsetPx: 0,
  };
}

function clampCloseTravel(
  side: MobileSidebarSide,
  drawerWidth: number,
  dx: number,
): { readonly closeDelta: number; readonly travel: number } {
  const closeDelta = side === "left" ? -dx : dx;
  return {
    closeDelta,
    travel: Math.max(0, Math.min(drawerWidth, closeDelta)),
  };
}

export function updateMobileSidebarSwipe(
  session: MobileSidebarSwipeSession,
  input: { readonly x: number; readonly y: number; readonly timeMs: number },
): {
  readonly session: MobileSidebarSwipeSession;
  readonly offsetPx: number;
} {
  if (session.phase === "ignored") {
    return { session, offsetPx: 0 };
  }

  const dx = input.x - session.startX;
  const dy = input.y - session.startY;
  const { closeDelta, travel } = clampCloseTravel(session.side, session.drawerWidth, dx);

  if (session.phase === "pending") {
    if (Math.hypot(dx, dy) < SWIPE_TOUCH_SLOP_PX) {
      return { session, offsetPx: 0 };
    }
    if (Math.abs(dy) > Math.abs(dx) || closeDelta <= 0 || session.drawerWidth <= 0) {
      const ignoredSession: MobileSidebarSwipeSession = {
        ...session,
        phase: "ignored",
        offsetPx: 0,
      };
      return { session: ignoredSession, offsetPx: 0 };
    }
    const offsetPx = session.side === "left" ? -travel : travel;
    const nextSession: MobileSidebarSwipeSession = {
      ...session,
      phase: "dragging",
      offsetPx,
      prevX: session.lastX,
      prevTimeMs: session.lastTimeMs,
      lastX: input.x,
      lastTimeMs: input.timeMs,
    };
    return { session: nextSession, offsetPx };
  }

  const offsetPx = session.side === "left" ? -travel : travel;
  const shouldShiftHistory = input.timeMs > session.lastTimeMs;
  const nextSession: MobileSidebarSwipeSession = {
    ...session,
    offsetPx,
    prevX: shouldShiftHistory ? session.lastX : session.prevX,
    prevTimeMs: shouldShiftHistory ? session.lastTimeMs : session.prevTimeMs,
    lastX: input.x,
    lastTimeMs: shouldShiftHistory ? input.timeMs : session.lastTimeMs,
  };
  return { session: nextSession, offsetPx };
}

function computeCloseVelocityPxPerMs(
  session: MobileSidebarSwipeSession,
  x: number,
  timeMs: number,
): number {
  let refX = session.startX;
  let refTimeMs = session.startTimeMs;
  if (timeMs > session.lastTimeMs && x !== session.lastX) {
    refX = session.lastX;
    refTimeMs = session.lastTimeMs;
  } else if (timeMs > session.prevTimeMs) {
    refX = session.prevX;
    refTimeMs = session.prevTimeMs;
  }
  const dt = timeMs - refTimeMs;
  if (dt <= 0) return 0;
  const dx = x - refX;
  return (session.side === "left" ? -dx : dx) / dt;
}

export function finishMobileSidebarSwipe(
  session: MobileSidebarSwipeSession,
  input: { readonly x: number; readonly timeMs: number },
): {
  readonly shouldClose: boolean;
  readonly offsetPx: number;
  readonly suppressClick: boolean;
} {
  if (session.phase !== "dragging" || session.drawerWidth <= 0) {
    return { shouldClose: false, offsetPx: 0, suppressClick: false };
  }

  const { travel } = clampCloseTravel(session.side, session.drawerWidth, input.x - session.startX);
  const distanceThreshold = Math.min(
    SWIPE_MAX_THRESHOLD_PX,
    Math.max(SWIPE_MIN_THRESHOLD_PX, session.drawerWidth * SWIPE_WIDTH_RATIO),
  );
  const closeVelocity = computeCloseVelocityPxPerMs(session, input.x, input.timeMs);

  const shouldClose =
    (travel >= distanceThreshold && closeVelocity > SWIPE_DRAG_BACK_CANCEL_VELOCITY_PX_PER_MS) ||
    (travel >= SWIPE_FLICK_MIN_DISTANCE_PX && closeVelocity >= SWIPE_FLICK_MIN_VELOCITY_PX_PER_MS);

  return {
    shouldClose,
    offsetPx: 0,
    suppressClick: true,
  };
}

export function isMobileSidebarSwipeIgnoredTarget(
  ancestors: ReadonlyArray<MobileSidebarSwipeTargetDescriptor>,
): boolean {
  for (const node of ancestors) {
    const tag = node.tagName?.toUpperCase();
    if (tag && SWIPE_IGNORE_TAGS.has(tag)) return true;
    if (node.isContentEditable) return true;
    if (node.role?.toLowerCase() === "slider") return true;
    if (node.hasSwipeIgnoreAttr) return true;
    if (
      (node.overflowX === "auto" || node.overflowX === "scroll") &&
      (node.scrollWidth ?? 0) > (node.clientWidth ?? 0) + 1
    ) {
      return true;
    }
  }
  return false;
}

export function shouldIgnoreMobileSidebarSwipeTarget(
  target: EventTarget | null,
  boundary: HTMLElement | null,
): boolean {
  if (!(target instanceof Element)) return false;

  const ancestors: MobileSidebarSwipeTargetDescriptor[] = [];
  let current: Element | null = target;
  while (current !== null) {
    const style = window.getComputedStyle(current);
    ancestors.push({
      tagName: current.tagName,
      role: current.getAttribute("role"),
      isContentEditable: current instanceof HTMLElement ? current.isContentEditable : false,
      hasSwipeIgnoreAttr: current.hasAttribute("data-sidebar-swipe-ignore"),
      overflowX: style.overflowX,
      scrollWidth: current.scrollWidth,
      clientWidth: current.clientWidth,
    });
    if (current === boundary) break;
    current = current.parentElement;
  }

  return isMobileSidebarSwipeIgnoredTarget(ancestors);
}

export function setElementPointerCapture(element: Element | null, pointerId: number): void {
  if (!element || typeof element.setPointerCapture !== "function") return;
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Synthetic or already-released pointers throw InvalidStateError.
  }
}

export function releaseElementPointerCapture(element: Element | null, pointerId: number): void {
  if (!element || typeof element.releasePointerCapture !== "function") return;
  try {
    if (typeof element.hasPointerCapture !== "function" || element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  } catch {
    // Ignore errors when pointer capture was already released.
  }
}
