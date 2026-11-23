import { useScopedSettingsWriteAllowed } from "./useScopedSettings";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";
import { type BackgroundActivityProfile } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  backgroundActivityOverrideSettings,
  backgroundActivitySharedPolicySettings,
  durationToSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import { IntervalSecondsField } from "./IntervalSecondsField";
import { PolicyTooltip, SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: "均衡",
  performance: "性能优先",
  "battery-saver": "省电",
};

type BackgroundActivityProfileOption = BackgroundActivityProfile | "advanced";

const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS: Record<BackgroundActivityProfileOption, string> = {
  ...BACKGROUND_ACTIVITY_PROFILE_LABELS,
  advanced: "自定义",
};

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, string> = {
  balanced: "客户端闲置、主机锁定或处于低电量模式时暂停检测。",
  performance: "有订阅此环境的客户端保持连接时，允许相应的后台检测。",
  "battery-saver": "主机或客户端使用电池供电时，也会暂停后台检测。",
};

const ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION = "使用自定义时间间隔。";

const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | "pauseWhenHostLocked"
    | "pauseWhenHostLowPower"
    | "pauseWhenClientLowPower"
    | "pauseWhenOnBattery";
  readonly label: string;
}> = [
  { key: "pauseWhenHostLocked", label: "主机锁定时暂停" },
  { key: "pauseWhenHostLowPower", label: "主机开启低电量模式时暂停" },
  { key: "pauseWhenClientLowPower", label: "客户端开启低电量模式时暂停" },
  { key: "pauseWhenOnBattery", label: "使用电池时暂停" },
];

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeProfile = resolvedBackgroundActivity.profile;
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  );
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  );

  return (
    <Dialog open={open && canWriteSettings} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>后台活动</DialogTitle>
          <DialogDescription>调整共享电源策略和相关后台任务的运行间隔。</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset
            disabled={!canWriteSettings}
            className="min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground"
          >
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-row font-semibold">共享策略</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  控制后台任务达到设定间隔后是否允许运行。
                </p>
              </div>
              <Select
                value={activeProfile}
                onValueChange={(value) => {
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings({
                      backgroundActivity: backgroundActivitySharedPolicySettings(settings, value),
                    });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="共享后台策略">
                  <SelectValue>{BACKGROUND_ACTIVITY_PROFILE_LABELS[activeProfile]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-row font-semibold">
                  {searchableSetting("git-fetch-interval").title}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  在后台刷新远程分支状态。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  label="Git 获取间隔"
                  value={automaticGitFetchIntervalSeconds}
                  min={0}
                  step={5}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { automaticGitFetchInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-row font-semibold">提供方状态检查间隔</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  刷新提供方的可用状态、版本和认证状态。模型目录是否更新取决于“提供方更新检查”设置。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  label="提供方状态检查间隔"
                  value={providerHealthRefreshIntervalSeconds}
                  min={0}
                  step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { providerHealthRefreshInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-row font-semibold">主机电源监测</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  客户端活跃时定期检查主机电源状态。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  label="活跃时主机电源检查间隔"
                  value={hostPowerMonitorActiveIntervalSeconds}
                  min={5}
                  step={5}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { hostPowerMonitorActiveInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-row font-semibold">闲置主机监测</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  没有活跃的前台客户端时，定期检查主机电源状态。
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  label="闲置时主机电源检查间隔"
                  value={hostPowerMonitorIdleIntervalSeconds}
                  min={5}
                  step={30}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { hostPowerMonitorIdleInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">秒</span>
              </div>
            </div>

            <div className="grid gap-0 border-t sm:grid-cols-2">
              {BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:border-r sm:even:border-r-0"
                >
                  <span className="text-sm font-medium">{label}</span>
                  <Switch
                    checked={resolvedBackgroundActivity[key]}
                    onCheckedChange={(checked) =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          {
                            [key]: Boolean(checked),
                          },
                        ),
                      )
                    }
                    aria-label={label}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canWriteSettings}
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            全部重置
          </Button>
          <Button onClick={() => onOpenChange(false)}>完成</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function BackgroundActivitySettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const mixedBackgroundActivity = useScopedSettingsMixed(["backgroundActivity"]);
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? `${ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION} Shared policy: ${
          BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]
        }.`
      : BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile];
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["backgroundActivity"]}
      id={searchableSetting("background-activity").id}
      title={
        <span className="inline-flex items-center gap-1.5">
          {searchableSetting("background-activity").title}
          <PolicyTooltip>
            Git 刷新和提供方状态检测等后台任务达到各自间隔后，是否运行由此共享策略决定。
          </PolicyTooltip>
        </span>
      }
      description={backgroundActivityDescription}
      resetAction={
        canResetBackgroundActivity ? (
          <SettingResetButton
            label="后台活动"
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          />
        ) : null
      }
      control={
        <>
          <Select
            value={mixedBackgroundActivity ? null : backgroundActivityProfileOption}
            onValueChange={(value) => {
              if (value === "advanced") {
                if (isEnvironmentScope) setBackgroundActivityDialogOpen(true);
                return;
              }
              if (value === "balanced" || value === "performance" || value === "battery-saver") {
                updateSettings(backgroundActivityProfileSettings(value));
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="后台活动模式">
              <SelectValue>
                {(value: BackgroundActivityProfileOption | null) =>
                  value === null ? "混合" : BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[value]
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="balanced">
                {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
              </SelectItem>
              <SelectItem hideIndicator value="performance">
                {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
              </SelectItem>
              <SelectItem hideIndicator value="battery-saver">
                {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
              </SelectItem>
              <SelectItem hideIndicator value="advanced" disabled={!isEnvironmentScope}>
                {isEnvironmentScope
                  ? BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced
                  : `${BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced} (one environment)`}
              </SelectItem>
            </SelectPopup>
          </Select>
          {backgroundActivityProfileOption === "advanced" && isEnvironmentScope ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label="配置高级后台活动"
                    onClick={() => setBackgroundActivityDialogOpen(true)}
                  >
                    <SettingsIcon className="size-4" />
                  </Button>
                }
              />
              <TooltipPopup side="top">配置后台活动</TooltipPopup>
            </Tooltip>
          ) : null}
          <BackgroundActivityAdvancedDialog
            open={backgroundActivityDialogOpen && isEnvironmentScope}
            onOpenChange={setBackgroundActivityDialogOpen}
          />
        </>
      }
    />
  );
}
