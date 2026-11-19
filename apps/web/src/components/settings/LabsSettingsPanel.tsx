import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Features still settling in. */
export function LabsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title="测试版">
        <PromptSuggestionsRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function PromptSuggestionsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("prompt-suggestions-beta")}
      settingKeys={["promptSuggestionsEnabled"]}
      description="Claude 或 Codex 完成一轮回复后，在空输入框中预测下一条消息。按 Tab 使用它。每次预测都会在你的套餐上产生一次额外的缓存请求。需要 Codex 0.165+。Claude 会话在重启后更新。"
      control={
        <ScopedSwitch
          settingKeys={["promptSuggestionsEnabled"]}
          checked={settings.promptSuggestionsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
          }
          aria-label="建议下一条提示词"
        />
      }
    />
  );
}
