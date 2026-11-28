import { FLEET_BOARD_ENSURE_PATH, FleetBoardEnsureResult } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export type FleetBoardConnection = {
  readonly httpBaseUrl: string;
  /** Null when this connection authenticates with ambient browser cookies. */
  readonly authorization: string | null;
};

export type FleetBoardRequestFailure =
  | { readonly _tag: "network"; readonly message: string }
  | { readonly _tag: "http"; readonly status: number }
  | { readonly _tag: "decode" };

const REQUEST_TIMEOUT_MS = 15_000;
// A failed launch is reported only after the server's 25-second health-check deadline.
const ENSURE_TIMEOUT_MS = 35_000;

const decodeEnsureResult = Schema.decodeUnknownSync(FleetBoardEnsureResult);
const decodeTicketResult = Schema.decodeUnknownSync(
  Schema.Struct({
    ticket: Schema.RedactedFromValue(Schema.String),
    expiresAt: Schema.DateTimeUtcFromString,
  }),
);

function fleetBoardEndpoint(connection: FleetBoardConnection, path: string): string {
  const base = connection.httpBaseUrl.endsWith("/")
    ? connection.httpBaseUrl
    : `${connection.httpBaseUrl}/`;
  return `${base}${path.slice(1)}`;
}

function requestInit(connection: FleetBoardConnection): RequestInit {
  return connection.authorization === null
    ? { credentials: "include" }
    : { headers: { authorization: `Bearer ${connection.authorization}` } };
}

async function postForJson(
  connection: FleetBoardConnection,
  path: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ readonly response: Response; readonly body: unknown } | FleetBoardRequestFailure> {
  let response: Response;
  try {
    response = await fetch(fleetBoardEndpoint(connection, path), {
      ...requestInit(connection),
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      _tag: "network",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!response.ok) return { _tag: "http", status: response.status };
  try {
    return { response, body: await response.json() };
  } catch {
    return { _tag: "decode" };
  }
}

/**
 * Probes the board on the connection's environment, launching it when needed.
 * `AuthWebSocketTicketResult`'s redacted wire shape decodes back into a redacted
 * string, so tickets never sit in logs or component state as plain fields.
 */
async function requestFleetBoardEnsure(
  connection: FleetBoardConnection,
): Promise<FleetBoardEnsureResult | FleetBoardRequestFailure> {
  const result = await postForJson(connection, FLEET_BOARD_ENSURE_PATH, ENSURE_TIMEOUT_MS);
  if ("_tag" in result) return result;
  try {
    return decodeEnsureResult(result.body);
  } catch {
    return { _tag: "decode" };
  }
}

const ensureInFlight = new Map<
  string,
  Promise<FleetBoardEnsureResult | FleetBoardRequestFailure>
>();

/** Development StrictMode and two fleet pages must not queue two 25-second launch probes. */
export function ensureFleetBoard(
  connection: FleetBoardConnection,
): Promise<FleetBoardEnsureResult | FleetBoardRequestFailure> {
  const key = `${connection.httpBaseUrl} ${connection.authorization ?? ""}`;
  const existing = ensureInFlight.get(key);
  if (existing !== undefined) return existing;
  const pending = requestFleetBoardEnsure(connection).finally(() => {
    ensureInFlight.delete(key);
  });
  ensureInFlight.set(key, pending);
  return pending;
}

export async function mintFleetBoardTicket(
  connection: FleetBoardConnection,
): Promise<
  { readonly token: string; readonly expiresAtEpochMs: number } | FleetBoardRequestFailure
> {
  const result = await postForJson(connection, "/api/auth/websocket-ticket/fleet-board");
  if ("_tag" in result) return result;
  try {
    const decoded = decodeTicketResult(result.body);
    return {
      token: Redacted.value(decoded.ticket),
      expiresAtEpochMs: decoded.expiresAt.epochMilliseconds,
    };
  } catch {
    return { _tag: "decode" };
  }
}
