import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { memo, useState, useSyncExternalStore } from "react";
import { InfoIcon, XIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ErrorDetailsDisclosure } from "./ErrorDetailsDisclosure";
import { useEnvironment } from "../../state/environments";
import { providerSetupGuidance } from "../settings/providerSetupGuidance.logic";
import { classifyProviderError, type AlternativeReadyAgent } from "./providerErrorClassification";

function getIncompatibleVersion(status: ServerProvider) {
  const compatibility = status.compatibilityAdvisory;
  if (status.status === "error" && status.auth.status === "unauthenticated") return null;
  return compatibility?.status === "broken" ||
    (status.status === "ready" && compatibility?.status === "unsupported")
    ? compatibility
    : null;
}

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  if (!status || status.status === "disabled") return null;
  const incompatible = getIncompatibleVersion(status);
  if (incompatible) {
    return [
      status.instanceId,
      incompatible.status,
      status.version ?? "",
      incompatible.message ?? "",
    ].join("\u0000");
  }
  if (status.status === "ready") return null;
  // Antigravity validates credentials at session start; unknown restart auth is not failure.
  if (
    status.driver === "antigravity" &&
    status.installed &&
    status.status === "warning" &&
    status.auth.status === "unknown"
  ) {
    return null;
  }
  return [status.instanceId, status.status, status.auth.status, status.message ?? ""].join(
    "\u0000",
  );
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  isDismissed: boolean,
): boolean {
  return getProviderStatusBannerKey(status) !== null && !isDismissed;
}

// Built-in instance ids such as `codex` repeat across environments.
export function getProviderStatusDismissalKey(
  environmentId: string | undefined,
  status: ServerProvider | null,
): string | null {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey === null ? null : `${environmentId ?? ""}\u0000${bannerKey}`;
}

// A dismissal lasts the session, not one view, so opening another thread cannot bring it back.
const sessionDismissedProviderStatusBannerKeys = new Set<string>();
const dismissalListeners = new Set<() => void>();

export function dismissProviderStatusBannerForSession(bannerKey: string | null): void {
  if (bannerKey === null || sessionDismissedProviderStatusBannerKeys.has(bannerKey)) return;
  sessionDismissedProviderStatusBannerKeys.add(bannerKey);
  for (const listener of dismissalListeners) listener();
}

export function isProviderStatusBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedProviderStatusBannerKeys.has(bannerKey);
}

function subscribeToDismissals(listener: () => void) {
  dismissalListeners.add(listener);
  return () => dismissalListeners.delete(listener);
}

export function useProviderStatusBannerDismissed(bannerKey: string | null): boolean {
  return useSyncExternalStore(subscribeToDismissals, () =>
    isProviderStatusBannerDismissedForSession(bannerKey),
  );
}

export function hasProviderSetup(status: ServerProvider): boolean {
  return (
    status.driver === "antigravity" ||
    status.setup?.canAuthenticate === true ||
    status.setup?.canInstall === true
  );
}
export function getProviderStatusBannerVariant(status: ServerProvider): "warning" | "error" {
  const incompatible = getIncompatibleVersion(status);
  return incompatible?.status !== "broken" && (status.status === "warning" || incompatible !== null)
    ? "warning"
    : "error";
}

export function getProviderStatusMessage(status: ServerProvider): string {
  if (
    status.auth.status !== "unauthenticated" &&
    status.compatibilityAdvisory?.status === "broken" &&
    status.compatibilityAdvisory.message
  ) {
    return status.compatibilityAdvisory.message;
  }
  if (status.message) return status.message;
  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  if (!status.installed && hasProviderSetup(status)) {
    return `打开智能体设置，在这台电脑上安装 ${formatProviderDriverKindLabel(status.driver)}。`;
  }
  if (status.auth.status === "unauthenticated") {
    if (hasProviderSetup(status)) {
      return status.driver === "antigravity"
        ? "打开智能体设置，使用 Google 登录。"
        : "打开智能体设置进行登录。";
    }
    return "请重新登录这个智能体。";
  }
  return status.status === "ready"
    ? "这个智能体没有可用的模型。"
    : status.status === "error"
      ? `${providerName} 不可用。`
      : `${providerName} 部分可用。`;
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  environmentId,
  onDismiss,
  onOpenProviderSetup,
  alternativeAgent,
  onSwitchAgent,
  status,
}: {
  environmentId: EnvironmentId;
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  alternativeAgent?: AlternativeReadyAgent | null;
  onSwitchAgent?: (instanceId: ProviderInstanceId) => void;
  status: ServerProvider | null;
}) {
  const canRefresh = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "刷新智能体状态",
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const environmentLabel = useEnvironment(environmentId)?.label ?? "这台电脑";

  const refresh = async () => {
    if (!status || !canRefresh || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refreshProviders({
        environmentId,
        input: { instanceId: status.instanceId, refreshModels: true },
      });
    } catch (cause) {
      setIsRefreshing(false);
      throw cause;
    }
    setIsRefreshing(false);
  };

  if (!status || getProviderStatusBannerKey(status) === null) {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const guidance = providerSetupGuidance({ provider: status, environmentLabel });
  const incompatible = getIncompatibleVersion(status);
  const classified =
    incompatible === null
      ? classifyProviderError({
          agentName: providerName,
          rawError: status.message ?? null,
          providerStatus: status,
          alternativeAgent: alternativeAgent ?? null,
        })
      : null;

  const title = incompatible
    ? `${providerName} ${status.version ?? ""} ${incompatible.status === "broken" ? "已知不兼容" : "版本不受支持"}`.trim()
    : guidance.action
      ? guidance.message
      : classified!.message;
  const rawDetail = incompatible
    ? (incompatible.message ?? status.message ?? null)
    : classified!.rawDetail;
  const variant = incompatible ? getProviderStatusBannerVariant(status) : classified!.variant;

  const primaryAction = (() => {
    if (incompatible) {
      if (onOpenProviderSetup && hasProviderSetup(status)) {
        return {
          label: "打开智能体设置",
          disabled: false,
          onClick: () => onOpenProviderSetup(status.instanceId),
        };
      }
      return {
        label: isRefreshing ? "正在重试…" : "再试一次",
        disabled: !canRefresh || isRefreshing,
        onClick: () => void refresh(),
      };
    }
    const action = classified!.action;
    if (!action) return null;
    switch (action.kind) {
      case "sign_in":
      case "install_help":
        return onOpenProviderSetup
          ? {
              label: action.label,
              disabled: false,
              onClick: () => onOpenProviderSetup(status.instanceId),
            }
          : null;
      case "switch_agent":
        return onSwitchAgent
          ? {
              label: action.label,
              disabled: false,
              onClick: () => onSwitchAgent(action.targetInstanceId),
            }
          : null;
      case "retry":
        return {
          label: isRefreshing ? "正在重试…" : action.label,
          disabled: !canRefresh || isRefreshing,
          onClick: () => void refresh(),
        };
    }
  })();

  return (
    <Alert
      variant={variant}
      role={incompatible && incompatible.status !== "broken" ? "status" : "alert"}
      controlAlignment="first-line"
    >
      <InfoIcon />
      <AlertTitle>{title}</AlertTitle>
      {rawDetail && rawDetail !== title ? (
        <AlertDescription>
          <ErrorDetailsDisclosure detail={rawDetail} />
        </AlertDescription>
      ) : null}
      <AlertAction>
        {primaryAction ? (
          <Button
            disabled={primaryAction.disabled}
            onClick={primaryAction.onClick}
            size="sm"
            variant="secondary"
          >
            {primaryAction.label}
          </Button>
        ) : null}
        <Button
          aria-label={`关闭 ${providerName} 提示（${status.status}）`}
          onClick={onDismiss}
          size="sm"
          icon
          variant="muted"
        >
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
});
