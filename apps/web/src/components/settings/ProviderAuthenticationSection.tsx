import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAuthRespondInput,
  ProviderAuthResponse,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { lazy, Suspense, useRef, useState } from "react";
import { CopyIcon } from "lucide-react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { ErrorDetailsDisclosure } from "../chat/ErrorDetailsDisclosure";
import { providerSetupGuidance } from "./providerSetupGuidance.logic";

const ProviderAuthTerminal = lazy(() => import("./ProviderAuthTerminal"));

export function ProviderAuthenticationSection({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
}) {
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const commands = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commands);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, commands);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, commands);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commands);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, commands);
  const [methodId, setMethodId] = useState("");
  const [draft, setDraft] = useState({ id: "", values: {} as Record<string, string> });
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const terminalQueue = useRef<ProviderAuthRespondInput[]>([]);
  const terminalSending = useRef(false);
  const auth = query.data;
  const guidance = providerSetupGuidance({ provider, environmentLabel });
  const interaction = auth?.interaction;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const signedIn =
    provider.auth.status === "authenticated" ||
    (provider.auth.status === "unknown" && auth?.phase === "succeeded");
  const isDiscovering =
    provider.driver === "acpRegistry" &&
    !active &&
    !signedIn &&
    !query.error &&
    auth?.methods === undefined;
  const needsExternalSetup =
    !active &&
    !signedIn &&
    (provider.setup?.canAuthenticate === false ||
      (provider.driver === "acpRegistry" && auth?.methods?.length === 0));
  const usesCredentials =
    provider.driver === "antigravity" &&
    (provider.auth.type === "gemini-api-key" || provider.auth.type === "agent-platform");
  const accountDescription = active
    ? auth?.phase === "starting"
      ? (auth.message ?? (usesCredentials ? "正在连接…" : "正在启动登录…"))
      : auth?.phase === "verifying"
        ? usesCredentials
          ? "正在检查凭据并加载模型…"
          : "正在检查你的账户…"
        : interaction?.type === "terminal"
          ? "在下方终端中完成登录。"
          : interaction?.type === "credentials"
            ? "在下方输入凭据。"
            : "在浏览器中完成登录。"
    : signedIn
      ? "已登录"
      : isDiscovering
        ? "正在查找登录方式…"
        : guidance.action
          ? guidance.message
          : needsExternalSetup
            ? "智能体未提供应用内登录。请按智能体文档完成设置。"
            : usesCredentials
              ? `在 ${environmentLabel} 上连接以加载模型。`
              : `在 ${environmentLabel} 上登录。`;
  const rawStatusMessage = auth?.phase === "failed" ? auth.message : null;
  const statusMessage =
    rawStatusMessage && !/\p{Script=Han}/u.test(rawStatusMessage)
      ? "无法完成智能体登录，请重试。"
      : rawStatusMessage;
  const statusDetail =
    rawStatusMessage && !/\p{Script=Han}/u.test(rawStatusMessage) ? rawStatusMessage : null;
  const disabled = readOnly || pending || query.error !== null || isDiscovering;
  const draftId = `${auth?.flowId ?? ""}:${interaction?.id ?? ""}`;
  const values = draft.id === draftId ? draft.values : {};
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : auth?.authorizationUrl;

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setErrorDetail(null);
    let succeeded = false;
    try {
      const result = await command();
      if (result._tag === "Success") succeeded = true;
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        const raw = failure instanceof Error ? failure.message.trim() : "";
        if (raw && /\p{Script=Han}/u.test(raw)) {
          setError(raw);
        } else {
          setError("无法完成智能体登录，请重试。");
          if (raw) setErrorDetail(raw);
        }
      }
    } catch {
      setError("无法完成智能体登录，请重试。");
    }
    pendingRef.current = false;
    setPending(false);
    return succeeded;
  }

  async function send(response: ProviderAuthResponse) {
    if (!auth?.flowId || !interaction) return false;
    return run(() =>
      respond({
        environmentId,
        input: { instanceId, flowId: auth.flowId!, interactionId: interaction.id, response },
      }),
    );
  }

  async function openBrowser() {
    if (!url || readOnly) return;
    const requiresConsent = interaction?.type === "browser" && interaction.requiresConsent;
    // Reserve tabs before awaiting consent; browsers block later opens.
    const pending = requiresConsent && !window.desktopBridge ? window.open("", "_blank") : null;
    if (pending) pending.opener = null;
    try {
      if (requiresConsent && !(await send({ type: "browser", action: "accept" }))) {
        pending?.close();
        return;
      }
      if (pending) pending.location.href = url;
      else await ensureLocalApi().shell.openExternal(url);
      setError(null);
    } catch {
      pending?.close();
      setError("无法打开登录页面。请复制链接并在浏览器中打开。");
    }
  }

  function updateDraft(name: string, value: string) {
    setDraft({ id: draftId, values: { ...values, [name]: value } });
  }

  return (
    <SettingsRow
      title="账户"
      description={
        signedIn && !active && provider.auth.email?.trim() ? (
          <span>
            已登录账户{" "}
            <RedactedSensitiveText
              key={provider.auth.email}
              value={provider.auth.email}
              ariaLabel="显示或隐藏账户邮箱"
              revealTooltip="点击显示邮箱"
              hideTooltip="点击隐藏邮箱"
              className="max-w-full truncate"
            />
          </span>
        ) : (
          <span role="status">{accountDescription}</span>
        )
      }
      status={
        statusMessage ? (
          <div className="grid gap-1">
            <p role="status" className="[overflow-wrap:anywhere]">
              {statusMessage}
            </p>
            <ErrorDetailsDisclosure detail={statusDetail} />
          </div>
        ) : undefined
      }
      control={
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {!active && (auth?.methods?.length ?? 0) > 1 ? (
            <Select
              value={auth?.methods?.some((method) => method.id === methodId) ? methodId : ""}
              disabled={disabled}
              onValueChange={(value) => setMethodId(value ?? "")}
            >
              <SelectTrigger size="sm" aria-label="登录方式" className="w-44">
                <SelectValue>
                  {auth?.methods?.find((method) => method.id === methodId)?.name ?? "智能体默认"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">智能体默认</SelectItem>
                {auth?.methods?.map((method) => (
                  <SelectItem key={method.id} value={method.id}>
                    {method.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          {url ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => void openBrowser()}
              >
                打开浏览器
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="复制登录链接"
                      size="sm"
                      icon
                      variant="muted"
                      disabled={disabled}
                      onClick={() => {
                        // Copy during the click to retain clipboard activation; consent must still be
                        // recorded before use.
                        const copied = writeTextToClipboard(url, "智能体登录链接");
                        void (async () => {
                          await copied;
                          if (interaction?.type === "browser" && interaction.requiresConsent)
                            await send({ type: "browser", action: "accept" });
                        })().catch(() => setError("无法复制登录链接。"));
                      }}
                    >
                      <CopyIcon />
                    </Button>
                  }
                />
                <TooltipPopup>复制登录链接</TooltipPopup>
              </Tooltip>
            </>
          ) : null}
          <>
            {needsExternalSetup && guidance.action?.kind === "documentation" ? (
              <Button
                size="sm"
                variant="secondary"
                render={<a href={guidance.action.url} target="_blank" rel="noreferrer" />}
              >
                {guidance.action.label}
              </Button>
            ) : needsExternalSetup && provider.setup?.documentationUrl ? (
              <Button
                size="sm"
                variant="secondary"
                render={
                  <a href={provider.setup.documentationUrl} target="_blank" rel="noreferrer" />
                }
              >
                打开文档
              </Button>
            ) : active && auth?.flowId ? (
              <Button
                size="sm"
                variant="muted"
                aria-label="取消登录"
                disabled={disabled}
                onClick={() =>
                  void run(() =>
                    cancel({ environmentId, input: { instanceId, flowId: auth.flowId! } }),
                  )
                }
              >
                取消
              </Button>
            ) : !active && !needsExternalSetup && provider.setup?.canAuthenticate !== false ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || !provider.enabled || !provider.installed || !auth}
                onClick={() =>
                  void run(() =>
                    start({
                      environmentId,
                      input: {
                        instanceId,
                        ...(methodId && auth?.methods?.some((method) => method.id === methodId)
                          ? { methodId }
                          : {}),
                      },
                    }),
                  )
                }
              >
                {signedIn
                  ? "切换账户"
                  : auth?.phase === "failed" || auth?.phase === "cancelled"
                    ? usesCredentials
                      ? "重试连接"
                      : "重试登录"
                    : usesCredentials
                      ? "连接"
                      : "登录"}
              </Button>
            ) : null}
            {!active && signedIn && (provider.auth.canLogout ?? provider.setup?.canAuthenticate) ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || !auth}
                onClick={() => {
                  void ensureLocalApi()
                    .dialogs.confirm("共用此登录的会话将停止运行，会话历史会保留。", {
                      title: `退出 ${provider.displayName ?? provider.driver} 在 ${environmentLabel} 的登录？`,
                      confirmLabel: "退出登录",
                    })
                    .then((confirmed) => {
                      if (confirmed) void run(() => logout(target));
                    });
                }}
              >
                退出登录
              </Button>
            ) : null}
          </>
        </div>
      }
    >
      {interaction?.type === "terminal" ||
      interaction?.type === "credentials" ||
      interaction?.type === "deviceCode" ||
      (url && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction)) ||
      error ||
      query.error ? (
        <>
          {interaction?.type === "deviceCode" ? (
            <p className="py-2 text-sm text-muted-foreground">
              在浏览器中输入登录码{" "}
              <code className="select-all font-mono text-foreground">{interaction.userCode}</code>。
            </p>
          ) : null}
          {interaction?.type === "terminal" ? (
            <div className="py-2">
              <Suspense
                fallback={<p className="text-xs text-muted-foreground">正在加载登录终端…</p>}
              >
                <ProviderAuthTerminal
                  key={`${auth?.flowId}:${interaction.id}`}
                  output={interaction.output}
                  outputOffset={interaction.outputOffset}
                  onResponse={(response) => {
                    if (readOnly || !auth?.flowId) return;
                    for (
                      let offset = 0;
                      offset < Math.max(1, response.data.length);
                      offset += 4_096
                    ) {
                      terminalQueue.current.push({
                        instanceId,
                        flowId: auth.flowId,
                        interactionId: interaction.id,
                        response: {
                          ...response,
                          data: response.data.slice(offset, offset + 4_096),
                        },
                      });
                    }
                    if (terminalSending.current) return;
                    terminalSending.current = true;
                    void (async () => {
                      while (terminalQueue.current.length > 0) {
                        const input = terminalQueue.current.shift()!;
                        const result = await respond({ environmentId, input });
                        if (result._tag !== "Success") {
                          terminalQueue.current = [];
                          if (!isAtomCommandInterrupted(result))
                            setError("智能体登录终端已不可用。");
                          break;
                        }
                      }
                    })()
                      .catch(() => {
                        terminalQueue.current = [];
                        setError("无法向智能体登录终端发送输入。");
                      })
                      .finally(() => {
                        terminalSending.current = false;
                      });
                  }}
                />
              </Suspense>
            </div>
          ) : null}
          {interaction?.type === "credentials" ? (
            <form
              className="grid gap-2 py-2 text-sm leading-normal"
              onSubmit={(event) => {
                event.preventDefault();
                void send({ type: "credentials", values }).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            >
              {interaction.fields.map((field) => (
                <label key={field.name} className="grid gap-1">
                  {field.label}
                  <Input
                    size="sm"
                    type={field.secret ? "password" : "text"}
                    autoComplete="off"
                    value={values[field.name] ?? ""}
                    disabled={disabled}
                    maxLength={16_384}
                    onChange={(event) => updateDraft(field.name, event.target.value)}
                  />
                </label>
              ))}
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                className="w-fit"
                disabled={disabled}
              >
                连接
              </Button>
            </form>
          ) : null}
          {url && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction) ? (
            <form
              className="grid gap-2 py-2 text-sm leading-normal"
              onSubmit={(event) => {
                event.preventDefault();
                if (!auth?.flowId || !values.callback?.trim()) return;
                void run(() =>
                  complete({
                    environmentId,
                    input: { instanceId, flowId: auth.flowId!, callbackUrl: values.callback! },
                  }),
                ).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            >
              <label className="grid gap-1">
                如果最后的 localhost 页面无法加载，请在此粘贴完整 URL。
                <Input
                  size="sm"
                  id={`provider-callback-${instanceId}`}
                  type="url"
                  autoComplete="off"
                  value={values.callback ?? ""}
                  disabled={disabled}
                  maxLength={16_384}
                  onChange={(event) => updateDraft("callback", event.target.value)}
                />
              </label>
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                className="w-fit"
                disabled={disabled || !values.callback?.trim()}
              >
                继续
              </Button>
            </form>
          ) : null}
          {error || query.error ? (
            <div className="py-2 text-xs text-destructive">
              <p role="alert">
                {error ??
                  (query.error && /\p{Script=Han}/u.test(query.error)
                    ? query.error
                    : "无法读取登录状态，请重试。")}
              </p>
              <ErrorDetailsDisclosure
                detail={
                  errorDetail ??
                  (!error && query.error && !/\p{Script=Han}/u.test(query.error)
                    ? query.error
                    : null)
                }
              />
            </div>
          ) : null}
        </>
      ) : null}
    </SettingsRow>
  );
}
