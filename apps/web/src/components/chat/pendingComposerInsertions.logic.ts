export type ComposerInsertionBlock =
  | { readonly kind: "transient" }
  | { readonly kind: "hard"; readonly reason: string };

export function classifyComposerInsertionBlock(input: {
  readonly projectSelectionRequired: boolean;
  readonly activePendingIsResponding: boolean;
  readonly pendingUserInputCount: number;
  readonly hasActiveQuestion: boolean;
  readonly choiceOnlyQuestion: boolean;
  readonly canOperateThread: boolean;
  readonly requireOperate?: boolean;
}): ComposerInsertionBlock | null {
  if (input.projectSelectionRequired) {
    return { kind: "hard", reason: "请先在上方选择项目，再添加到输入框。" };
  }
  if (input.requireOperate === true && !input.canOperateThread) {
    return { kind: "hard", reason: "此连接无法修改会话。" };
  }
  if (input.choiceOnlyQuestion) {
    return { kind: "hard", reason: "当前问题只能选择选项，先回答或关闭问题后再添加。" };
  }
  if (input.activePendingIsResponding) {
    return { kind: "transient" };
  }
  if (input.pendingUserInputCount > 0 && !input.hasActiveQuestion) {
    return { kind: "transient" };
  }
  return null;
}

export class PendingComposerInsertionQueue<T> {
  private entries: Array<{ readonly targetKey: string; readonly item: T }> = [];

  enqueue(targetKey: string, item: T): void {
    this.entries.push({ targetKey, item });
  }

  hasForTarget(targetKey: string): boolean {
    return this.entries.some((entry) => entry.targetKey === targetKey);
  }

  takeForTarget(targetKey: string): ReadonlyArray<T> {
    const taken: T[] = [];
    const remaining: Array<{ readonly targetKey: string; readonly item: T }> = [];
    for (const entry of this.entries) {
      if (entry.targetKey === targetKey) taken.push(entry.item);
      else remaining.push(entry);
    }
    this.entries = remaining;
    return taken;
  }

  clearExcept(activeTargetKey: string): void {
    this.entries = this.entries.filter((entry) => entry.targetKey === activeTargetKey);
  }
}
