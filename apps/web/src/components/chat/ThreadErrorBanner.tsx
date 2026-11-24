import type {
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { memo } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { ExpandableText } from "../settings/ExpandableText";
import { ErrorDetailsDisclosure } from "./ErrorDetailsDisclosure";
import { classifyProviderError, type AlternativeReadyAgent } from "./providerErrorClassification";

export function getThreadErrorBannerMessage(error: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(error);
  } catch {
    return error;
  }
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return error;
  }
  const nestedError = payload.error;
  if (typeof nestedError !== "object" || nestedError === null || !("message" in nestedError)) {
    return error;
  }
  return typeof nestedError.message === "string" && nestedError.message.trim().length > 0
    ? nestedError.message
    : error;
}

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

function isChatGptUsageLimitError(errorCode?: string | null): boolean {
  return errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE || errorCode === CHATGPT_USAGE_LIMIT_CODE;
}

export function getThreadErrorBannerVariant(
  errorClass?: OrchestrationV2ProviderFailureClass | null,
  errorCode?: string | null,
): "warning" | "error" {
  return errorClass === "usage_limit" || isChatGptUsageLimitError(errorCode) ? "warning" : "error";
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  errorClass,
  errorCode,
  classifyError = true,
  agentName,
  retryCount,
  usageLimitResetAt,
  providerStatus,
  alternativeAgent,
  timestampFormat,
  onSignIn,
  onInstallHelp,
  onSwitchAgent,
  onRetry,
}: {
  error: string | null;
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  errorCode?: string | null;
  /** False for errors the app wrote itself (a rejected send): they show as written, not as an agent failure. */
  classifyError?: boolean;
  agentName?: string | null;
  retryCount?: number | null;
  usageLimitResetAt?: string | null;
  providerStatus?: ServerProvider | null;
  alternativeAgent?: AlternativeReadyAgent | null;
  timestampFormat?: TimestampFormat;
  onSignIn?: () => void;
  onInstallHelp?: () => void;
  onSwitchAgent?: (instanceId: ProviderInstanceId) => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  const chatGptLimit = isChatGptUsageLimitError(errorCode);
  if (!classifyError) {
    return (
      <Alert
        variant={getThreadErrorBannerVariant(errorClass, errorCode)}
        controlAlignment="first-line"
      >
        <CircleAlertIcon />
        <AlertDescription>
          <ExpandableText text={error} collapsedText={getThreadErrorBannerMessage(error)} />
        </AlertDescription>
        {onDismiss ? (
          <AlertAction>
            <Button variant="ghost-muted" size="icon-sm" aria-label="关闭错误" onClick={onDismiss}>
              <XIcon />
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    );
  }
  const classified = classifyProviderError({
    agentName: agentName?.trim() || "智能体",
    rawError: error,
    errorClass: errorClass ?? null,
    errorCode: errorCode ?? null,
    retryCount: retryCount ?? null,
    usageLimitResetAt: usageLimitResetAt ?? null,
    providerStatus: providerStatus ?? null,
    alternativeAgent: alternativeAgent ?? null,
    ...(timestampFormat === undefined ? {} : { timestampFormat }),
  });

  const nextStepAction = (() => {
    const action = classified.action;
    if (!action) return null;
    switch (action.kind) {
      case "sign_in":
        return onSignIn ? { label: action.label, onClick: onSignIn } : null;
      case "install_help":
        return onInstallHelp ? { label: action.label, onClick: onInstallHelp } : null;
      case "switch_agent":
        return onSwitchAgent
          ? { label: action.label, onClick: () => onSwitchAgent(action.targetInstanceId) }
          : null;
      case "retry":
        return onRetry ? { label: action.label, onClick: onRetry } : null;
    }
  })();

  return (
    <Alert variant={classified.variant} controlAlignment="first-line">
      {chatGptLimit ? <OpenAI className="size-4" aria-hidden="true" /> : <CircleAlertIcon />}
      <AlertTitle>{classified.message}</AlertTitle>
      {classified.rawDetail ? (
        <AlertDescription>
          <ErrorDetailsDisclosure detail={classified.rawDetail} />
        </AlertDescription>
      ) : null}
      {(nextStepAction || chatGptLimit || onDismiss) && (
        <AlertAction>
          {chatGptLimit ? <ChatGptUsageButton variant="default" size="sm" /> : null}
          {nextStepAction ? (
            <Button
              variant={classified.variant === "warning" ? "default" : "outline"}
              size="sm"
              onClick={nextStepAction.onClick}
            >
              {nextStepAction.label}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button variant="ghost-muted" size="icon-sm" aria-label="关闭错误" onClick={onDismiss}>
              <XIcon />
            </Button>
          ) : null}
        </AlertAction>
      )}
    </Alert>
  );
});
