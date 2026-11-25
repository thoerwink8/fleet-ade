import { useSyncExternalStore } from "react";

export interface PendingDraftWorkFailure {
  readonly sequence: number;
  readonly reason: string;
}

// Count per draft so overlapping pastes cannot release each other and strand chips.
class PendingDraftWork {
  private readonly counts = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly failures = new Map<string, PendingDraftWorkFailure>();
  private failureSequence = 0;

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  begin(draftKey: string): void {
    this.counts.set(draftKey, (this.counts.get(draftKey) ?? 0) + 1);
    this.notify();
  }

  end(draftKey: string): void {
    const remaining = (this.counts.get(draftKey) ?? 0) - 1;
    if (remaining > 0) this.counts.set(draftKey, remaining);
    else this.counts.delete(draftKey);
    this.notify();
  }

  has(draftKey: string): boolean {
    return (this.counts.get(draftKey) ?? 0) > 0;
  }

  fail(draftKey: string, reason: string): void {
    this.failures.set(draftKey, { sequence: ++this.failureSequence, reason });
    this.notify();
  }

  lastFailure(draftKey: string): PendingDraftWorkFailure | null {
    return this.failures.get(draftKey) ?? null;
  }

  whenIdle(draftKey: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (!this.has(draftKey)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const cleanup = () => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      };
      const unsubscribe = this.subscribe(() => {
        if (settled || this.has(draftKey)) return;
        settled = true;
        cleanup();
        resolve(true);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!this.has(draftKey) && !settled) {
        settled = true;
        cleanup();
        resolve(true);
      }
    });
  }
}

// Keep claims across composer remounts.
export const pendingDraftWork = new PendingDraftWork();

export function useHasPendingDraftWork(draftKey: string): boolean {
  return useSyncExternalStore(pendingDraftWork.subscribe, () => pendingDraftWork.has(draftKey));
}

export function usePendingDraftWorkFailure(draftKey: string): PendingDraftWorkFailure | null {
  return useSyncExternalStore(pendingDraftWork.subscribe, () =>
    pendingDraftWork.lastFailure(draftKey),
  );
}
