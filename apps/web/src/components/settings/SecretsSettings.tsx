import type { EnvironmentId, SecretProviderConfig, SecretProviderId } from "@t3tools/contracts";
import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import { useState } from "react";

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
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function SecretsSettingsPanel() {
  const { scope, environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected";
  return (
    <SettingsPageContainer>
      {connected &&
      environment.serverConfig !== null &&
      environment.serverConfig.secretProviderSettings !== true ? (
        <SettingsSection {...searchableSetting("secret-providers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            请先更新 {environment.label} 上的 Fleet ADE，才能管理它的凭据提供方。
          </p>
        </SettingsSection>
      ) : connected ? (
        <EnvironmentSecretProviders
          key={environment.environmentId}
          environment={environment}
          projectScoped={scope.kind === "project" || scope.kind === "checkout"}
        />
      ) : (
        <SettingsSection {...searchableSetting("secret-providers")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            连接一个环境，即可管理其提供方变量使用的凭据提供方。
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentSecretProviders({
  environment,
  projectScoped,
}: {
  readonly environment: EnvironmentPresentation;
  readonly projectScoped: boolean;
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
  const readOnly = access.kind !== "editable" || projectScoped;
  const providers = useEnvironmentSettings(environmentId, (settings) => settings.secretProviders);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const entries = Object.entries(providers) as Array<[SecretProviderId, SecretProviderConfig]>;
  return (
    <SettingsSection {...searchableSetting("secret-providers")}>
      {projectScoped ? (
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          这是环境级设置，请先选择一个环境再修改。
        </p>
      ) : null}
      {entries.length === 0 ? (
        <SettingsRow
          title="尚未配置凭据提供方。"
          description="此版本没有可添加的凭据提供方类型。"
        />
      ) : (
        entries.map(([id, config]) => (
          <SettingsRow
            key={id}
            title={<span className="min-w-0 wrap-anywhere">{config.label}</span>}
            description={
              builtInSecretProviderDefinitions.find(config.kind)?.label ??
              `不支持的提供方（${config.kind}）`
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
              移除提供方
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
