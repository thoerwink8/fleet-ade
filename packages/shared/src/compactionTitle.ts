export type CompactionTitleStatus = "running" | "completed" | "failed" | "cancelled";

export function compactionTitle(status: CompactionTitleStatus): string {
  switch (status) {
    case "running":
      return "正在压缩上下文…";
    case "completed":
      return "上下文已压缩";
    case "failed":
      return "上下文压缩失败";
    case "cancelled":
      return "已停止压缩上下文";
  }
}
