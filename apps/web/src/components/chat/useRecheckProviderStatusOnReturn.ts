import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** Focus changes fire in bursts; one re-check is enough inside this window. */
export const PROVIDER_RECHECK_MIN_GAP_MS = 5_000;

/**
 * While an agent is shown as not installed or signed out, checks it again when the page is
 * opened or the user comes back to the window, so a sign-in finished in a terminal or the
 * settings page does not leave a stale notice behind.
 */
export function useRecheckProviderStatusOnReturn(input: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly enabled: boolean;
}) {
  const { environmentId, instanceId, enabled } = input;
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "重新检查智能体状态",
    reportFailure: false,
  });
  const refreshStable = useStableCallback(refreshProviders);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window focus and visibility, which React does not own
  useEffect(() => {
    if (!enabled || environmentId === null || instanceId === null) return;
    let lastCheckAt = Number.NEGATIVE_INFINITY;
    const check = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastCheckAt < PROVIDER_RECHECK_MIN_GAP_MS) return;
      lastCheckAt = now;
      void refreshStable({ environmentId, input: { instanceId } });
    };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [enabled, environmentId, instanceId, refreshStable]);
}
