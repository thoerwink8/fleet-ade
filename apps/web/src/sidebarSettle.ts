import type { ScopedThreadRef } from "@t3tools/contracts";

type SidebarSettleHandler = (threadRef: ScopedThreadRef) => void;

let registeredSidebarSettle: SidebarSettleHandler | null = null;

export function registerSidebarSettle(handler: SidebarSettleHandler): () => void {
  registeredSidebarSettle = handler;
  return () => {
    if (registeredSidebarSettle === handler) registeredSidebarSettle = null;
  };
}

/** False means no sidebar is mounted; settle directly instead. */
export function settleSidebarThread(threadRef: ScopedThreadRef): boolean {
  if (!registeredSidebarSettle) return false;
  registeredSidebarSettle(threadRef);
  return true;
}
