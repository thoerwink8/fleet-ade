import { createFileRoute } from "@tanstack/react-router";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function CommanderSettingsPlaceholderPanel() {
  return (
    <SettingsPageContainer>
      <section className="space-y-2">
        <h2 className="text-lg font-medium tracking-tight">指挥</h2>
        <p className="text-row text-muted-foreground">
          指挥会话的派遣台账与设置将在后续版本提供，可先通过会话菜单、命令面板或快捷键标记与取消指挥会话。
        </p>
      </section>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/commander")({
  component: CommanderSettingsPlaceholderPanel,
});
