import type {
  ProjectId,
  ServerSettings,
  ServerSettingsPatch,
  StorageCleanupPreviewCategory,
  StorageCleanupReport,
  WorktreeCleanupRules,
  WorktreeKeepWhen,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import { formatBytes } from "../../lib/formatBytes";

export const DEFAULT_RETENTION_DAYS = 8;
const MAX_RETENTION_DAYS = 3650;
export const STORAGE_CLEANUP_NOTHING_TO_DELETE = "按当前规则，没有要删除的内容。";

export type StorageCleanupConfirmIntent = "run" | "enable" | "update";

const STORAGE_CLEANUP_CONFIRM_COPY = {
  run: {
    title: "删除这些内容？",
    description: "将按当前的清理规则删除下面这些内容。",
    confirmLabel: "删除",
  },
  enable: {
    title: "打开这条规则会马上删除这些内容",
    description: "现在打开会马上清掉下面这些内容，之后也会按规则自动清理。",
    confirmLabel: "打开并清理",
  },
  update: {
    title: "修改这条规则会马上删除这些内容",
    description: "应用新设置后会马上清掉下面这些内容。",
    confirmLabel: "修改并清理",
  },
} as const satisfies Record<
  StorageCleanupConfirmIntent,
  {
    readonly title: string;
    readonly description: string;
    readonly confirmLabel: string;
  }
>;

const CATEGORY_LABEL = {
  worktree: "工作树",
  "browser-artifacts": "浏览器产物",
  logs: "轮转日志",
} as const;

const WORKTREE_KEEP_WHEN_STRICTNESS: Record<WorktreeKeepWhen, number> = {
  "any-local-files": 2,
  "uncommitted-changes": 1,
  "tracked-changes": 0,
};

export function clampRetentionDays(next: number, minimum = 1): number {
  return Math.min(MAX_RETENTION_DAYS, Math.max(minimum, Math.round(next)));
}

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
  readonly description: string;
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
  readonly intent?: StorageCleanupConfirmIntent;
}): StorageCleanupConfirmState {
  const copy = STORAGE_CLEANUP_CONFIRM_COPY[input.intent ?? "run"];
  const totalBytes = storageCleanupListedTotal(input.amounts);
  const failure = input.failures.find((reason) => reason.trim().length > 0) ?? null;
  if (input.amounts.length === 0) {
    return {
      title: copy.title,
      description: copy.description,
      confirmLabel: copy.confirmLabel,
      confirmDisabled: true,
      disabledReason: failure ?? STORAGE_CLEANUP_NOTHING_TO_DELETE,
      notice: null,
      totalBytes: 0,
    };
  }
  // One item that cannot be checked must not stop the rest from being cleaned.
  return {
    title: copy.title,
    description: copy.description,
    confirmLabel: copy.confirmLabel,
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

export function retentionDaysCanDeleteMore(previous: number | null, next: number | null): boolean {
  return next !== null && (previous === null || next < previous);
}

function anyWorktreeRuleEnabled(rules: WorktreeCleanupRules): boolean {
  return (
    rules.worktreeAfterDays !== null ||
    rules.worktreeSettledAfterDays !== null ||
    rules.worktreeOnMerge ||
    rules.worktreeOnDelete ||
    rules.worktreeUnchanged
  );
}

export function worktreeRulesCanDeleteMore(
  previous: WorktreeCleanupRules,
  next: WorktreeCleanupRules,
): boolean {
  return (
    (!previous.worktreeOnDelete && next.worktreeOnDelete) ||
    (!previous.worktreeOnMerge && next.worktreeOnMerge) ||
    (!previous.worktreeUnchanged && next.worktreeUnchanged) ||
    retentionDaysCanDeleteMore(previous.worktreeAfterDays, next.worktreeAfterDays) ||
    retentionDaysCanDeleteMore(previous.worktreeSettledAfterDays, next.worktreeSettledAfterDays) ||
    (anyWorktreeRuleEnabled(next) &&
      WORKTREE_KEEP_WHEN_STRICTNESS[next.worktreeKeepWhen] <
        WORKTREE_KEEP_WHEN_STRICTNESS[previous.worktreeKeepWhen])
  );
}

export function cleanupPatchCanDeleteMore(
  previous: ServerSettings,
  patch: ServerSettingsPatch,
): boolean {
  const next = applyServerSettingsPatch(previous, patch);
  if (
    retentionDaysCanDeleteMore(
      previous.storageCleanup.browserArtifactsAfterDays,
      next.storageCleanup.browserArtifactsAfterDays,
    ) ||
    retentionDaysCanDeleteMore(
      previous.storageCleanup.logsAfterDays,
      next.storageCleanup.logsAfterDays,
    ) ||
    worktreeRulesCanDeleteMore(
      resolveWorktreeCleanup(previous, null),
      resolveWorktreeCleanup(next, null),
    )
  ) {
    return true;
  }
  const projectIds = new Set([
    ...Object.keys(previous.projectSettingsOverrides),
    ...Object.keys(next.projectSettingsOverrides),
  ]);
  for (const projectId of projectIds) {
    if (
      worktreeRulesCanDeleteMore(
        resolveWorktreeCleanup(previous, projectId as ProjectId),
        resolveWorktreeCleanup(next, projectId as ProjectId),
      )
    ) {
      return true;
    }
  }
  return false;
}

function worktreeRulesNewlyEnabled(
  previous: WorktreeCleanupRules,
  next: WorktreeCleanupRules,
): boolean {
  return (
    (!previous.worktreeOnDelete && next.worktreeOnDelete) ||
    (!previous.worktreeOnMerge && next.worktreeOnMerge) ||
    (!previous.worktreeUnchanged && next.worktreeUnchanged) ||
    (previous.worktreeAfterDays === null && next.worktreeAfterDays !== null) ||
    (previous.worktreeSettledAfterDays === null && next.worktreeSettledAfterDays !== null)
  );
}

export function storageCleanupChangeIntent(
  previous: ServerSettings,
  patch: ServerSettingsPatch,
): "enable" | "update" {
  const next = applyServerSettingsPatch(previous, patch);
  if (
    (previous.storageCleanup.browserArtifactsAfterDays === null &&
      next.storageCleanup.browserArtifactsAfterDays !== null) ||
    (previous.storageCleanup.logsAfterDays === null &&
      next.storageCleanup.logsAfterDays !== null) ||
    worktreeRulesNewlyEnabled(
      resolveWorktreeCleanup(previous, null),
      resolveWorktreeCleanup(next, null),
    )
  ) {
    return "enable";
  }
  const projectIds = new Set([
    ...Object.keys(previous.projectSettingsOverrides),
    ...Object.keys(next.projectSettingsOverrides),
  ]);
  for (const projectId of projectIds) {
    if (
      worktreeRulesNewlyEnabled(
        resolveWorktreeCleanup(previous, projectId as ProjectId),
        resolveWorktreeCleanup(next, projectId as ProjectId),
      )
    ) {
      return "enable";
    }
  }
  return "update";
}

export type StorageCleanupRuleConfirmDecision =
  | { readonly kind: "apply-immediately" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "blocked"; readonly message: string }
  | {
      readonly kind: "confirm";
      readonly amounts: StorageCleanupAmount[];
      readonly dialog: StorageCleanupConfirmState;
    };

export function decideStorageCleanupRuleConfirm(input: {
  readonly intent: "enable" | "update";
  readonly unsupportedLabels: readonly string[];
  readonly interruptedOnly: boolean;
  readonly previews: readonly {
    readonly environmentLabel: string | null;
    readonly categories: readonly StorageCleanupPreviewCategory[];
  }[];
  readonly failures: readonly string[];
}): StorageCleanupRuleConfirmDecision {
  if (input.unsupportedLabels.length > 0) {
    return {
      kind: "blocked",
      message:
        input.unsupportedLabels.length === 1
          ? "这台电脑的版本还不能在修改前预览将要删除的内容，请先更新。"
          : `以下电脑的版本还不能在修改前预览将要删除的内容，请先更新：${input.unsupportedLabels.join("、")}。`,
    };
  }
  if (input.interruptedOnly && input.failures.length === 0) {
    return { kind: "cancelled" };
  }
  const amounts = storageCleanupAmounts(input.previews);
  if (amounts.length === 0 && input.failures.length === 0) {
    return { kind: "apply-immediately" };
  }
  if (amounts.length === 0) {
    return {
      kind: "blocked",
      message: `无法确认将要删除的内容：${input.failures.join("；")}`,
    };
  }
  return {
    kind: "confirm",
    amounts,
    dialog: storageCleanupConfirmState({
      amounts,
      failures: input.failures,
      intent: input.intent,
    }),
  };
}

export type StorageCleanupSweepFeedback =
  | { readonly kind: "running"; readonly message: string }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export function resolveStorageCleanupSweepFeedback(
  targets: readonly {
    readonly environmentId: string;
    readonly label: string;
    readonly beforeReport: StorageCleanupReport | null;
  }[],
  reportsByEnvironmentId: ReadonlyMap<string, StorageCleanupReport | null>,
): StorageCleanupSweepFeedback {
  const reports = targets.map((target) => ({
    target,
    report: reportsByEnvironmentId.get(target.environmentId) ?? null,
  }));
  if (
    reports.some(
      ({ target, report }) =>
        report === null ||
        report === target.beforeReport ||
        (target.beforeReport !== null &&
          report.startedAt === target.beforeReport.startedAt &&
          report.finishedAt === target.beforeReport.finishedAt),
    )
  ) {
    return { kind: "running", message: "已保存设置，正在清理…" };
  }
  let freed = 0;
  const failures: string[] = [];
  for (const { target, report } of reports) {
    if (report === null) continue;
    freed += report.bytesFreed;
    const entryFailure = report.entries.find((entry) => entry.outcome === "failed");
    if (entryFailure) {
      failures.push(
        targets.length > 1 ? `${target.label}：${entryFailure.reason}` : entryFailure.reason,
      );
    }
  }
  return failures.length > 0
    ? { kind: "failed", message: storageCleanupFailureMessage(freed, failures.join("；")) }
    : { kind: "done", message: storageCleanupFreedMessage(freed) };
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
