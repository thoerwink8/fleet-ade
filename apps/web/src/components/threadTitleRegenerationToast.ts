import type { ThreadTitleRegenerationOutcome } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast } from "./ui/toast";

type TitleRegenerationResult = AtomCommandResult<ThreadTitleRegenerationOutcome | null, unknown>;

function failureMessage(result: TitleRegenerationResult): string | null {
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) return null;
    const error = squashAtomCommandFailure(result);
    return error instanceof Error ? error.message : "发生错误。";
  }
  return result.value?.status === "failed" ? (result.value.message ?? "标题生成失败。") : null;
}

function isKept(result: TitleRegenerationResult): boolean {
  return result._tag === "Success" && result.value?.status === "unchanged";
}

export function titleRegenerationToast(results: ReadonlyArray<TitleRegenerationResult>) {
  const failures = results.flatMap((result) => {
    const message = failureMessage(result);
    return message === null ? [] : [message];
  });
  if (failures.length > 0) {
    return stackedThreadToast({
      type: "error",
      title:
        results.length === 1
          ? "重新生成会话标题失败"
          : `${results.length} 个会话中有 ${failures.length} 个标题重新生成失败`,
      description: failures[0],
    });
  }
  const kept = results.filter(isKept).length;
  if (kept === 0) return null;
  if (results.length === 1) {
    return stackedThreadToast({
      type: "info",
      title: "保留了标题",
      description: "当前标题已经适合这个会话。",
    });
  }
  return stackedThreadToast({
    type: "info",
    title:
      kept === results.length ? "已保留全部标题" : `已保留 ${results.length} 个中的 ${kept} 个标题`,
    description:
      kept === results.length ? "当前标题已经适合这些会话。" : "这些标题已经适合对应会话。",
  });
}
