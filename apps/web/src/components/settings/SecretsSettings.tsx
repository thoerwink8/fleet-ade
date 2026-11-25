import {
  EnvironmentId,
  resolveEnvironmentMachineKind,
  type SecretProviderConfig,
  type SecretProviderId,
} from "@t3tools/contracts";
import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import { useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { secretProviderUses } from "./SecretsSettings.logic";
import {
  classifyProviderEnvironmentAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { useAccessEnvironment } from "./useAccessEnvironment";
import { searchableSetting } from "./settingsSearch";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function SecretsSettingsPanel() {
  // Like AccessSettings: this device page hides the scope sentence, so the
  // single-environment picker lives here and only reads the `machine` search param.
  const linkedEnvironmentId = useSearch({
    strict: false,
    select: (search) =>
      typeof search.machine === "string" ? EnvironmentId.make(search.machine) : null,
  });
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(linkedEnvironmentId);
  const { candidates, environment } = useAccessEnvironment(selectedEnvironmentId);
  const connected = environment?.connection.phase === "connected";
  return (
    <>
      {candidates.length > 1 && environment !== null ? (
        <div className="flex min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
          <span className="shrink-0">密钥来源所属电脑</span>
          <Select
            value={environment.environmentId}
            onValueChange={(next) => {
              if (next !== null) setSelectedEnvironmentId(next);
            }}
          >
            <SelectTrigger size="sm" className="w-auto max-w-72" aria-label="电脑">
              <SelectValue>
                {(value: EnvironmentId) => {
                  const selected = candidates.find(
                    (candidate) => candidate.environmentId === value,
                  );
                  return selected ? settingsScopeEnvironmentLabel(selected, candidates) : null;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {candidates.map((candidate) => (
                <SelectItem
                  hideIndicator
                  key={candidate.environmentId}
                  value={candidate.environmentId}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={resolveEnvironmentMachineKind(candidate.serverConfig)}
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 truncate">
                      {settingsScopeEnvironmentLabel(candidate, candidates)}
                    </span>
                    {candidate.connection.phase !== "connected" ? (
                      <span className="shrink-0 text-xs text-muted-foreground">离线</span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      {connected &&
      environment.serverConfig !== null &&
      environment.serverConfig.secretProviderSettings !== true ? (
        <SettingsSection {...searchableSetting("secret-providers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            请先更新 {environment.label} 上的 Fleet ADE，才能管理它的密钥来源。
          </p>
        </SettingsSection>
      ) : connected && environment !== null ? (
        <EnvironmentSecretProviders key={environment.environmentId} environment={environment} />
      ) : (
        <SettingsSection {...searchableSetting("secret-providers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            连接一台电脑，即可管理其智能体变量使用的密钥来源。
          </p>
        </SettingsSection>
      )}
    </>
  );
}

function EnvironmentSecretProviders({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const environmentId = environment.environmentId;
  const sessionState = useEnvironmentSessionState(environmentId);
  // The server requires the same grant for secret providers as for provider settings.
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess: resolveRemoteOperateAccess({
      session: sessionState.data,
      isPending: sessionState.isPending,
      hasError: sessionState.hasError,
    }),
  });
  const readOnly = access.kind !== "editable";
  const providers = useEnvironmentSettings(environmentId, (settings) => settings.secretProviders);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const entries = Object.entries(providers) as Array<[SecretProviderId, SecretProviderConfig]>;
  return (
    <SettingsSection {...searchableSetting("secret-providers")}>
      {entries.length === 0 ? (
        <SettingsRow title="尚未配置密钥来源。" description="此版本没有可添加的密钥来源类型。" />
      ) : (
        entries.map(([id, config]) => (
          <SettingsRow
            key={id}
            title={<span className="min-w-0 wrap-anywhere">{config.label}</span>}
            description={
              builtInSecretProviderDefinitions.find(config.kind)?.label ??
              `不支持的密钥来源（${config.kind}）`
            }
            control={
              !readOnly ? (
                <RemoveSecretProviderButton
                  environmentId={environmentId}
                  id={id}
                  label={config.label}
                  onConfirm={() => updateSettings({ secretProviders: { [id]: null } })}
                />
              ) : null
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

function RemoveSecretProviderButton({
  environmentId,
  id,
  label,
  onConfirm,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: SecretProviderId;
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        移除
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>移除 {label}?</AlertDialogTitle>
            <SecretProviderUses environmentId={environmentId} id={id} label={label} />
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>取消</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              移除密钥来源
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function SecretProviderUses({
  environmentId,
  id,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: SecretProviderId;
  readonly label: string;
}) {
  const uses = secretProviderUses(useEnvironmentSettings(environmentId), id);
  if (uses.length === 0) {
    return (
      <AlertDialogDescription>没有内容从 {label} 读取。凭据本身不会改动。</AlertDialogDescription>
    );
  }
  return (
    <>
      <AlertDialogDescription>
        这些内容从 {label} 读取，引用会被清掉。凭据本身不会改动。
      </AlertDialogDescription>
      <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto ps-5 text-sm wrap-anywhere">
        {uses.map((use) => (
          <li key={use.id}>{use.label}</li>
        ))}
      </ul>
    </>
  );
}
