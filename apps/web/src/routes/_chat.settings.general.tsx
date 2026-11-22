import { createFileRoute } from "@tanstack/react-router";

import { KeybindingsSettingsPanel } from "../components/settings/KeybindingsSettings";
import { NetworkSettingsPanel } from "../components/settings/NetworkSettings";
import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsGeneralRoute() {
  return (
    <SettingsPageContainer>
      <GeneralSettingsPanel />
      <NetworkSettingsPanel />
      <KeybindingsSettingsPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/general")({
  component: SettingsGeneralRoute,
});
