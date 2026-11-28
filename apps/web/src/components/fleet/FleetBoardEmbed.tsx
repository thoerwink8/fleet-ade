import type { EnvironmentId, FleetBoardEnsureResult } from "@t3tools/contracts";
import { MonitorOffIcon, PlugZapIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { usePreparedConnection } from "~/state/session";
import {
  ensureFleetBoard,
  mintFleetBoardTicket,
  type FleetBoardConnection,
} from "~/state/fleetBoard";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Button } from "../ui/button";
import {
  fleetBoardEmbedUrl,
  fleetBoardRenewalDelayMs,
  type FleetBoardEmbedTicket,
} from "./FleetBoardEmbed.logic";

type EmbedState =
  | { readonly kind: "connecting" }
  | { readonly kind: "ready"; readonly src: string; readonly ticket: FleetBoardEmbedTicket | null }
  | {
      readonly kind: "unavailable";
      readonly status: Exclude<FleetBoardEnsureResult["status"], "running">;
      readonly detail: string | null;
    }
  | { readonly kind: "unreachable"; readonly message: string | null };

const UNAVAILABLE_TITLES: Record<
  Exclude<FleetBoardEnsureResult["status"], "running">,
  { readonly title: string; readonly icon: ReactNode }
> = {
  "not-installed": {
    title: "看板没装",
    icon: <MonitorOffIcon aria-hidden />,
  },
  "port-taken": {
    title: "看板端口被占用",
    icon: <PlugZapIcon aria-hidden />,
  },
  failed: {
    title: "看板没起来",
    icon: <TriangleAlertIcon aria-hidden />,
  },
};

function FleetBoardStatePage({
  icon,
  title,
  detail,
  onRetry,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <div className="scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <Empty size="compact-prose">
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          {detail !== null ? <EmptyDescription>{detail}</EmptyDescription> : null}
        </EmptyHeader>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          重试
        </Button>
      </Empty>
    </div>
  );
}

async function loadEmbed(
  connection: FleetBoardConnection,
): Promise<Exclude<EmbedState, { readonly kind: "connecting" }>> {
  const ensured = await ensureFleetBoard(connection);
  if ("_tag" in ensured) {
    return { kind: "unreachable", message: null };
  }
  if (ensured.status !== "running") {
    return { kind: "unavailable", status: ensured.status, detail: ensured.detail };
  }
  if (connection.authorization === null) {
    return { kind: "ready", src: "/fleet-board/", ticket: null };
  }
  const minted = await mintFleetBoardTicket(connection);
  if ("_tag" in minted) {
    return { kind: "unreachable", message: null };
  }
  const url = fleetBoardEmbedUrl({
    httpBaseUrl: connection.httpBaseUrl,
    appOrigin: window.location.origin,
    authorization: connection.authorization,
    ticket: minted,
  });
  if (url === null) return { kind: "unreachable", message: null };
  return { kind: "ready", src: url.src, ticket: minted };
}

export function FleetBoardEmbed({
  environmentId,
  machinePicker,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly machinePicker?: ReactNode;
}) {
  const prepared = usePreparedConnection(environmentId);
  const [state, setState] = useState<EmbedState>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);

  const httpBaseUrl = prepared._tag === "Some" ? prepared.value.httpBaseUrl : null;
  const authToken =
    prepared._tag === "Some" ? (prepared.value.httpAuthorization?.token ?? null) : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads and launches the board on the server: a network request lifecycle, not derivable state
  useEffect(() => {
    if (httpBaseUrl === null) return;
    let cancelled = false;
    void loadEmbed({ httpBaseUrl, authorization: authToken }).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A manual retry must launch a fresh ensure even when the connection is unchanged.
  }, [httpBaseUrl, authToken, attempt]);

  const renewTicket = useStableCallback(async () => {
    if (httpBaseUrl === null || authToken === null) return null;
    const minted = await mintFleetBoardTicket({
      httpBaseUrl,
      authorization: authToken,
    });
    if ("_tag" in minted) return null;
    const url = fleetBoardEmbedUrl({
      httpBaseUrl,
      appOrigin: window.location.origin,
      authorization: authToken,
      ticket: minted,
    });
    if (url === null) return null;
    return { src: url.src, ticket: minted };
  });

  const ticketToken = state.kind === "ready" ? (state.ticket?.token ?? null) : null;
  const ticketExpiresAt = state.kind === "ready" ? (state.ticket?.expiresAtEpochMs ?? null) : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the iframe's ticket expires on a wall-clock timer; re-minting is synchronization with the server clock, not derived state
  useEffect(() => {
    if (ticketToken === null || ticketExpiresAt === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = async () => {
      if (cancelled) return;
      const next = await renewTicket();
      if (cancelled) return;
      if (next !== null) {
        setState({ kind: "ready", src: next.src, ticket: next.ticket });
        return;
      }
      // Minting failed; the embedded copy dies at expiry, so retry sooner rather than later.
      timer = setTimeout(renew, 30_000);
    };
    timer = setTimeout(
      renew,
      fleetBoardRenewalDelayMs({ expiresAtEpochMs: ticketExpiresAt, nowEpochMs: Date.now() }),
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ticketToken, ticketExpiresAt, renewTicket]);

  const retry = useStableCallback(() => setAttempt((count) => count + 1));

  if (state.kind === "ready") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {machinePicker !== undefined ? (
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-2 text-xs text-muted-foreground">
            {machinePicker}
          </div>
        ) : null}
        {/* The board is the environment's own trusted UI; its relative API and localStorage need a real origin. */}
        {/* oxlint-disable-next-line react/iframe-missing-sandbox -- Sandboxing this first-party board would disable its API origin and stored view settings. */}
        <iframe
          key={state.src}
          src={state.src}
          title="机群看板"
          className="min-h-0 w-full min-w-0 flex-1 border-0"
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {machinePicker !== undefined ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-2 text-xs text-muted-foreground">
          {machinePicker}
        </div>
      ) : null}
      {state.kind === "connecting" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <Empty size="compact-prose">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WrenchIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>正在打开看板</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </div>
      ) : state.kind === "unavailable" ? (
        <FleetBoardStatePage
          icon={UNAVAILABLE_TITLES[state.status].icon}
          title={UNAVAILABLE_TITLES[state.status].title}
          detail={state.detail}
          onRetry={retry}
        />
      ) : (
        <FleetBoardStatePage
          icon={<PlugZapIcon aria-hidden />}
          title="连不上这台电脑"
          detail="电脑不在线或没登录时打不开它的看板，连上后重试"
          onRetry={retry}
        />
      )}
    </div>
  );
}
