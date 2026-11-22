import { createFileRoute } from "@tanstack/react-router";

import { SettingsPathMissingView } from "../components/settings/SettingsPathMissingView";

// One segment under /settings otherwise matches /$environmentId/$threadId.
export const Route = createFileRoute("/_chat/settings/$section")({
  component: SettingsPathMissingView,
});
