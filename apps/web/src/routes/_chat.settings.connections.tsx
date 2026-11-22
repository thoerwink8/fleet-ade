import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";
import { SecretsSettingsPanel } from "../components/settings/SecretsSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { isSecretsFeatureEnabled } from "../env";

function SettingsConnectionsRoute() {
  return (
    <SettingsPageContainer>
      <ConnectionsSettings view="all" />
      {isSecretsFeatureEnabled ? <SecretsSettingsPanel /> : null}
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/connections")({
  component: SettingsConnectionsRoute,
});
