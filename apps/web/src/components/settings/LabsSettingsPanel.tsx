import { Link } from "@tanstack/react-router";

import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";

/** Features still settling in. */
export function LabsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title="测试版">
        <BoringSidebarRow />
        <LinkedEnvironmentsRow />
        <PromptSuggestionsRow />
        <SimlockHostsRow />
        <FastWorktreeCheckoutRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function BoringSidebarRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar")}
      description="将侧边栏会话按项目文件夹分组。置顶会话保留在顶部，已暂缓和已收尾会话显示在文件夹下方。"
      control={
        <Switch
          checked={settings.boringSidebarEnabled}
          onCheckedChange={(checked) => updateSettings({ boringSidebarEnabled: Boolean(checked) })}
          aria-label="简洁侧边栏（按项目分组）"
        />
      }
    >
      {settings.boringSidebarEnabled ? (
        <div className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
          <BoringSidebarMultilineRow />
        </div>
      ) : null}
    </SettingsRow>
  );
}

function BoringSidebarMultilineRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar-multiline")}
      className="px-0 py-2 sm:px-0"
      description="分两行显示文件夹内的会话：第一行显示标题，第二行显示分支、pull request 和智能体。"
      control={
        <Switch
          checked={settings.boringSidebarMultilineRows}
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarMultilineRows: Boolean(checked) })
          }
          aria-label="双行文件夹列表"
        />
      }
    />
  );
}

function LinkedEnvironmentsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linked-environments-beta")}
      settingKeys={["linkedEnvironmentsEnabled"]}
      description={
        <>
          让这里的智能体在你的其他机器上工作，也让那边的智能体在这里工作。请在每台机器上打开，然后在{" "}
          <Link to="/settings/connections" className="underline underline-offset-2">
            连接
          </Link>
          。关闭后，不会通过关联启动新任务；正在运行的任务会继续完成。
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["linkedEnvironmentsEnabled"]}
          checked={settings.linkedEnvironmentsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ linkedEnvironmentsEnabled: Boolean(checked) })
          }
          aria-label="关联环境"
        />
      }
    />
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

function SimlockHostsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("simlock-hosts")}
      settingKeys={["simlockDeviceHostsEnabled"]}
      description={
        <>
          让设备面板从你自己的{" "}
          <a
            href="https://incubator.callstack.com/simlock/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Simlock
          </a>{" "}
          池租用模拟器和仿真器，在{" "}
          <Link to="/settings/devices" className="underline underline-offset-2">
            设备
          </Link>
          。此功能处于早期测试阶段，可能变更或失效。T3 Code 不会安装它。
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["simlockDeviceHostsEnabled"]}
          checked={settings.simlockDeviceHostsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ simlockDeviceHostsEnabled: Boolean(checked) })
          }
          aria-label="Simlock 设备主机"
        />
      }
    />
  );
}

/** Shows only when every machine in scope is a Mac, since only macOS servers honor it. */
function FastWorktreeCheckoutRow() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.fastWorktreeCheckout !== true,
    )
  )
    return null;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("worktree-fast-checkout")}
      settingKeys={["fastWorktreeCheckout"]}
      description="在 Mac 上，从缓存在 T3 主目录中的工作副本克隆新的工作树，无需逐个写入每个文件。无法使用时改为 Git 的常规检出。关闭后会删除缓存。"
      control={
        <ScopedSwitch
          settingKeys={["fastWorktreeCheckout"]}
          checked={settings.fastWorktreeCheckout}
          onCheckedChange={(checked) => updateSettings({ fastWorktreeCheckout: Boolean(checked) })}
          aria-label="快速创建工作树"
        />
      }
    />
  );
}
