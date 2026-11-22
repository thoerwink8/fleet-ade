import { createFileRoute } from "@tanstack/react-router";

import { AppearanceSettingsPanel } from "../components/settings/AppearanceSettingsPanel";
import { DiffsSettingsPanel } from "../components/settings/SettingsPanels";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsAppearanceRoute() {
  return (
    <SettingsPageContainer>
      <AppearanceSettingsPanel />
      <DiffsSettingsPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/appearance")({
  component: SettingsAppearanceRoute,
});
