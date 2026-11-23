import { useAtomValue } from "@effect/atom-react";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { AuthRelayReadScope, AuthRelayWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { toastManager } from "../components/ui/toast";
import { stackedThreadToast } from "../components/ui/toastHelpers";
import { relayFailureReason } from "./relayFailureReason";
import { relayEnvironmentDiscovery } from "../state/relay";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { isCloudEnvironmentLinkError } from "./linkEnvironment";
import { unlinkEnvironment as unlinkEnvironmentAtom } from "./linkEnvironmentAtoms";
import { readCachedCloudLinkState, useCloudLinkState } from "./cloudLinkState";
import { isManagedTunnelActive } from "./t3ConnectState";

export interface CloudLinkDesiredState {
  readonly managedTunnel: boolean;
  readonly publish: boolean;
  readonly holdWebhooksWhileOffline?: boolean;
}

const isManagedRelayClientError = Schema.is(ManagedRelay.ManagedRelayClientError);

export function useCloudLinkController(environmentId: EnvironmentId | null) {
  const isSignedIn = false;
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const unlinkEnvironment = useAtomCommand(unlinkEnvironmentAtom, {
    reportFailure: false,
  });
  const cloudLinkState = useCloudLinkState(environmentId);
  const relayEnvironments = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments;
  const relayProviderKind = environmentId
    ? relayEnvironments.get(environmentId)?.environment.endpoint.providerKind
    : undefined;
  const [operationError, setOperationError] = useState<string | null>(null);
  const [tunnelLimit, setTunnelLimit] = useState<number | null>(null);

  const reportUpdateFailure = (cause: unknown, reason?: string) => {
    const message = cause instanceof Error ? cause.message : "无法更新 T3 Connect 访问权限。";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not update T3 Connect", { message, traceId, cause });
    setOperationError(traceId ? `${message} Trace ID: ${traceId}` : message);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "无法更新 T3 Connect",
        description: reason ?? relayFailureReason(cause) ?? message,
        ...(traceId
          ? {
              actionProps: {
                children: "复制追踪 ID",
                onClick: () => void navigator.clipboard?.writeText(traceId),
              },
              actionVariant: "outline",
            }
          : {}),
        data: { hideCopyButton: true },
      }),
    );
  };

  const linkData = cloudLinkState.data;
  const linkRevoked = linkData?.linkRevoked ?? false;
  const managedTunnelActive = linkData ? isManagedTunnelActive(linkData, relayProviderKind) : false;
  const managedTunnelOutOfSync =
    linkData !== null && !managedTunnelActive && isManagedTunnelActive(linkData, undefined);
  const publishAgentActivity = cloudLinkState.data?.publishAgentActivity ?? false;
  const holdWebhooksWhileOffline = cloudLinkState.data?.holdWebhooksWhileOffline ?? false;
  const linked = !linkRevoked && (cloudLinkState.data?.linked ?? false);

  const reconcileCloudState = async (desired: CloudLinkDesiredState): Promise<boolean> => {
    setOperationError(null);
    setTunnelLimit(null);
    const target = cloudLinkState.target;
    if (!target) {
      reportUpdateFailure(new Error("Choose an environment first."));
      return false;
    }
    const environmentId = target.environmentId;
    const canManageLink = () => {
      if (
        !readEnvironmentScope(environmentId, AuthRelayReadScope) ||
        !readEnvironmentScope(environmentId, AuthRelayWriteScope)
      ) {
        reportUpdateFailure(
          new Error("This connection needs permission to view and manage T3 Connect settings."),
        );
        return false;
      }
      return true;
    };
    const readLinkState = () => {
      const state = readCachedCloudLinkState(target);
      if (state === null) {
        reportUpdateFailure(new Error("Wait until the current T3 Connect settings can be read."));
      }
      return state;
    };
    if (!canManageLink()) return false;
    const wantsLink = desired.managedTunnel || desired.publish;
    if (wantsLink && readLinkState() === null) return false;
    const clerkToken: string | null = null;
    if (!canManageLink()) return false;

    // A failed mutation may have partially applied, so refresh server state on every exit.
    if (!wantsLink) {
      // Unlink needs no relay token; failed token reads must still allow it.
      const unlinkResult = await unlinkEnvironment({
        target,
        clerkToken,
      });
      if (unlinkResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(unlinkResult)) {
          const cause = squashAtomCommandFailure(unlinkResult);
          // Only the relay delete fails with a relay error, and it runs after the local unlink.
          const relayKeptLink =
            isCloudEnvironmentLinkError(cause) && isManagedRelayClientError(cause.cause);
          reportUpdateFailure(
            cause,
            relayKeptLink ? "已在此断开，但 T3 Connect 仍列出此环境。请到账户中移除。" : undefined,
          );
        }
        cloudLinkState.refresh();
        await refreshRelayEnvironments();
        return false;
      }
    } else {
      reportUpdateFailure(new Error("T3 Connect sign-in is no longer available."));
      return false;
    }

    cloudLinkState.refresh();
    const refreshResult = await refreshRelayEnvironments();
    if (refreshResult._tag === "Failure" && !isAtomCommandInterrupted(refreshResult)) {
      reportUpdateFailure(squashAtomCommandFailure(refreshResult));
      return false;
    }
    return true;
  };

  return {
    isSignedIn,
    linkState: cloudLinkState,
    linked,
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    tunnelLimit,
    reconcileCloudState,
  };
}
