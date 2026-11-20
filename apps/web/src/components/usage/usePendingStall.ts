import { useEffect, useState } from "react";

export const QUOTA_STALL_TIMEOUT_MS = 10_000;

/** A read that outlives the stall budget surfaces as a failure with retry, not endless loading. */
export function usePendingStall(pending: boolean, timeoutMs: number) {
  const [stalled, setStalled] = useState(false);
  const [lastPending, setLastPending] = useState(pending);
  if (pending !== lastPending) {
    setLastPending(pending);
    setStalled(false);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- wall-clock deadline for an external query
  useEffect(() => {
    if (!pending || stalled) return;
    const timer = setTimeout(() => setStalled(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [pending, stalled, timeoutMs]);
  return { stalled: pending && stalled, reset: () => setStalled(false) };
}
