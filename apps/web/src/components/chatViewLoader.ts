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

let pendingHighlighterLoad: Promise<unknown> | null = null;

export function preloadHighlighter(): void {
  // The highlights chunk is only fetched once a render asks for highlighting, which is after first
  // paint. Starting it here overlaps the download with the shell request. It stays a dynamic import,
  // so it never joins the main bundle.
  if (pendingHighlighterLoad !== null) return;
  pendingHighlighterLoad = import("../lib/syntaxHighlighting")
    .then((module) => module.getSyntaxHighlighterPromise("text"))
    .catch(() => {
      pendingHighlighterLoad = null;
    });
}
