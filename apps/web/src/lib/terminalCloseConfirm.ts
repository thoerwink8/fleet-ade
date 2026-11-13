import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

export async function confirmTerminalClose(
  labels: readonly [string, ...string[]],
): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [`关闭终端“${labels[0]}”？`, "这会停止正在运行的进程并清除其历史记录。"].join("\n")
        : [
            `关闭 ${labels.length} 个终端？`,
            `这会停止它们正在运行的进程并清除其历史记录：${labels
              .map((label) => `"${label}"`)
              .join(", ")}。`,
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
