import { lazy } from "react";

type ChatViewModule = typeof import("./ChatView");

let pendingChatViewLoad: Promise<ChatViewModule> | null = null;

function loadChatView(): Promise<ChatViewModule> {
  if (pendingChatViewLoad !== null) {
    return pendingChatViewLoad;
  }
  const request = import("./ChatView").catch((error: unknown) => {
    if (pendingChatViewLoad === request) {
      pendingChatViewLoad = null;
    }
    throw error;
  });
  pendingChatViewLoad = request;
  return request;
}

export const LazyChatView = lazy(loadChatView);

export function preloadChatView(): void {
  // Start downloading the chunk in parallel without blocking route load or surfacing unhandled rejections.
  void loadChatView().catch(() => {});
}
