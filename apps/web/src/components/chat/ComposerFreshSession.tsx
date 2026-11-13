import { EraserIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Shown while `/clear` is armed; dismissing it keeps the current conversation. */
export function freshSessionBannerItem(onUndo: () => void): ComposerBannerStackItem {
  return {
    id: "fresh-session",
    variant: "info",
    icon: <EraserIcon />,
    title: "你的下一条消息将以全新上下文开始",
    description: "智能体将看不到这个会话里之前的消息。",
    dismissLabel: "保留当前上下文",
    onDismiss: onUndo,
  };
}
