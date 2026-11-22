import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/ArchivedThreadsPanel";
import { ChatSettingsPanel, ThreadsSettingsPanel } from "../components/settings/SettingsPanels";
import {
  SettingsEnvironmentScopeGate,
  SettingsPageContainer,
} from "../components/settings/settingsLayout";

function SettingsThreadsRoute() {
  return (
    <SettingsPageContainer>
      <ChatSettingsPanel />
      <SettingsEnvironmentScopeGate>
        <ThreadsSettingsPanel />
      </SettingsEnvironmentScopeGate>
      <ArchivedThreadsPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/threads")({
  component: SettingsThreadsRoute,
});
