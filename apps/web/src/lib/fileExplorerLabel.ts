export function revealInFileExplorerLabelForOs(
  os: string | null | undefined,
): string {
  switch (os) {
    case "darwin":
      return "在 Finder 中显示";
    case "win32":
      return "在资源管理器中显示";
    default:
      return "在文件管理器中显示";
  }
}

export function revealInFileExplorerLabelForKind(
  kind: "mac" | "windows" | "linux",
): string {
  switch (kind) {
    case "mac":
      return "在 Finder 中显示";
    case "windows":
      return "在资源管理器中显示";
    case "linux":
      return "在文件管理器中显示";
  }
}
