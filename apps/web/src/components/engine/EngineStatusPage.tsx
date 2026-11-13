import { useAtomValue } from "@effect/atom-react";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import type { EnvironmentId, FleetEngineStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { parseTimestampDate } from "../../timestampFormat";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";

const REQUEST_TIMEOUT_MS = 15_000;

const engineStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(
      Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
        registry.run(
          environmentId,
          executeConnectedEnvironmentHttpRequest({
            group: "fleetEngine",
            method: "GET",
            url: (urls) => urls.status(),
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.status({ headers }),
          }),
        ),
      ),
    )
    .pipe(
      Atom.swr({ staleTime: 60_000, revalidateOnMount: true }),
      Atom.withLabel(`fleet-engine-status:${environmentId}`),
    ),
);

function formatCheckedAt(iso: string): string {
  const date = parseTimestampDate(iso);
  if (date === null) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function formatBody(body: unknown): string {
  if (typeof body === "string") return body;
  return JSON.stringify(body, null, 2) ?? "";
}

function outcomeLabel(status: FleetEngineStatus): string {
  if (!status.configured) return "没配置";
  if (!status.reachable) return "连不上";
  if (status.httpStatus !== null && (status.httpStatus < 200 || status.httpStatus >= 300)) {
    return "已连上，上游返回了错误状态";
  }
  return "已连上";
}

function StatusFields({ status }: { status: FleetEngineStatus }) {
  return (
    <dl className="grid min-w-0 gap-4 text-sm">
      <div className="min-w-0">
        <dt className="text-muted-foreground">结果</dt>
        <dd className="mt-1 font-medium">{outcomeLabel(status)}</dd>
      </div>
      {status.reason !== null ? (
        <div className="min-w-0">
          <dt className="text-muted-foreground">原因</dt>
          <dd className="mt-1 break-all">{status.reason}</dd>
        </div>
      ) : null}
      <div className="min-w-0">
        <dt className="text-muted-foreground">状态码</dt>
        <dd className="mt-1">{status.httpStatus === null ? "无" : status.httpStatus}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-muted-foreground">检查时间</dt>
        <dd className="mt-1 break-all">{formatCheckedAt(status.checkedAt)}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-muted-foreground">响应</dt>
        <dd className="mt-1">
          {status.body === null ? (
            <span className="text-muted-foreground">（空）</span>
          ) : (
            <pre className="max-w-full overflow-x-hidden whitespace-pre-wrap break-all rounded-md border bg-muted p-3 font-mono text-xs">
              {formatBody(status.body)}
            </pre>
          )}
        </dd>
      </div>
    </dl>
  );
}

function EngineStatusFrame({
  pending,
  refreshDisabled,
  onRefresh,
  children,
}: {
  pending: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
  children: ReactNode;
}) {
  return (
    <AppRouteModal label="引擎状态">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">引擎状态</h1>
          <Button variant="outline" size="sm" disabled={refreshDisabled} onClick={onRefresh}>
            <RefreshIcon refreshing={pending} />
            刷新
          </Button>
          <AppRouteModalClose />
        </header>
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <WorkspacePageContainer>{children}</WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AppRouteModal>
  );
}

function EngineStatusConnected({ environmentId }: { environmentId: EnvironmentId }) {
  const result = useAtomValue(engineStatusAtom(environmentId));
  const refresh = () => {
    appAtomRegistry.refresh(engineStatusAtom(environmentId));
  };

  let failure: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    const message = cause instanceof Error ? cause.message : "读不到接口";
    failure = message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "").trim() || "读不到接口";
  }
  const status = result._tag === "Success" ? result.value : null;

  return (
    <EngineStatusFrame
      pending={result.waiting}
      refreshDisabled={result.waiting}
      onRefresh={refresh}
    >
      {failure !== null ? (
        <p className="text-sm break-all">读不到这台环境的接口。{failure}</p>
      ) : status === null ? (
        <p className="text-sm text-muted-foreground">正在读取。</p>
      ) : (
        <StatusFields status={status} />
      )}
    </EngineStatusFrame>
  );
}

export function EngineStatusPage() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <EngineStatusFrame pending={false} refreshDisabled onRefresh={() => {}}>
        <p className="text-sm text-muted-foreground">还没有连上的环境。</p>
      </EngineStatusFrame>
    );
  }
  return <EngineStatusConnected environmentId={environmentId} />;
}
