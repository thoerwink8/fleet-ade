import type { ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { toastManager } from "../ui/toast";
import {
  canResetCommanderSettingRow,
  COMMANDER_DISPATCH_ROLES,
  COMMANDER_DISPATCH_SETTING_KEYS,
  COMMANDER_RESET_ALL_PATCH,
  commanderResetRowPatch,
  hasAnyCommanderSettingToReset,
  parseDispatchConcurrencyLimitDraft,
  readCommanderDispatchSettings,
  resolveCommanderRoleModelPresentation,
  type CommanderDispatchRoleKey,
} from "./CommanderSettings.logic";
import { resolveDefaultModelSettingsPresentation } from "./ProjectDefaultsSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function CommanderSettingsSection() {
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const clearOverrides = useClearScopedSettings();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers =
    (representative?.serverConfig
      ? providersByEnvironment.get(representative.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, target?.projectId ?? null);
  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  const dispatchSettings = readCommanderDispatchSettings(settings);
  const fallbackSelection = resolveDefaultModelSettingsPresentation({
    entries,
    providers,
    settings,
    projectId: target?.projectId ?? null,
  }).selection;

  const mixedCode = useScopedSettingsMixed(["dispatchCodeModelSelection"]);
  const mixedReview = useScopedSettingsMixed(["dispatchReviewModelSelection"]);
  const mixedReadonly = useScopedSettingsMixed(["dispatchReadonlyModelSelection"]);
  const mixedPlan = useScopedSettingsMixed(["dispatchPlanModelSelection"]);
  const mixedLimit = useScopedSettingsMixed(["dispatchConcurrencyLimit"]);

  const mixedByRoleKey: Readonly<Record<CommanderDispatchRoleKey, boolean>> = {
    dispatchCodeModelSelection: mixedCode,
    dispatchReviewModelSelection: mixedReview,
    dispatchReadonlyModelSelection: mixedReadonly,
    dispatchPlanModelSelection: mixedPlan,
  };

  const setRoleModel = (
    key: CommanderDispatchRoleKey,
    roleTitle: string,
    value: ModelSelection | null,
  ) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({
        type: "error",
        title: `未保存${roleTitle}模型`,
        description: reason,
      });
      return;
    }
    updateSettings({ [key]: value });
  };

  const canResetLimit = canResetCommanderSettingRow({
    key: "dispatchConcurrencyLimit",
    isProjectScope,
    targets,
    mixed: mixedLimit,
  });
  const hasResettable = hasAnyCommanderSettingToReset({ isProjectScope, targets });

  const handleResetAll = () => {
    if (isProjectScope) {
      clearOverrides(COMMANDER_DISPATCH_SETTING_KEYS);
      return;
    }
    updateSettings(COMMANDER_RESET_ALL_PATCH);
  };

  return (
    <SettingsSection id="commander" title="指挥">
      {COMMANDER_DISPATCH_ROLES.map((role) => {
        const mixed = mixedByRoleKey[role.key];
        const saved = dispatchSettings[role.key];
        const presentation = resolveCommanderRoleModelPresentation({
          saved,
          fallbackSelection,
          entries,
          providers,
          settings,
        });
        const selection = presentation.selection;
        const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
        const modelOptions = getCustomModelOptionsByInstance(
          settings,
          providers,
          selection?.instanceId,
          selection?.model,
        );
        const effortDisabledReason =
          selection && !presentation.usesDefault
            ? modelDisabledReason(selection.instanceId, selection.model)
            : null;
        const canResetRow = canResetCommanderSettingRow({
          key: role.key,
          isProjectScope,
          targets,
          mixed,
        });

        return (
          <SettingsRow
            key={role.key}
            serverScoped
            settingKeys={[role.key]}
            mixed={mixed}
            id={role.id}
            title={role.title}
            description={role.description}
            status={
              mixed
                ? "各电脑的配置不一样。请选择一台电脑，或改成各电脑共用的模型。"
                : (presentation.providerNote ?? effortDisabledReason)
            }
            resetAction={
              !isProjectScope && canResetRow ? (
                <SettingResetButton
                  label={role.title}
                  tooltip="恢复默认"
                  onClick={() => updateSettings(commanderResetRowPatch(role.key))}
                />
              ) : null
            }
            control={
              selection ? (
                <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
                  <ProviderModelPicker
                    environmentId={representative?.environmentId ?? null}
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptions}
                    triggerClassName={cn(SETTINGS_PICKER_TRIGGER_CLASSNAME, "max-w-full shrink")}
                    triggerAriaLabel={`${role.title}模型`}
                    {...(mixed
                      ? { triggerLabel: "多项不同" }
                      : presentation.usesDefault
                        ? { triggerLabel: "跟随默认模型" }
                        : {})}
                    getModelDisabledReason={modelDisabledReason}
                    onOpenProviderSetup={(instanceId) => {
                      if (representative) {
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId: representative.environmentId, instanceId },
                        });
                      }
                    }}
                    onInstanceModelChange={(instanceId, model) =>
                      setRoleModel(role.key, role.title, createModelSelection(instanceId, model))
                    }
                  />
                  {!mixed &&
                  !presentation.usesDefault &&
                  !presentation.providerNote &&
                  !effortDisabledReason &&
                  activeEntry ? (
                    <TraitsPicker
                      provider={activeEntry.driverKind}
                      models={activeEntry.models}
                      model={selection.model}
                      modelOptions={selection.options ?? []}
                      allowPromptInjectedEffort={false}
                      triggerClassName={cn(SETTINGS_PICKER_TRIGGER_CLASSNAME, "max-w-full shrink")}
                      onModelOptionsChange={(options) =>
                        setRoleModel(
                          role.key,
                          role.title,
                          createModelSelection(selection.instanceId, selection.model, options),
                        )
                      }
                    />
                  ) : null}
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {mixed ? "多项不同" : "没有可用的智能体"}
                </span>
              )
            }
          />
        );
      })}

      <SettingsRow
        serverScoped
        settingKeys={["dispatchConcurrencyLimit"]}
        mixed={mixedLimit}
        id="commander-dispatch-concurrency-limit"
        title="同时派出上限"
        description="同一指挥会话最多同时运行或排队的子会话数；留空表示不限制。"
        resetAction={
          !isProjectScope && canResetLimit ? (
            <SettingResetButton
              label="同时派出上限"
              tooltip="恢复默认"
              onClick={() => updateSettings(commanderResetRowPatch("dispatchConcurrencyLimit"))}
            />
          ) : null
        }
        control={
          <div className="w-full sm:w-28">
            <DraftInput
              size="sm"
              type="text"
              inputMode="numeric"
              value={mixedLimit ? "" : String(dispatchSettings.dispatchConcurrencyLimit ?? "")}
              placeholder={mixedLimit ? "多项不同" : "不限制"}
              aria-label="同时派出上限"
              onCommit={(value) => {
                const parsed = parseDispatchConcurrencyLimitDraft(value);
                if (parsed === undefined) return "无效的上限，请输入正整数或留空";
                return updateSettings({ dispatchConcurrencyLimit: parsed });
              }}
            />
          </div>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
        <p className="min-w-0 text-ui text-muted-foreground">
          {isProjectScope
            ? "将此项目的指挥设置恢复为电脑默认。"
            : "将以上全部指挥设置恢复为内置默认。"}
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!hasResettable || !canWriteSettings || unavailable}
          onClick={handleResetAll}
        >
          全部恢复
        </Button>
      </div>
    </SettingsSection>
  );
}
