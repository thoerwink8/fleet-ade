import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";

export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return "在 Finder 中显示";
  if (os === "windows") return "在文件资源管理器中显示";
  return "在“文件”中显示";
}

export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return "在 Finder 中显示";
  if (kind === "file-explorer") return "在文件资源管理器中显示";
  return "在“文件”中显示";
}
