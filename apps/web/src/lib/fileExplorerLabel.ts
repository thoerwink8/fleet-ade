import type { ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";

export function revealInFileExplorerLabelForOs(
  os: ExecutionEnvironmentPlatformOs | null | undefined,
): string {
  switch (os) {
    case "darwin":
      return "在 Finder 中显示";
    case "windows":
      return "在资源管理器中显示";
    default:
      return "在文件管理器中显示";
  }
}

export function revealInFileExplorerLabelForKind(
  kind: "finder" | "file-explorer" | "files",
): string {
  switch (kind) {
    case "finder":
      return "在 Finder 中显示";
    case "file-explorer":
      return "在资源管理器中显示";
    case "files":
      return "在文件管理器中显示";
  }
}
