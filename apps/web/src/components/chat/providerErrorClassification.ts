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

import { formatUpcomingTimestamp } from "../../timestampFormat";

export type ClassifiedProviderErrorCategory =
  | "auth"
  | "not_installed"
  | "usage_limit"
  | "network_unavailable"
  | "other";

export type ClassifiedProviderErrorAction =
  | { readonly kind: "sign_in"; readonly label: "去登录" }
  | { readonly kind: "install_help"; readonly label: "查看安装方法" }
  | {
      readonly kind: "switch_agent";
      readonly label: string;
      readonly targetInstanceId: ProviderInstanceId;
    }
  | { readonly kind: "retry"; readonly label: "再试一次" };

export interface AlternativeReadyAgent {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
}

export interface ClassifyProviderErrorInput {
  readonly agentName: string;
  readonly rawError?: string | null;
  readonly errorClass?: OrchestrationV2ProviderFailureClass | null;
  readonly errorCode?: string | null;
  readonly retryCount?: number | null;
  readonly usageLimitResetAt?: string | null;
  readonly providerStatus?: Pick<ServerProvider, "driver" | "installed" | "auth" | "status"> | null;
  readonly alternativeAgent?: AlternativeReadyAgent | null;
  readonly timestampFormat?: TimestampFormat;
}

export interface ClassifiedProviderError {
  readonly category: ClassifiedProviderErrorCategory;
  readonly variant: "warning" | "error";
  readonly message: string;
  readonly rawDetail: string | null;
  readonly action: ClassifiedProviderErrorAction | null;
}

interface ClassificationRuleContext {
  readonly normalizedRawError: string;
  readonly errorClass: OrchestrationV2ProviderFailureClass | null;
  readonly errorCode: string | null;
  readonly providerStatus: Pick<ServerProvider, "driver" | "installed" | "auth" | "status"> | null;
}

interface ClassificationRule {
  readonly category: Exclude<ClassifiedProviderErrorCategory, "other">;
  readonly matches: (ctx: ClassificationRuleContext) => boolean;
}

const NOT_INSTALLED_ERROR_PATTERN =
  /\bspawn\s+\S+\s+ENOENT\b|command not found|executable.*not found|cli.*not found|not installed|未安装|未在\s*PATH/i;
const FORBIDDEN_PATTERN = /\b403\b|\bforbidden\b|permission denied/i;
const AUTH_ERROR_PATTERN =
  /(?:status(?:\s+code)?|http|code|error)\W{0,3}401\b|\b401\s+(?:unauthorized|error)\b|\bunauthorized\b|invalid_api_key|invalid api key|token(?:\s+has)?\s+expired|expired\s+token|authentication[_\s]+failed|authentication[_\s]+required|credentials?\s+expired|not signed in|please sign in|run `claude auth login`|重新登录|未登录|需要登录/i;
const USAGE_LIMIT_PATTERN =
  /(?:status(?:\s+code)?|http|code|error)\W{0,3}429\b|\b429\s+too many|rate[_ ]limit|usage[_ ]limit|quota[_ ]exhausted|QUOTA_EXHAUSTED|too many requests|用量(?:已)?到?上限|已达到.*用量上限/i;
const NETWORK_ERROR_PATTERN =
  /\b(?:ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|fetch failed|network error|connection closed|stream disconnected|(?:status(?:\s+code)?|http|code|error)\W{0,3}(?:502|503|504|529)\b|\((?:502|503|504|529)\)|service unavailable|overloaded/i;

const AUTH_ERROR_CODES = new Set(["api_error_401", "unauthorized", "invalidApiKey", "-32000"]);
const USAGE_LIMIT_CODES = new Set([
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
  "api_error_429",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "RESOURCE_EXHAUSTED",
]);
const NETWORK_ERROR_CODES = new Set([
  "api_error_502",
  "api_error_503",
  "api_error_504",
  "api_error_529",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "overloaded",
]);

function isAntigravityUnknownAuthStatus(
  status: Pick<ServerProvider, "driver" | "installed" | "auth" | "status"> | null,
): boolean {
  return (
    status !== null &&
    status.driver === "antigravity" &&
    status.installed &&
    status.auth.status === "unknown"
  );
}

/**
 * Pure table-driven classification rules for provider failures and provider status banners.
 * Rules are ordered from most specific (missing binary, authentication, quota limit) to
 * transient network failures; anything ambiguous falls through to `"other"`.
 */
const PROVIDER_ERROR_CLASSIFICATION_RULES: ReadonlyArray<ClassificationRule> = [
  {
    category: "not_installed",
    matches: (ctx) =>
      ctx.errorClass === "not_installed" ||
      ctx.providerStatus?.installed === false ||
      ctx.errorCode === "ENOENT" ||
      NOT_INSTALLED_ERROR_PATTERN.test(ctx.normalizedRawError),
  },
  {
    category: "auth",
    matches: (ctx) => {
      if (ctx.errorClass === "permission_error" || ctx.errorCode === "api_error_403") {
        return false;
      }
      if (ctx.errorClass === "auth_error") {
        return true;
      }
      if (
        ctx.providerStatus !== null &&
        ctx.providerStatus.auth.status === "unauthenticated" &&
        !isAntigravityUnknownAuthStatus(ctx.providerStatus)
      ) {
        return true;
      }
      if (ctx.errorCode !== null && AUTH_ERROR_CODES.has(ctx.errorCode)) {
        return true;
      }
      if (FORBIDDEN_PATTERN.test(ctx.normalizedRawError)) {
        return false;
      }
      return AUTH_ERROR_PATTERN.test(ctx.normalizedRawError);
    },
  },
  {
    category: "usage_limit",
    matches: (ctx) =>
      ctx.errorClass === "usage_limit" ||
      (ctx.errorCode !== null && USAGE_LIMIT_CODES.has(ctx.errorCode)) ||
      USAGE_LIMIT_PATTERN.test(ctx.normalizedRawError),
  },
  {
    category: "network_unavailable",
    matches: (ctx) =>
      ctx.errorClass === "transport_error" ||
      (ctx.errorCode !== null && NETWORK_ERROR_CODES.has(ctx.errorCode)) ||
      NETWORK_ERROR_PATTERN.test(ctx.normalizedRawError),
  },
];

/**
 * Joins a name into a sentence. A Latin name (Codex) is set off from Chinese text by a space;
 * the generic "智能体" is not, so it never reads "智能体 出错了".
 */
function nameInSentence(name: string, before: string, after: string): string {
  const spaceBefore = before.length > 0 && /^[A-Za-z0-9]/.test(name) ? " " : "";
  const spaceAfter =
    after.length > 0 && /[A-Za-z0-9]$/.test(name) && !/^[，。、；：]/.test(after) ? " " : "";
  return `${before}${spaceBefore}${name}${spaceAfter}${after}`;
}

function formatResetAtLabel(
  resetAt: string | null | undefined,
  timestampFormat: TimestampFormat,
): string | null {
  if (!resetAt) return null;
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return null;
  const formatted = formatUpcomingTimestamp(resetAt, timestampFormat).trim();
  return formatted.length > 0 ? formatted : null;
}

export function classifyProviderError(input: ClassifyProviderErrorInput): ClassifiedProviderError {
  const trimmedRaw = input.rawError?.trim() ?? "";
  const rawDetail = trimmedRaw.length > 0 ? trimmedRaw : null;
  const ctx: ClassificationRuleContext = {
    normalizedRawError: trimmedRaw,
    errorClass: input.errorClass ?? null,
    errorCode: input.errorCode ?? null,
    providerStatus: input.providerStatus ?? null,
  };
  const matched = PROVIDER_ERROR_CLASSIFICATION_RULES.find((rule) => rule.matches(ctx));
  const category: ClassifiedProviderErrorCategory = matched?.category ?? "other";

  switch (category) {
    case "not_installed":
      return {
        category,
        variant: "error",
        message: nameInSentence(input.agentName, "这台电脑上没装", ""),
        rawDetail,
        action: { kind: "install_help", label: "查看安装方法" },
      };
    case "auth":
      return {
        category,
        variant: "error",
        message: nameInSentence(input.agentName, "", "需要重新登录"),
        rawDetail,
        action: { kind: "sign_in", label: "去登录" },
      };
    case "usage_limit": {
      const resetLabel = formatResetAtLabel(
        input.usageLimitResetAt,
        input.timestampFormat ?? "locale",
      );
      return {
        category,
        variant: "warning",
        message: resetLabel
          ? nameInSentence(input.agentName, "", `用量到上限了，${resetLabel} 恢复`)
          : nameInSentence(input.agentName, "", "用量到上限了"),
        rawDetail,
        action: input.alternativeAgent
          ? {
              kind: "switch_agent",
              label: `换用 ${input.alternativeAgent.displayName}`,
              targetInstanceId: input.alternativeAgent.instanceId,
            }
          : null,
      };
    }
    case "network_unavailable": {
      const retryCount =
        typeof input.retryCount === "number" && input.retryCount > 0
          ? Math.trunc(input.retryCount)
          : null;
      return {
        category,
        variant: "error",
        message:
          retryCount !== null
            ? nameInSentence(input.agentName, "连不上", `，已重试 ${retryCount} 次`)
            : nameInSentence(input.agentName, "连不上", ""),
        rawDetail,
        action: { kind: "retry", label: "再试一次" },
      };
    }
    case "other":
      return {
        category,
        variant: "error",
        message: nameInSentence(input.agentName, "", "出错了"),
        rawDetail,
        action: { kind: "retry", label: "再试一次" },
      };
  }
}
