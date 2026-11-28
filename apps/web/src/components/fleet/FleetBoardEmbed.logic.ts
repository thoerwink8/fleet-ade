import type { FleetBoardEnsureResult } from "@t3tools/contracts";
import { FLEET_BOARD_ROUTE_PREFIX } from "@t3tools/contracts";

/** Tickets mint with the server's five-minute TTL; renewal must land ahead of it. */
export const FLEET_BOARD_TICKET_TTL_MS = 5 * 60_000;
export const FLEET_BOARD_TICKET_RENEWAL_LEAD_MS = 60_000;

export type FleetBoardEmbedTicket = {
  readonly token: string;
  readonly expiresAtEpochMs: number;
};

export type FleetBoardEmbedUrl =
  | {
      /** Cookie-authenticated connections: the app's own origin proxies the board. */
      readonly kind: "cookie";
      readonly src: string;
    }
  | {
      /** Token-authenticated connections: the iframe targets the environment directly. */
      readonly kind: "ticket";
      readonly src: string;
    };

export type FleetBoardEmbedInput = {
  readonly httpBaseUrl: string;
  readonly appOrigin: string;
  /** Null when this connection authenticates with ambient browser cookies. */
  readonly authorization: string | null;
  readonly ticket?: FleetBoardEmbedTicket | null | undefined;
};

/**
 * Same-origin embeds ride the browser session cookies, so they need no ticket at all.
 * A bearer connection cannot attach its token to an iframe, so the ticket travels in
 * the path; without one there is no URL a browser would authenticate.
 */
export function fleetBoardEmbedUrl(input: FleetBoardEmbedInput): FleetBoardEmbedUrl | null {
  if (input.authorization === null) {
    return { kind: "cookie", src: `${FLEET_BOARD_ROUTE_PREFIX}/` };
  }
  if (input.ticket === undefined || input.ticket === null) return null;
  const base = input.httpBaseUrl.endsWith("/") ? input.httpBaseUrl : `${input.httpBaseUrl}/`;
  return {
    kind: "ticket",
    src: `${base}${FLEET_BOARD_ROUTE_PREFIX.slice(1)}/t/${input.ticket.token}/`,
  };
}

/** How long after minting the parent re-points the iframe at a fresh ticket. */
export function fleetBoardRenewalDelayMs(input: {
  readonly expiresAtEpochMs: number;
  readonly nowEpochMs: number;
}): number {
  return Math.max(
    0,
    input.expiresAtEpochMs - FLEET_BOARD_TICKET_RENEWAL_LEAD_MS - input.nowEpochMs,
  );
}

export type FleetBoardEmbedResolution =
  | { readonly kind: "ready"; readonly src: string }
  | { readonly kind: "needs-ticket" }
  | {
      readonly kind: "unavailable";
      readonly status: Exclude<FleetBoardEnsureResult["status"], "running">;
      readonly detail: string | null;
    };

/**
 * The server-reported ensure status is the only driver of the three state pages;
 * nothing here invents a reason of its own.
 */
export function resolveFleetBoardEmbed(
  ensure: FleetBoardEnsureResult,
  connection: Omit<FleetBoardEmbedInput, "ticket">,
): FleetBoardEmbedResolution {
  if (ensure.status !== "running") {
    return { kind: "unavailable", status: ensure.status, detail: ensure.detail };
  }
  const url = fleetBoardEmbedUrl(connection);
  if (url === null) return { kind: "needs-ticket" };
  return { kind: "ready", src: url.src };
}
