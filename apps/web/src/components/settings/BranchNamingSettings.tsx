import { BranchNamingMode, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { DraftInput, DraftTextarea } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const MODES = {
  static: "固定前缀",
  semantic: "语义前缀",
  custom: "自定义指令",
} satisfies Record<BranchNamingMode, string>;

export function BranchNamingSettings() {
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const updateSettings = useUpdateScopedSettings();
  const modeMixed = useScopedSettingsMixed(["branchNamingMode"]);
  const prefixMixed = useScopedSettingsMixed(["branchNamePrefix"]);
  const instructionsMixed = useScopedSettingsMixed(["branchNameInstructions"]);

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["branchNamingMode"]}
        {...searchableSetting("worktree-branch-naming")}
        description="选择如何根据你的第一条消息为新工作树分支命名。"
        status={
          !modeMixed && settings.branchNamingMode === "semantic"
            ? "模型会选择描述任务的前缀，例如 feat/add-search、fix/login-timeout 或 refactor/auth。"
            : undefined
        }
        resetAction={
          settings.branchNamingMode !== DEFAULT_SERVER_SETTINGS.branchNamingMode || modeMixed ? (
            <SettingResetButton
              label="分支命名"
              onClick={() =>
                updateSettings({ branchNamingMode: DEFAULT_SERVER_SETTINGS.branchNamingMode })
              }
            />
          ) : null
        }
        control={
          <Select
            value={modeMixed ? null : settings.branchNamingMode}
            onValueChange={(value) => {
              if (BranchNamingMode.literals.includes(value as BranchNamingMode)) {
                updateSettings({ branchNamingMode: value as BranchNamingMode });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="工作树分支命名">
              <SelectValue>
                {(value: BranchNamingMode | null) => (value === null ? "多项不同" : MODES[value])}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BranchNamingMode.literals.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {MODES[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {!modeMixed && settings.branchNamingMode === "static" ? (
        <SettingsRow
          serverScoped
          settingKeys={["branchNamePrefix"]}
          title="分支前缀"
          description="例如，t3 或 t3/ 会生成 t3/add-search。留空则不添加前缀。"
          resetAction={
            prefixMixed ||
            settings.branchNamePrefix !== DEFAULT_SERVER_SETTINGS.branchNamePrefix ? (
              <SettingResetButton
                label="分支前缀"
                onClick={() =>
                  updateSettings({ branchNamePrefix: DEFAULT_SERVER_SETTINGS.branchNamePrefix })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              key={scopeKey}
              aria-label="分支前缀"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={prefixMixed ? "多项不同" : "无前缀"}
              value={prefixMixed ? "" : settings.branchNamePrefix}
              onCommit={(next) => {
                const value = next.trim();
                if (!prefixMixed && value === settings.branchNamePrefix) return;
                return updateSettings({ branchNamePrefix: value });
              }}
            />
          }
        />
      ) : null}
      {!modeMixed && settings.branchNamingMode === "custom" ? (
        <SettingsRow
          serverScoped
          settingKeys={["branchNameInstructions"]}
          title="分支命名指令"
          description="追加到命名提示词中。模型返回完整的分支名，不再添加前缀或后缀。"
          resetAction={
            instructionsMixed || settings.branchNameInstructions !== "" ? (
              <SettingResetButton
                label="分支命名指令"
                onClick={() => updateSettings({ branchNameInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <DraftTextarea
              key={scopeKey}
              aria-label="分支命名指令"
              rows={4}
              value={instructionsMixed ? "" : settings.branchNameInstructions}
              placeholder={
                instructionsMixed
                  ? "多项不同。输入指令后将应用到所有所选目标。"
                  : "使用 julius/，后接 issue ID 和简短说明。"
              }
              onCommit={(next) => {
                const value = next.trim();
                if (!instructionsMixed && value === settings.branchNameInstructions) return;
                return updateSettings({ branchNameInstructions: value });
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}
