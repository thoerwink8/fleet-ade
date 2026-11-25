export type StopPhase = "pending" | "timedOut" | "landed" | null;

/**
 * What the Stop button says. A stop that has not landed after the wait is the
 * one case the button itself has to explain: the provider's own "no response"
 * line arrives later, and only when the provider reports it.
 */
export function stopButtonName(phase: StopPhase): string {
  switch (phase) {
    case "pending":
      return "正在停止";
    case "timedOut":
      return "还没停下，可以再点一次";
    case "landed":
    case null:
      return "停止";
  }
}

export function stopButtonTooltip(phase: StopPhase): string {
  return phase === "pending" ? "正在停止…" : stopButtonName(phase);
}
