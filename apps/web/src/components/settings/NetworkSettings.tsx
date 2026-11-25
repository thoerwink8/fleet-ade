import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  DEFAULT_NETWORK_SETTINGS,
  WS_METHODS,
  type AgentNetworkLine,
  type NetworkLine,
  type NetworkSettings,
  type ServerNetworkResult,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { effectiveRouteSentence, proxyUrlError } from "./NetworkSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const inspectNetwork = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "查看网络线路",
  tag: WS_METHODS.serverNetwork,
});

const LINES = {
  auto: "自动",
  direct: "直连",
  custom: "指定地址",
} satisfies Record<NetworkLine, string>;

const AGENT_LINES = {
  follow: "跟随全局",
  direct: "直连",
  custom: "指定地址",
} satisfies Record<AgentNetworkLine, string>;

const AGENTS = [
  ["grok", "Grok"],
  ["codex", "Codex"],
  ["claudeAgent", "Claude"],
  ["antigravity", "Antigravity"],
] as const;

function fullNetwork(network: NetworkSettings | undefined): NetworkSettings {
  return {
    ...DEFAULT_NETWORK_SETTINGS,
    ...network,
    agentOverrides: { ...network?.agentOverrides },
  };
}

export function NetworkSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { target } = useSettingsScope();
  const environmentId = target?.environmentId ?? null;
  const inspect = useAtomCommand(inspectNetwork, { reportFailure: false });
  const network = fullNetwork(settings.network);
  const networkKey = JSON.stringify(network);
  const [route, setRoute] = useState<ServerNetworkResult | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const seenLine = useRef(networkKey);

  const save = (next: NetworkSettings) => updateSettings({ network: next });

  const loadRoute = useEffectEvent(
    (id: NonNullable<typeof environmentId>, isStale: () => boolean) => {
      void inspect({ environmentId: id, input: { probe: false } }).then((result) => {
        if (isStale()) return;
        if (result._tag === "Success") {
          setRoute(result.value);
          setRouteError(null);
          return;
        }
        setRouteError("读不到当前线路");
      });
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the server's effective proxy, which is not in the settings document
  useEffect(() => {
    if (environmentId === null) return;
    const savedLine = networkKey;
    seenLine.current = savedLine;
    let cancelled = false;
    loadRoute(environmentId, () => cancelled || seenLine.current !== savedLine);
    return () => {
      cancelled = true;
    };
  }, [environmentId, networkKey]);

  const runProbe = () => {
    if (environmentId === null || probing) return;
    setProbing(true);
    void inspect({ environmentId, input: { probe: true } }).then((result) => {
      setProbing(false);
      if (result._tag === "Success") {
        setRoute(result.value);
        setRouteError(null);
        return;
      }
      setRouteError("检测没有完成");
    });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("network")}>
        <SettingsRow
          serverScoped
          settingKeys={["network"]}
          title="线路"
          description="Fleet ADE 自己的出站请求，以及它新拉起的智能体，都走这条线路。新开的会话马上生效。已经开着的会话要新开一个才换线路。"
          control={
            <Select
              value={network.line}
              onValueChange={(value) => {
                if (value === "auto" || value === "direct" || value === "custom") {
                  save({ ...network, line: value });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="线路">
                <SelectValue>
                  {(value: NetworkLine | null) => (value ? LINES[value] : "自动")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                <NetworkLineItems />
              </SelectPopup>
            </Select>
          }
        />
        {network.line === "custom" ? (
          <SettingsRow
            serverScoped
            settingKeys={["network"]}
            title="代理地址"
            description="写成 http://主机:端口。"
            control={
              <div className="w-full min-w-0">
                <DraftInput
                  size="sm"
                  aria-label="代理地址"
                  value={network.proxyUrl}
                  placeholder="http://127.0.0.1:7890"
                  onCommit={(next) => {
                    const reason = proxyUrlError(next);
                    if (reason) return reason;
                    return save({ ...network, proxyUrl: next.trim() });
                  }}
                />
              </div>
            }
          />
        ) : null}
        <SettingsRow
          serverScoped
          settingKeys={["network"]}
          title="不走代理的地址"
          description="逗号分隔。本机地址始终不走代理。"
          control={
            <div className="w-full min-w-0">
              <DraftInput
                size="sm"
                aria-label="不走代理的地址"
                value={network.noProxy}
                placeholder="example.com"
                onCommit={(next) => save({ ...network, noProxy: next })}
              />
            </div>
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["network"]}
          title="当前生效"
          description={route ? effectiveRouteSentence(route) : (routeError ?? "正在读取")}
          control={
            <Button
              size="sm"
              variant="secondary"
              disabled={probing || environmentId === null}
              onClick={runProbe}
            >
              {probing ? "检测中" : "检测"}
            </Button>
          }
        />
        {route && route.probes.length > 0 ? (
          <div className="min-w-0 space-y-1 px-3 pb-3 text-xs break-words text-muted-foreground sm:px-4">
            {route.probes.map((probe) => (
              <p key={`${probe.name}:${probe.url}`}>
                {probe.name}：{probe.detail}
                {probe.elapsedMs > 0 ? ` · ${probe.elapsedMs} 毫秒` : ""}
              </p>
            ))}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="证书">
        <SettingsRow
          serverScoped
          settingKeys={["network"]}
          title="额外信任的根证书"
          description="公司中间人代理的根证书路径。证书不受信任时填这里。留空就只用系统已经信任的证书。这不是某个智能体自带的证书。"
          control={
            <div className="w-full min-w-0">
              <DraftInput
                size="sm"
                aria-label="额外信任的根证书"
                value={network.extraCaCertPath}
                placeholder="D:\certs\corp-root.pem"
                onCommit={(next) => save({ ...network, extraCaCertPath: next })}
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="按智能体">
        {AGENTS.map(([driver, label]) => {
          const override = network.agentOverrides[driver] ?? {
            line: "follow" as const,
            proxyUrl: "",
            noProxy: "",
          };
          return (
            <SettingsRow
              key={driver}
              serverScoped
              settingKeys={["network"]}
              title={label}
              description={
                driver === "claudeAgent"
                  ? "二进制路径指向 reclaude 时，这一行不起作用，不会注入代理，也不会注入上面的根证书。"
                  : undefined
              }
              control={
                <div className="flex w-full min-w-0 flex-col gap-2">
                  <Select
                    value={override.line}
                    onValueChange={(value) => {
                      if (value !== "follow" && value !== "direct" && value !== "custom") return;
                      const agentOverrides = { ...network.agentOverrides };
                      if (value === "follow") delete agentOverrides[driver];
                      else agentOverrides[driver] = { ...override, line: value };
                      save({ ...network, agentOverrides });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={`${label}的线路`}>
                      <SelectValue>
                        {(value: AgentNetworkLine | null) =>
                          value ? AGENT_LINES[value] : "跟随全局"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end">
                      {(Object.keys(AGENT_LINES) as AgentNetworkLine[]).map((line) => (
                        <SelectItem key={line} value={line}>
                          {AGENT_LINES[line]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  {override.line === "custom" ? (
                    <DraftInput
                      size="sm"
                      aria-label={`${label}的代理地址`}
                      value={override.proxyUrl}
                      placeholder="http://127.0.0.1:7890"
                      onCommit={(next) => {
                        const reason = proxyUrlError(next);
                        if (reason) return reason;
                        return save({
                          ...network,
                          agentOverrides: {
                            ...network.agentOverrides,
                            [driver]: { ...override, line: "custom", proxyUrl: next.trim() },
                          },
                        });
                      }}
                    />
                  ) : null}
                </div>
              }
            />
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function NetworkLineItems() {
  return (Object.keys(LINES) as NetworkLine[]).map((line) => (
    <SelectItem key={line} value={line}>
      {LINES[line]}
    </SelectItem>
  ));
}
