import type { OrchestrationV2Run } from "@t3tools/contracts";

/** A held queue (after a stop or a rewind) sends nothing by itself; the user sends or removes each message. */
export const QUEUED_RUN_HELD_LABEL = "已暂停，不会自动发送";

export function queuedRunHeldLabel(
  run: Pick<OrchestrationV2Run, "queueHeld"> | null,
): string | null {
  return run?.queueHeld === true ? QUEUED_RUN_HELD_LABEL : null;
}
