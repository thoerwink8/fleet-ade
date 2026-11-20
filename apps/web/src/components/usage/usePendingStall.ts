import { useEffect, useState } from "react";

export const QUOTA_STALL_TIMEOUT_MS = 10_000;

/** A read that outlives the stall budget surfaces as a failure with retry, not endless loading. */
export function usePendingStall(pending: boolean, timeoutMs: number) {
  const [stalled, setStalled] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [wasPending, setWasPending] = useState(pending);
  if (pending !== wasPending) {
    setWasPending(pending);
    if (stalled) setStalled(false);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- wall-clock deadline for an external query
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setStalled(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A retry bumps the epoch so a still-pending read restarts its deadline.
    epoch,
    pending,
    timeoutMs,
  ]);
  return {
    stalled: pending && stalled,
    reset: () => {
      setStalled(false);
      setEpoch((value) => value + 1);
    },
  };
}
