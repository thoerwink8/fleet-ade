import { createFileRoute } from "@tanstack/react-router";

import { KeybindingsSettingsPanel } from "../components/settings/KeybindingsSettings";
import { NetworkSettingsPanel } from "../components/settings/NetworkSettings";
import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";
import {
  SettingsEnvironmentScopeGate,
  SettingsPageContainer,
} from "../components/settings/settingsLayout";

function SettingsGeneralRoute() {
  return (
    <SettingsPageContainer>
      <GeneralSettingsPanel />
      <SettingsEnvironmentScopeGate>
        <NetworkSettingsPanel />
        <KeybindingsSettingsPanel />
      </SettingsEnvironmentScopeGate>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/general")({
  component: SettingsGeneralRoute,
});
