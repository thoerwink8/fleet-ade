import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(repository: string | undefined): string | null {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  if (!isValidRepositorySegment(owner) || !isValidRepositorySegment(name) || extra.length !== 0) {
    return null;
  }
  return `https://github.com/${configuredRepository}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  const releases = desktopReleaseRepositoryUrl(repository);
  if (!normalizedVersion || releases === null) return null;
  return `${releases}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  return desktopReleaseRepositoryUrl(repository);
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "当前安装使用了正确的架构。";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "这台 Mac 使用 Apple Silicon，但 Fleet ADE 仍以 Rosetta 运行 Intel 版本。下载可用更新即可切换到原生的 Apple Silicon 版本。";
  }
  if (action === "install") {
    return "这台 Mac 使用 Apple Silicon，但 Fleet ADE 仍以 Rosetta 运行 Intel 版本。重启即可安装已下载的 Apple Silicon 版本。";
  }
  return "这台 Mac 使用 Apple Silicon，但 Fleet ADE 仍以 Rosetta 运行 Intel 版本。下次应用更新会将其替换为原生的 Apple Silicon 版本。";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return `更新 ${state.notAppliedVersion} 未生效。点击重试。`;
  }
  if (state.status === "available") {
    return `更新 ${state.availableVersion ?? "available"} 已可下载`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `正在下载更新${progress}`;
  }
  if (state.status === "downloaded") {
    return `更新 ${state.downloadedVersion ?? state.availableVersion ?? "ready"} 已下载。点击重启并安装。`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `下载 ${state.availableVersion} 失败。点击重试。`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `安装 ${state.downloadedVersion} 失败。点击重试。`;
    }
    if (state.downloadedVersion) {
      return `更新 ${state.downloadedVersion} 已下载。点击重启并安装。`;
    }
    return state.message ?? "更新失败";
  }
  return "已是最新版本";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Install update${version ? ` ${version}` : ""} and restart Fleet ADE?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
): string | null {
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || "此版本不支持自动更新。";
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state);
  return disabledReason
    ? { title: "更新不可用", detail: disabledReason }
    : { title: "检查更新", detail: null };
}
