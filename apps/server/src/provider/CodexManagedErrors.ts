const legacyFailures = {
  subscription_sharing_v2_user_not_eligible: {
    message: "此账户或工作区不能使用 ChatGPT 共享。请换一个提供方，或查看它的共享策略。",
  },
  subscription_sharing_usage_limit_exceeded: {
    message: "你的 ChatGPT 用量已到上限。请到 ChatGPT 的用量设置里查看剩余额度。",
  },
  subscription_sharing_workplace_individual_usage_limit_exceeded: {
    message: "你的 ChatGPT 用量已到上限。请到 ChatGPT 的用量设置里查看剩余额度。",
  },
  subscription_sharing_usage_unavailable: {
    message: "ChatGPT 用量暂时不可用。请稍后再试。",
  },
  subscription_sharing_unsupported_capability: {
    message: "Codex 用了 ChatGPT 共享不支持的功能。请换一个提供方来处理这个请求。",
  },
  subscription_sharing_v2_client_not_enabled: {
    message: "这个应用没有对这条 ChatGPT 连接启用。请用现有的命令行，或换一个提供方。",
  },
  subscription_sharing_v2_route_not_supported: {
    message: "ChatGPT 不支持这条请求路径。",
  },
  subscription_sharing_v2_invalid_user: {
    message: "ChatGPT 无法验证这条连接。请检查所选账户和共享权限。",
  },
  subscription_sharing_v2_user_unavailable: {
    message: "ChatGPT 暂时不可用。请稍后再试。",
  },
} as const;
const failures = {
  ...legacyFailures,
  subscription_sharing_user_not_eligible: legacyFailures.subscription_sharing_v2_user_not_eligible,
  subscription_sharing_route_not_supported:
    legacyFailures.subscription_sharing_v2_route_not_supported,
  subscription_sharing_invalid_user: legacyFailures.subscription_sharing_v2_invalid_user,
  subscription_sharing_user_unavailable: legacyFailures.subscription_sharing_v2_user_unavailable,
  chatpass_v2_scope_not_authorized: {
    message: "这条 ChatGPT 授权不允许这个请求。请检查连接的共享权限。",
  },
  chatpass_v2_invalid_authorization_context: {
    message: "ChatGPT 无法授权这条连接。请检查客户端和共享权限。",
  },
};
const usageLimitCodes = new Set<string>([
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_workplace_individual_usage_limit_exceeded",
]);

function unwrapError(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  return typeof value === "object" && value !== null && "error" in value ? value.error : value;
}

function isManagedCode(value: unknown): value is keyof typeof failures {
  return typeof value === "string" && Object.hasOwn(failures, value);
}

function sharingCode(value: unknown) {
  const error = unwrapError(value);
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : error;
  return isManagedCode(code) ? code : undefined;
}

export function classifyCodexManagedError(value: unknown) {
  const error = unwrapError(value);
  const messages =
    typeof error === "string"
      ? [error]
      : typeof error === "object" && error !== null
        ? [
            "message" in error ? error.message : null,
            "additionalDetails" in error ? error.additionalDetails : null,
          ].filter((message): message is string => typeof message === "string")
        : [];
  const code =
    sharingCode(error) ??
    messages.map(sharingCode).find((code) => code !== undefined) ??
    // Codex can stream ChatGPT's sharing-limit prose without its code.
    (messages.some((message) =>
      message.includes("has reached their Subscription Sharing usage limit"),
    )
      ? "subscription_sharing_usage_limit_exceeded"
      : undefined);
  if (code === undefined) return undefined;
  const failure = { ...failures[code], code, usageLimit: usageLimitCodes.has(code) };
  const text = messages.join(" ");
  if (code === "subscription_sharing_unsupported_capability") {
    if (text.includes("tool 'namespace'"))
      return {
        ...failure,
        message: "Codex 发送了 ChatGPT 共享不支持的工具命名空间。请换一个提供方来处理这个请求。",
      };
    if (text.includes("additional_tools"))
      return {
        ...failure,
        message: "Codex 发送了 ChatGPT 共享不支持的输入项。请换一个提供方来处理这个请求。",
      };
  }
  return failure;
}
