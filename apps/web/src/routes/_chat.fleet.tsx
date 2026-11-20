import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { FLEET_BOARD_STATUSES, type FleetBoardStatus } from "../components/fleet/FleetBoard.logic";
import { FleetBoardPage, type FleetSearch } from "../components/fleet/FleetBoardPage";

const VALID_STATUSES: ReadonlySet<string> = new Set(FLEET_BOARD_STATUSES);

export const Route = createFileRoute("/_chat/fleet")({
  validateSearch: (raw: Record<string, unknown>): FleetSearch => ({
    // Invalid values must be undefined, not omitted: the route merges raw search
    // with this output, so an omitted key would leak the raw one through.
    q: typeof raw.q === "string" && raw.q ? raw.q.slice(0, 200) : undefined,
    machine:
      typeof raw.machine === "string" && raw.machine ? (raw.machine as EnvironmentId) : undefined,
    repo: typeof raw.repo === "string" && raw.repo ? raw.repo.slice(0, 200) : undefined,
    status:
      typeof raw.status === "string" && VALID_STATUSES.has(raw.status)
        ? (raw.status as FleetBoardStatus)
        : undefined,
    source:
      typeof raw.source === "string" && raw.source ? (raw.source as EnvironmentId) : undefined,
    row: typeof raw.row === "string" && raw.row ? raw.row.slice(0, 512) : undefined,
  }),
  component: FleetBoardPage,
});
