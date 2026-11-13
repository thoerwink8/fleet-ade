import { createFileRoute } from "@tanstack/react-router";

import { NetworkSettingsPanel } from "../components/settings/NetworkSettings";

function SettingsNetworkRoute() {
  return <NetworkSettingsPanel />;
}

export const Route = createFileRoute("/_chat/settings/network")({
  component: SettingsNetworkRoute,
});
