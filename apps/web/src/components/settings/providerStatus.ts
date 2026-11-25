import type {
  ServerProvider,
  ServerProviderVersionAdvisory,
  ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";

export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-muted-foreground/50",
  },
  error: {
    dot: "bg-destructive",
  },
  neutral: {
    dot: "bg-muted-foreground",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

// Antigravity's local health check verifies installation, not Google sign-in.
// API-key and Agent Platform warnings still need attention.
function isAntigravitySignInUnchecked(provider: ServerProvider): boolean {
  return (
    provider.driver === "antigravity" &&
    provider.installed &&
    provider.status === "warning" &&
    provider.auth.status === "unknown" &&
    (provider.auth.type === undefined ||
      provider.auth.type === "oauth-personal" ||
      provider.auth.type === "oauth-business")
  );
}

export function getProviderStatusKey(provider: ServerProvider | undefined): ProviderStatusKey {
  if (provider && !provider.enabled) return "disabled";
  if (provider && isAntigravitySignInUnchecked(provider)) return "neutral";
  return provider?.status ?? "warning";
}

function splitProviderDiagnosticMessage(
  message: string | null | undefined,
  fallbackDetail: string | null,
): { readonly detail: string | null; readonly rawDetail: string | null } {
  const trimmed = message?.trim() ?? "";
  if (trimmed.length === 0) {
    return { detail: fallbackDetail, rawDetail: null };
  }
  if (/\p{Script=Han}/u.test(trimmed)) {
    return { detail: trimmed, rawDetail: null };
  }
  return { detail: fallbackDetail, rawDetail: trimmed };
}

export function getProviderSummary(provider: ServerProvider | undefined): {
  readonly headline: string;
  readonly detail: string | null;
  readonly rawDetail: string | null;
} {
  if (!provider) {
    return {
      headline: "正在检查智能体状态",
      detail: "正在等待后台服务返回安装和登录状态。",
      rawDetail: null,
    };
  }
  if (!provider.enabled || provider.status === "disabled") {
    return {
      headline: "已停用",
      ...splitProviderDiagnosticMessage(
        provider.message,
        "此智能体已安装，但已停用，无法用于 Fleet ADE 的新会话。",
      ),
    };
  }
  if (!provider.installed) {
    return {
      headline: "未安装",
      ...splitProviderDiagnosticMessage(provider.message, "这台电脑上还没安装这个智能体。"),
    };
  }
  if (provider.auth.status === "unauthenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `未登录 · ${authLabel}` : "未登录",
      // The sign-in button sits right next to this text, so a "run `claude auth login`" hint would duplicate it.
      ...(provider.driver === "claudeAgent" && provider.setup?.canAuthenticate === true
        ? { detail: "登录后即可开始使用。", rawDetail: null }
        : splitProviderDiagnosticMessage(provider.message, "登录后即可开始使用。")),
    };
  }
  if (isAntigravitySignInUnchecked(provider)) {
    return {
      headline: "已安装 · 未检查登录状态",
      ...splitProviderDiagnosticMessage(provider.message, null),
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "需要处理",
      ...splitProviderDiagnosticMessage(provider.message, "智能体已安装，但暂时无法完成检查。"),
    };
  }
  if (provider.status === "error") {
    return {
      headline: "不可用",
      ...splitProviderDiagnosticMessage(provider.message, "这个智能体暂时无法启动。"),
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `已登录 · ${authLabel}` : "已登录",
      ...splitProviderDiagnosticMessage(provider.message, null),
    };
  }
  return {
    headline: "可用",
    ...splitProviderDiagnosticMessage(provider.message, null),
  };
}

export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  const antigravity = /^agy_acp_server_(\d{4})(\d{2})(\d{2})_\d+(?:_(\w+))?$/.exec(version);
  if (antigravity) {
    const [, year, month, day, candidate] = antigravity;
    return `${year}-${month}-${day}${candidate ? ` ${candidate}` : ""}`;
  }
  return /^\d/.test(version) ? `v${version}` : version;
}

const COMPATIBILITY_TITLES = {
  graceful: "有限支持",
  unsupported: "不支持的版本",
  broken: "已知有问题的版本",
} as const;

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
  compatibility?: ServerProviderCompatibilityAdvisory | undefined,
  showCompatibility = true,
): {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
  readonly targetVersion: string | null;
} | null {
  const latestIsIncompatible =
    compatibility?.latestVersionStatus === "broken" ||
    compatibility?.latestVersionStatus === "unsupported";
  if (
    showCompatibility &&
    compatibility &&
    (compatibility.status === "graceful" ||
      compatibility.status === "unsupported" ||
      compatibility.status === "broken")
  ) {
    const targetVersion = compatibility.recommendedVersion;
    const recommendation = getProviderVersionLabel(targetVersion) ?? compatibility.recommendedRange;
    // Latest package versions cannot be updated into recommendations requiring another package.
    const isAlreadyLatest = advisory?.status === "current";
    return {
      title: COMPATIBILITY_TITLES[compatibility.status],
      detail:
        compatibility.message ??
        (recommendation ? `使用 ${recommendation} 以获得完整支持。` : "请更新以获得完整支持。"),
      updateCommand:
        targetVersion || latestIsIncompatible || isAlreadyLatest
          ? null
          : (advisory?.updateCommand ?? null),
      emphasis: compatibility.status === "graceful" ? "normal" : "strong",
      targetVersion,
    };
  }
  if (
    !advisory ||
    advisory.status === "current" ||
    advisory.status === "unknown" ||
    latestIsIncompatible
  ) {
    return null;
  }

  const label = "有可用更新";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    title: label,
    detail:
      advisory.message ??
      (versionLabel ? `${label}：安装 ${versionLabel}。` : `${label}：安装最新的智能体版本。`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
    targetVersion: null,
  };
}
