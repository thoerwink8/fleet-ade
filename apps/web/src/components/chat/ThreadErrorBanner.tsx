import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
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
}: {
  error: string | null;
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  errorCode?: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  const chatGptLimit = isChatGptUsageLimitError(errorCode);
  const variant = getThreadErrorBannerVariant(errorClass, errorCode);
  return (
    <Alert variant={variant} controlAlignment="first-line">
      {chatGptLimit ? <OpenAI className="size-4" aria-hidden="true" /> : <CircleAlertIcon />}
      {chatGptLimit ? (
        <AlertTitle>已达到 ChatGPT 用量上限</AlertTitle>
      ) : (
        <AlertDescription>
          <ExpandableText text={error} collapsedText={getThreadErrorBannerMessage(error)} />
        </AlertDescription>
      )}
      {(chatGptLimit || onDismiss) && (
        <AlertAction>
          {chatGptLimit ? <ChatGptUsageButton variant="default" size="sm" /> : null}
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
