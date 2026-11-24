import { readLocalApi } from "~/localApi";

let pendingConfirmations = 0;

export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

/** `running` is null when it is not known; an unknown terminal is asked about. */
export interface TerminalCloseTarget {
  readonly label: string;
  readonly running: boolean | null;
}

function quoted(labels: readonly string[]): string {
  return labels.map((label) => `“${label}”`).join("、");
}

export async function confirmTerminalClose(
  terminals: readonly TerminalCloseTarget[],
): Promise<boolean> {
  const busy = terminals.filter((terminal) => terminal.running !== false);
  if (busy.length === 0) return true;
  const localApi = readLocalApi();
  if (!localApi) return true;
  const known = busy.every((terminal) => terminal.running === true);
  const only = terminals.length === 1;
  const pronoun = busy.length === 1 ? "它" : "它们";
  const scope = only ? "里面" : "其中";
  const description = known
    ? `${scope}还在运行 ${quoted(busy.map((terminal) => terminal.label))}，关掉会终止${pronoun}，终端里的历史输出也会清除。`
    : `${scope}可能还有程序在运行，关掉会终止${pronoun}，终端里的历史输出也会清除。`;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(description, {
      title: only ? "关闭这个终端？" : `关闭 ${terminals.length} 个终端？`,
      confirmLabel: "终止并关闭",
      variant: "destructive",
    });
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
