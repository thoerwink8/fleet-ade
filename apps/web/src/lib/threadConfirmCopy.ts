import type { ConfirmDialogCheckbox, ConfirmDialogOptions } from "@t3tools/contracts";

export interface ConfirmCopy {
  readonly message: string;
  readonly options: ConfirmDialogOptions;
}

const WORKTREE_CHECKBOX_LABEL = "同时删除它的工作树";

export function threadDeleteConfirmCopy(
  title: string,
  worktree: { readonly displayPath: string } | null,
): ConfirmCopy & { readonly checkbox: ConfirmDialogCheckbox | null } {
  const lines = [`“${title}”的所有消息和记录会被永久删除，无法恢复。想保留的话请改用归档。`];
  if (worktree) {
    lines.push(
      `只有这个会话在用的工作树：${worktree.displayPath}`,
      "勾选后，工作树目录和里面还没提交的改动也会一并删除。",
    );
  }
  return {
    message: lines.join("\n"),
    options: {
      title: "删除这个会话？",
      confirmLabel: "删除",
      variant: "destructive",
    },
    checkbox: worktree ? { label: WORKTREE_CHECKBOX_LABEL } : null,
  };
}

export function sideChatDeleteConfirmCopy(title: string): ConfirmCopy {
  return {
    message: `“${title}”的所有消息和记录会被永久删除，无法恢复。`,
    options: { title: "删除这个侧聊？", confirmLabel: "删除", variant: "destructive" },
  };
}

export function batchDeleteConfirmCopy(count: number): ConfirmCopy {
  return {
    message: "它们的所有消息和记录会被永久删除，无法恢复。想留着的请改用归档。",
    options: { title: `删除 ${count} 个会话？`, confirmLabel: "删除", variant: "destructive" },
  };
}

/** Asked after a batch delete went through, so declining keeps the worktrees and nothing else. */
export function batchWorktreeDeleteConfirmCopy(displayPaths: readonly string[]): ConfirmCopy {
  return {
    message: [
      "会话已经删除。下面这些工作树只有它们在用：",
      ...displayPaths,
      "删除后，工作树里还没提交的改动也会丢失。",
    ].join("\n"),
    options: {
      title: `同时删除这 ${displayPaths.length} 个工作树？`,
      confirmLabel: "删除工作树",
      cancelLabel: "保留工作树",
      variant: "destructive",
    },
  };
}
