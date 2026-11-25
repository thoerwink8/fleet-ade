import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Fragment, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ChevronDownIcon, ChevronUpIcon, CircleAlertIcon, XIcon } from "lucide-react";
import type { FleetEngineFailure } from "../../state/fleetEngine";
import type { AlternativeReadyAgent } from "./providerErrorClassification";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  dismissProviderStatusBannerForSession,
  getProviderStatusBannerKey,
  getProviderStatusBannerVariant,
  ProviderStatusBanner,
} from "./ProviderStatusBanner";
import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerVariant,
  ThreadErrorBanner,
} from "./ThreadErrorBanner";
import {
  createChatBannerAppearance,
  orderChatBannerItems,
  registerChatBannerAppearance,
  visibleChatBannerItems,
  type ChatBannerSeverity,
} from "./ChatBannerLane.logic";

interface LaneItem {
  readonly id: string;
  readonly severity: ChatBannerSeverity;
  readonly node: ReactNode;
}

/**
 * Status strips in the composer column, directly above the input. The dismiss handlers are
 * built here from plain values, so a ChatView render that changes neither banner leaves both
 * cached. Only the highest-priority strip is expanded; the rest collapse into a summary row.
 */
export function ChatBannerLane(props: {
  environmentId: EnvironmentId;
  fleetEngineFailure: FleetEngineFailure | null;
  fleetEngineRetrying?: boolean;
  onRetryFleetEngine: () => void;
  onOpenFleetConnectionsSettings: () => void;
  onDismissFleetEngineFailure: () => void;
  providerStatus: ServerProvider | null;
  providerStatusDismissalKey: string | null;
  onOpenProviderSetup: (instanceId?: ProviderInstanceId) => void;
  threadId: ThreadId;
  threadError: string | null;
  threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  threadErrorCode: string | null;
  threadErrorIsAgentError?: boolean;
  threadErrorAgentName?: string | null;
  threadErrorRetryCount?: number | null;
  threadErrorUsageLimitResetAt?: string | null;
  alternativeAgent?: AlternativeReadyAgent | null;
  timestampFormat?: TimestampFormat;
  onSignIn?: () => void;
  onInstallHelp?: () => void;
  onSwitchAgent?: (instanceId: ProviderInstanceId) => void;
  onRetryThreadError?: () => void;
  threadErrorBannerKey: string | null;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
}) {
  const {
    fleetEngineFailure,
    fleetEngineRetrying = false,
    onRetryFleetEngine,
    onOpenFleetConnectionsSettings,
    onDismissFleetEngineFailure,
    providerStatus,
    providerStatusDismissalKey,
    onOpenProviderSetup,
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorIsAgentError,
    threadErrorAgentName,
    threadErrorRetryCount,
    threadErrorUsageLimitResetAt,
    alternativeAgent,
    timestampFormat,
    onSignIn,
    onInstallHelp,
    onSwitchAgent,
    onRetryThreadError,
    threadErrorBannerKey,
    setThreadError,
    setThreadErrorBannerDismissTick,
  } = props;
  const [expanded, setExpanded] = useState(false);

  const items: LaneItem[] = [];
  if (fleetEngineFailure !== null) {
    items.push({
      id: `engine:${fleetEngineFailure.kind}`,
      severity: "error",
      node: (
        <Alert variant="error" controlAlignment="first-line">
          <CircleAlertIcon />
          <AlertTitle>{fleetEngineFailure.title}</AlertTitle>
          <AlertDescription>
            <span>{fleetEngineFailure.description}</span>
            <span className="ade-touch-row ade-touch-row--gap-2 flex flex-wrap items-center gap-2">
              <Button
                disabled={fleetEngineRetrying}
                onClick={onRetryFleetEngine}
                size="sm"
                variant="secondary"
              >
                {fleetEngineRetrying ? "正在重试…" : "重试"}
              </Button>
              <Button onClick={onOpenFleetConnectionsSettings} size="sm" variant="ghost">
                去 设置 → 连接 查看
              </Button>
            </span>
          </AlertDescription>
          <AlertAction>
            <Button
              aria-label="关闭机群服务故障提示"
              onClick={onDismissFleetEngineFailure}
              size="sm"
              icon
              variant="muted"
            >
              <XIcon />
            </Button>
          </AlertAction>
        </Alert>
      ),
    });
  }
  if (providerStatus !== null && getProviderStatusBannerKey(providerStatus) !== null) {
    items.push({
      id: providerStatusDismissalKey ?? providerStatus.instanceId,
      severity: getProviderStatusBannerVariant(providerStatus) === "warning" ? "warning" : "error",
      node: (
        <ProviderStatusBanner
          environmentId={props.environmentId}
          status={providerStatus}
          onDismiss={() => dismissProviderStatusBannerForSession(providerStatusDismissalKey)}
          onOpenProviderSetup={onOpenProviderSetup}
          alternativeAgent={alternativeAgent ?? null}
          {...(onSwitchAgent === undefined ? {} : { onSwitchAgent })}
        />
      ),
    });
  }
  if (threadError !== null) {
    items.push({
      id: threadErrorBannerKey ?? "thread-error",
      severity:
        getThreadErrorBannerVariant(threadErrorClass, threadErrorCode) === "warning"
          ? "warning"
          : "error",
      node: (
        <ThreadErrorBanner
          error={threadError}
          errorClass={threadErrorClass}
          errorCode={threadErrorCode}
          classifyError={threadErrorIsAgentError ?? true}
          agentName={threadErrorAgentName ?? null}
          retryCount={threadErrorRetryCount ?? null}
          usageLimitResetAt={threadErrorUsageLimitResetAt ?? null}
          providerStatus={providerStatus}
          alternativeAgent={alternativeAgent ?? null}
          {...(timestampFormat === undefined ? {} : { timestampFormat })}
          {...(onSignIn === undefined ? {} : { onSignIn })}
          {...(onInstallHelp === undefined ? {} : { onInstallHelp })}
          {...(onSwitchAgent === undefined ? {} : { onSwitchAgent })}
          {...(onRetryThreadError === undefined ? {} : { onRetry: onRetryThreadError })}
          onDismiss={() => {
            setThreadError(threadId, null);
            dismissThreadErrorBannerForSession(threadErrorBannerKey);
            setThreadErrorBannerDismissTick((tick) => tick + 1);
          }}
        />
      ),
    });
  }

  // First-appearance order feeds "newest first" within a severity. A render-phase update is
  // the sanctioned way to derive this from the current banner ids.
  const [appearance, setAppearance] = useState(() =>
    createChatBannerAppearance(items.map((item) => item.id)),
  );
  const nextAppearance = registerChatBannerAppearance(
    appearance,
    items.map((item) => item.id),
  );
  if (nextAppearance !== appearance) setAppearance(nextAppearance);

  if (items.length === 0) return null;
  const ordered = orderChatBannerItems(
    items.map((item) => ({ ...item, appearedAt: appearance.order.get(item.id) ?? 0 })),
  );
  const { visible, hiddenCount } = visibleChatBannerItems(ordered, expanded);

  return (
    <div className="fa-strips mb-2 w-full" data-slot="chat-banner-lane">
      {visible.map((item) => (
        <Fragment key={item.id}>{item.node}</Fragment>
      ))}
      {ordered.length > 1 ? (
        <button
          type="button"
          className="fa-strip__sum"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronUpIcon className="fa-ic" aria-hidden />
          ) : (
            <ChevronDownIcon className="fa-ic" aria-hidden />
          )}
          <span>{expanded ? "收起" : `还有 ${hiddenCount} 条`}</span>
        </button>
      ) : null}
    </div>
  );
}
