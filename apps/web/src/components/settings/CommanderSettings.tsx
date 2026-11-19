import { type DispatchRole, type ModelSelection, type ServerSettings } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { DraftInput } from "../ui/draft-input";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";

const ROLE_SETTING_KEYS = {
  code: "dispatchCodeModelSelection",
  review: "dispatchReviewModelSelection",
  readonly: "dispatchReadonlyModelSelection",
  plan: "dispatchPlanModelSelection",
} as const satisfies Record<DispatchRole, keyof ServerSettings>;

type RoleSettingKey = (typeof ROLE_SETTING_KEYS)[DispatchRole];

const ROLE_LABELS: Record<DispatchRole, { readonly title: string; readonly description: string }> =
  {
    code: { title: "写码", description: "实现任务和修改代码。" },
    review: { title: "复查", description: "检查改动并指出问题。" },
    readonly: {
      title: "只读查看",
      description: "查看代码和资料；这里只决定模型，不限制工具权限。",
    },
    plan: { title: "出方案", description: "分析需求并给出实施方案。" },
  };

const ROLE_ORDER: ReadonlyArray<DispatchRole> = ["code", "review", "readonly", "plan"];

export function CommanderSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, target } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const environmentId = environment?.environmentId ?? null;
  const providers =
    environment?.serverConfig === undefined
      ? EMPTY_SERVER_PROVIDERS
      : (providersByEnvironment.get(environment.environmentId) ?? EMPTY_SERVER_PROVIDERS);
  const entries = providerInstanceEntriesFor(providers, settings, target?.projectId ?? null);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(settings, providers);
  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const mixedConcurrency = useScopedSettingsMixed(["dispatchConcurrencyLimit"]);
  const mixedRoleSettings = {
    code: useScopedSettingsMixed([ROLE_SETTING_KEYS.code]),
    review: useScopedSettingsMixed([ROLE_SETTING_KEYS.review]),
    readonly: useScopedSettingsMixed([ROLE_SETTING_KEYS.readonly]),
    plan: useScopedSettingsMixed([ROLE_SETTING_KEYS.plan]),
  } satisfies Record<DispatchRole, boolean>;

  return (
    <SettingsSection id="commander" title="指挥">
      {ROLE_ORDER.map((role) => (
        <CommanderRoleRow
          key={role}
          role={role}
          settingKey={ROLE_SETTING_KEYS[role]}
          selection={settings[ROLE_SETTING_KEYS[role]]}
          defaultSelection={settings.defaultModelSelection}
          mixed={mixedRoleSettings[role]}
          environmentId={environmentId}
          entries={entries}
          modelOptionsByInstance={modelOptionsByInstance}
          modelDisabledReason={modelDisabledReason}
          onChange={(selection) => updateSettings({ [ROLE_SETTING_KEYS[role]]: selection })}
          onReset={() => updateSettings({ [ROLE_SETTING_KEYS[role]]: null })}
        />
      ))}
      <SettingsRow
        serverScoped
        settingKeys={["dispatchConcurrencyLimit"]}
        mixed={mixedConcurrency}
        title="同时派出上限"
        description="按每条指挥会话分别计数；正在运行和排队的委派都算在内。留空表示不限制。"
        resetAction={
          mixedConcurrency || settings.dispatchConcurrencyLimit !== null ? (
            <SettingResetButton
              label="同时派出上限"
              onClick={() => updateSettings({ dispatchConcurrencyLimit: null })}
            />
          ) : null
        }
        control={
          <DraftInput
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            className="w-full sm:w-32"
            value={mixedConcurrency ? "" : (settings.dispatchConcurrencyLimit?.toString() ?? "")}
            placeholder={mixedConcurrency ? "各不相同" : "不限制"}
            aria-label="同时派出上限"
            onCommit={(next) => {
              const value = next.trim();
              if (value === "") {
                updateSettings({ dispatchConcurrencyLimit: null });
                return;
              }
              const limit = Number(value);
              if (Number.isSafeInteger(limit) && limit > 0) {
                updateSettings({ dispatchConcurrencyLimit: limit });
              }
            }}
          />
        }
      />
    </SettingsSection>
  );
}

function CommanderRoleRow({
  role,
  settingKey,
  selection,
  defaultSelection,
  mixed,
  environmentId,
  entries,
  modelOptionsByInstance,
  modelDisabledReason,
  onChange,
  onReset,
}: {
  readonly role: DispatchRole;
  readonly settingKey: RoleSettingKey;
  readonly selection: ModelSelection | null;
  readonly defaultSelection: ModelSelection | null;
  readonly mixed: boolean;
  readonly environmentId: Parameters<typeof ProviderModelPicker>[0]["environmentId"];
  readonly entries: Parameters<typeof ProviderModelPicker>[0]["instanceEntries"];
  readonly modelOptionsByInstance: Parameters<
    typeof ProviderModelPicker
  >[0]["modelOptionsByInstance"];
  readonly modelDisabledReason: (
    instanceId: Parameters<typeof ProviderModelPicker>[0]["activeInstanceId"],
    model: string,
  ) => string | null;
  readonly onChange: (selection: ModelSelection) => void;
  readonly onReset: () => void;
}) {
  const labels = ROLE_LABELS[role];
  const effective = selection ?? defaultSelection;
  const pickerEntry =
    (effective !== null
      ? entries.find((candidate) => candidate.instanceId === effective.instanceId)
      : undefined) ??
    entries.find((candidate) => candidate.enabled && candidate.isAvailable) ??
    entries[0];
  const usesDedicatedModel = selection !== null;
  const pickerInstanceId = effective?.instanceId ?? pickerEntry?.instanceId ?? null;
  const pickerModel = effective?.model ?? pickerEntry?.models[0]?.slug ?? null;

  return (
    <SettingsRow
      serverScoped
      settingKeys={[settingKey]}
      mixed={mixed}
      title={labels.title}
      description={labels.description}
      resetAction={
        usesDedicatedModel || mixed ? (
          <SettingResetButton label={labels.title} onClick={onReset} />
        ) : null
      }
      control={
        pickerInstanceId !== null && pickerModel !== null ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={pickerInstanceId}
              model={pickerModel}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel={`${labels.title}模型`}
              {...(mixed
                ? { triggerLabel: "各不相同" as const }
                : !usesDedicatedModel
                  ? { triggerLabel: defaultSelection !== null ? "跟随默认" : "未设置" }
                  : {})}
              getModelDisabledReason={modelDisabledReason}
              onInstanceModelChange={(instanceId, model) => {
                const reason = modelDisabledReason(instanceId, model);
                if (reason) {
                  toastManager.add({
                    type: "error",
                    title: `未保存${labels.title}模型`,
                    description: reason,
                  });
                  return;
                }
                onChange(createModelSelection(instanceId, model));
              }}
            />
            {usesDedicatedModel && !mixed && pickerEntry && effective !== null ? (
              <TraitsPicker
                provider={pickerEntry.driverKind}
                models={pickerEntry.models}
                model={effective.model}
                modelOptions={effective.options ?? []}
                allowPromptInjectedEffort={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  onChange(createModelSelection(effective.instanceId, effective.model, options))
                }
              />
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">无可选模型</span>
        )
      }
    />
  );
}
