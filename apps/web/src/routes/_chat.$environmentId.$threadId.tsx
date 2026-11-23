import { createFileRoute } from "@tanstack/react-router";

import { preloadChatView, preloadHighlighter } from "../components/chatViewLoader";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  beforeLoad: () => {
    preloadChatView();
    preloadHighlighter();
  },
  component: () => null,
});
