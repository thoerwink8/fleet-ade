import type { EnvironmentId, SourceControlProviderAuth } from "@t3tools/contracts";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { groupHostAccounts, nextHostAccountChoices } from "./SourceControlAccountSettings.logic";
import {
  readHostCredentialSettings,
  type SourceControlDefinition,
  type SourceControlHostCredentials,
} from "@t3tools/client-runtime/source-control-clients";
import { redactedPlaceholder } from "./RedactedSensitiveText";

/** Sentinel select value for "follow the CLI's active login"; logins never contain spaces. */
const ACTIVE_ACCOUNT = "active cli account";

function RedactedLogin(props: {
  readonly account: string;
  readonly revealed: boolean;
  readonly label?: string;
}) {
  return props.revealed ? (
    <span className="min-w-0 truncate font-mono text-2xs">{props.account}</span>
  ) : (
    <span className="min-w-0 truncate font-mono text-2xs">
      <span className="select-none blur-xs" aria-hidden>
        {redactedPlaceholder(props.account)}
      </span>
      <span className="sr-only">{props.label ?? "已隐藏的账户"}</span>
    </span>
  );
}

export function SourceControlAccountSettings({
  environmentId,
  definition,
  credentials,
  auth,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition;
  readonly credentials: SourceControlHostCredentials;
  readonly auth: SourceControlProviderAuth;
  readonly onSaved: () => void;
}) {
  const { hosts } = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  );
  const { label } = definition;
  const { cliName } = credentials;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `保存 ${label} 账户设置`,
  });
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const groups = groupHostAccounts(auth.accounts ?? []);

  const save = async (
    host: string,
    change: { readonly enabled?: boolean; readonly account?: string | null },
  ) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          sourceControlHosts: {
            [definition.kind]: { hosts: nextHostAccountChoices(hosts, host, change) },
          },
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") onSaved();
  };

  if (groups.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        请在服务器主机上运行{" "}
        <code className="rounded bg-muted px-1 py-px text-2xs">{credentials.loginCommand}</code>{" "}
        登录，然后重新扫描，即可在这里选择账户。
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          选择每个 {label} 主机使用哪个{" "}
          <code className="rounded bg-muted px-1 py-px text-2xs">{cliName}</code>{" "}
          登录，或关闭某个主机。
        </p>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          onClick={() => setRevealed((current) => !current)}
          aria-label={revealed ? `隐藏 ${label} 账户` : `显示 ${label} 账户`}
          aria-pressed={revealed}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </div>
      {groups.map((group) => {
        const choice = hosts[group.host];
        const enabled = choice?.enabled ?? true;
        const stalePin =
          choice?.account !== undefined && !group.selectable.includes(choice.account);
        const pinned = choice?.account !== undefined && !stalePin ? choice.account : ACTIVE_ACCOUNT;
        return (
          <div key={group.host} className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <span className="text-meta font-medium text-foreground">{group.host}</span>
                {group.selectable.length === 1 && group.selectable[0] !== undefined ? (
                  <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <span>已登录账户</span>
                    <RedactedLogin revealed={revealed} account={group.selectable[0]} />
                  </p>
                ) : null}
              </div>
              <Switch
                checked={enabled}
                disabled={saving}
                aria-label={`在 ${label} 上使用 ${group.host}`}
                onCheckedChange={(checked) => void save(group.host, { enabled: checked })}
              />
            </div>
            {group.selectable.length > 1 ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">账户</span>
                <div className="w-64 max-w-full">
                  <Select
                    value={pinned}
                    disabled={saving || !enabled}
                    onValueChange={(value) => {
                      if (typeof value !== "string") return;
                      void save(group.host, {
                        account: value === ACTIVE_ACCOUNT ? null : value,
                      });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={`${label} 的 ${group.host} 账户`}>
                      <SelectValue>
                        {(value: string) =>
                          value === ACTIVE_ACCOUNT ? (
                            <span className="flex min-w-0 items-center gap-1">
                              活跃 {cliName} 账户
                              {group.activeAccount ? (
                                <>
                                  (
                                  <RedactedLogin
                                    revealed={revealed}
                                    account={group.activeAccount}
                                  />
                                  )
                                </>
                              ) : null}
                            </span>
                          ) : (
                            <RedactedLogin revealed={revealed} account={value} />
                          )
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value={ACTIVE_ACCOUNT}>
                        <span className="flex min-w-0 items-center gap-1">
                          活跃 {cliName} 账户
                          {group.activeAccount ? (
                            <>
                              (<RedactedLogin revealed={revealed} account={group.activeAccount} />)
                            </>
                          ) : null}
                        </span>
                      </SelectItem>
                      {group.selectable.map((account, index) => (
                        <SelectItem key={account} value={account}>
                          <RedactedLogin
                            revealed={revealed}
                            account={account}
                            label={`账户 ${index + 1}`}
                          />
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            ) : null}
            {stalePin ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-warning">
                  所选登录已退出，因此改用当前的 {cliName} 登录。
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void save(group.host, { account: null })}
                >
                  使用当前登录账户
                </Button>
              </div>
            ) : null}
            {group.broken.map((entry) => (
              <p
                key={entry.account}
                className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground/70"
              >
                <RedactedLogin revealed={revealed} account={entry.account} />
                <span>无法使用：{entry.error ?? `${cliName} 报告此登录账户无效。`}</span>
              </p>
            ))}
            {group.environmentVariable ? (
              <p className="text-xs text-warning">
                服务器已设置 {group.environmentVariable}，在取消设置前会覆盖此处选择的账户。
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
