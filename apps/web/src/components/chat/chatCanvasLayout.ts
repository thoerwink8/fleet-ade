export interface PreviewMiniPlayerFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ChatCanvasPreview {
  readonly key: string;
  readonly width: number | null;
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly source: { readonly width: number; readonly height: number };
  readonly lastInteraction?: "drag" | "resize";
}

export const DETAILS_CARD_CLEARANCE = 32;

export function resolveChatCanvasLayout({
  container,
  preview,
  padding = 48,
  maxChatWidth = 768,
  minChatWidth = 640,
  composerHeight = 0,
  detailsCard = null,
  findBar = null,
}: {
  container: { readonly width: number; readonly height: number };
  preview: ChatCanvasPreview | null;
  padding?: number;
  maxChatWidth?: number;
  minChatWidth?: number;
  composerHeight?: number;
  detailsCard?: { readonly left: number; readonly right: number; readonly bottom: number } | null;
  findBar?: { readonly left: number; readonly right: number; readonly bottom: number } | null;
}) {
  const centeredWidth = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  const laneRight = detailsCard
    ? detailsCard.left - DETAILS_CARD_CLEARANCE
    : container.width - padding;
  const normalWidth = Math.max(0, Math.min(centeredWidth, laneRight - padding));
  const canvasCenterLeft = (container.width - normalWidth) / 2;
  const normalLeft = Math.max(padding, Math.min(canvasCenterLeft, laneRight - normalWidth));
  let chat = {
    left: normalLeft,
    width: normalWidth,
    insetStart: 0,
    insetEnd: Math.max(0, container.width - normalLeft * 2 - normalWidth),
  };
  void preview;
  void minChatWidth;
  void composerHeight;
  void findBar;
  const frame: PreviewMiniPlayerFrame | null = null;
  return { chat, frame, overlapsChat: false, overlapsDetailsCard: false };
}
