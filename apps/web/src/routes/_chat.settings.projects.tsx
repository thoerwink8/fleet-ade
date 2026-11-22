import { createFileRoute } from "@tanstack/react-router";

import { ProjectsSettings } from "../components/settings/ProjectsSettings";
import { SourceControlSettingsPanel } from "../components/settings/SourceControlSettings";
import { WorktreesSettingsPanel } from "../components/settings/WorktreesSettings";
import {
  SettingsEnvironmentScopeGate,
  SettingsPageContainer,
} from "../components/settings/settingsLayout";

function SettingsProjectsRoute() {
  return (
    <SettingsPageContainer>
      <ProjectsSettings />
      <SettingsEnvironmentScopeGate>
        <SourceControlSettingsPanel />
        <WorktreesSettingsPanel />
      </SettingsEnvironmentScopeGate>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/projects")({
  component: SettingsProjectsRoute,
});
