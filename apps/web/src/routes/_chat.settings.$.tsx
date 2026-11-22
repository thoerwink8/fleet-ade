import { createFileRoute } from "@tanstack/react-router";

import { SettingsPathMissingView } from "../components/settings/SettingsPathMissingView";

// Without this splat, /settings/<one segment> matches /$environmentId/$threadId.
export const Route = createFileRoute("/_chat/settings/$")({
  component: SettingsPathMissingView,
});
