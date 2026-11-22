import { DEFAULT_UNIFIED_SETTINGS, type FontScale } from "@t3tools/contracts/settings";
import { FONT_SCALES } from "../../appearanceFonts";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const FONT_SCALE_LABELS: Record<FontScale, string> = {
  standard: "标准",
  comfortable: "舒适",
  large: "大",
};

function isFontScale(value: unknown): value is FontScale {
  return value === "standard" || value === "comfortable" || value === "large";
}

function FontScaleRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("font-size")}
      description="界面、输入框、会话正文、代码和终端一起放大或缩小。"
      resetAction={
        settings.fontScale !== DEFAULT_UNIFIED_SETTINGS.fontScale ? (
          <SettingResetButton
            label="字号"
            onClick={() => updateSettings({ fontScale: DEFAULT_UNIFIED_SETTINGS.fontScale })}
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-40">
          <Select
            value={settings.fontScale}
            onValueChange={(value) => {
              if (isFontScale(value)) updateSettings({ fontScale: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label="字号">
              <SelectValue>{FONT_SCALE_LABELS[settings.fontScale]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(FONT_SCALE_LABELS) as FontScale[]).map((scale) => (
                <SelectItem key={scale} value={scale}>
                  {`${FONT_SCALE_LABELS[scale]}（正文 ${FONT_SCALES[scale].prose} px）`}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}

function WordWrapRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("word-wrap")}
      description="默认对代码块、差异和文件预览中的长行自动换行。"
      resetAction={
        settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
          <SettingResetButton
            label="自动换行"
            onClick={() => updateSettings({ wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wordWrap}
          onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
          aria-label="默认对代码、差异和文件预览自动换行"
        />
      }
    />
  );
}

export function TypographySection() {
  return (
    <SettingsSection id="typography" title="字体排版">
      <FontScaleRow />
      <WordWrapRow />
    </SettingsSection>
  );
}
