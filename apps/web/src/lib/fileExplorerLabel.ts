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

export function revealInFileExplorerLabelForKind(kind: string): string {
  if (kind === "finder") return "在 Finder 中显示";
  if (kind === "file-explorer") return "在资源管理器中显示";
  return "在文件管理器中显示";
}
