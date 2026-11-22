import { createFileRoute } from "@tanstack/react-router";

import {
  AboutSettingsPanel,
  MaintenanceSettingsPanel,
} from "../components/settings/SettingsPanels";
import {
  SettingsEnvironmentScopeGate,
  SettingsPageContainer,
} from "../components/settings/settingsLayout";

function SettingsMaintenanceRoute() {
  return (
    <SettingsPageContainer>
      <SettingsEnvironmentScopeGate>
        <MaintenanceSettingsPanel />
      </SettingsEnvironmentScopeGate>
      <AboutSettingsPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/maintenance")({
  component: SettingsMaintenanceRoute,
});
