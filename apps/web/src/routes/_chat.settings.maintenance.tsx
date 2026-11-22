import { createFileRoute } from "@tanstack/react-router";

import {
  AboutSettingsPanel,
  MaintenanceSettingsPanel,
} from "../components/settings/SettingsPanels";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsMaintenanceRoute() {
  return (
    <SettingsPageContainer>
      <MaintenanceSettingsPanel />
      <AboutSettingsPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/maintenance")({
  component: SettingsMaintenanceRoute,
});
