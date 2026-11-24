import type { StorageCleanupPreviewCategory } from "@t3tools/contracts";

import { formatBytes } from "../../lib/formatBytes";

const STORAGE_CLEANUP_CONFIRM_TITLE = "删除这些内容？";
const STORAGE_CLEANUP_CONFIRM_VERB = "删除";
export const STORAGE_CLEANUP_NOTHING_TO_DELETE = "按当前规则，没有要删除的内容。";

const CATEGORY_LABEL = {
  worktree: "工作树",
  "browser-artifacts": "浏览器产物",
  logs: "轮转日志",
} as const;

export type StorageCleanupAmount = {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly bytes: number;
};

export function storageCleanupAmounts(
  previews: readonly {
    readonly environmentLabel: string | null;
    readonly categories: readonly StorageCleanupPreviewCategory[];
  }[],
): StorageCleanupAmount[] {
  const named = previews.length > 1;
  const amounts: StorageCleanupAmount[] = [];
  for (const preview of previews) {
    for (const category of preview.categories) {
      const name = CATEGORY_LABEL[category.kind];
      const label =
        named && preview.environmentLabel !== null ? `${preview.environmentLabel}的${name}` : name;
      const count =
        category.kind === "worktree" ? `${category.count} 个` : `${category.count} 个文件`;
      const unknown =
        category.unknownCount > 0 ? `（另有 ${category.unknownCount} 项大小未知）` : "";
      amounts.push({
        key: `${preview.environmentLabel ?? ""}:${category.kind}`,
        label,
        bytes: category.bytes,
        detail: `${count}，${formatBytes(category.bytes)}${unknown}`,
      });
    }
  }
  return amounts;
}

/** The figure next to 合计. It is the sum of the category lines, and skips unknown sizes. */
export function storageCleanupListedTotal(amounts: readonly { readonly bytes: number }[]): number {
  return amounts.reduce((sum, amount) => sum + amount.bytes, 0);
}

export type StorageCleanupConfirmState = {
  readonly title: string;
  readonly confirmLabel: string;
  readonly confirmDisabled: boolean;
  readonly disabledReason: string | null;
  /** Shown above the list when some items could not be checked but others can be removed. */
  readonly notice: string | null;
  readonly totalBytes: number;
};

export function storageCleanupConfirmState(input: {
  readonly amounts: readonly StorageCleanupAmount[];
  readonly failures: readonly string[];
}): StorageCleanupConfirmState {
  const totalBytes = storageCleanupListedTotal(input.amounts);
  const failure = input.failures.find((reason) => reason.trim().length > 0) ?? null;
  if (input.amounts.length === 0) {
    return {
      title: STORAGE_CLEANUP_CONFIRM_TITLE,
      confirmLabel: STORAGE_CLEANUP_CONFIRM_VERB,
      confirmDisabled: true,
      disabledReason: failure ?? STORAGE_CLEANUP_NOTHING_TO_DELETE,
      notice: null,
      totalBytes: 0,
    };
  }
  // One item that cannot be checked must not stop the rest from being cleaned.
  return {
    title: STORAGE_CLEANUP_CONFIRM_TITLE,
    confirmLabel: STORAGE_CLEANUP_CONFIRM_VERB,
    confirmDisabled: false,
    disabledReason: null,
    notice: failure === null ? null : `有内容无法检查，不在下面的列表里：${failure}`,
    totalBytes,
  };
}

export async function runStorageCleanupIfConfirmed(
  choice: "cancel" | "confirm",
  state: Pick<StorageCleanupConfirmState, "confirmDisabled">,
  run: () => Promise<void>,
): Promise<boolean> {
  if (choice !== "confirm" || state.confirmDisabled) return false;
  await run();
  return true;
}

export function storageCleanupButtonLabel(
  phase: "idle" | "previewing" | "running" | "failed",
): string {
  if (phase === "previewing") return "正在计算…";
  if (phase === "running") return "正在删除…";
  if (phase === "failed") return "再试一次";
  return "立即删除";
}

export function storageCleanupFreedMessage(bytes: number): string {
  return `已释放 ${formatBytes(bytes)}。`;
}

export function storageCleanupFailureMessage(freedBytes: number, reason: string): string {
  const freed = freedBytes > 0 ? storageCleanupFreedMessage(freedBytes) : "";
  return `${freed}无法删除：${reason}`;
}
