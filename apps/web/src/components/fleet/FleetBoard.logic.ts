import type { FleetSummaryRow } from "@t3tools/contracts";

export const FLEET_BOARD_STATUSES = ["needsYou", "stuck", "working", "done"] as const;
export type FleetBoardStatus = (typeof FLEET_BOARD_STATUSES)[number];

export type FleetBoardFilter = {
  readonly status?: "needsYou" | "stuck" | "working" | "done" | undefined;
  readonly statuses?: readonly FleetBoardStatus[] | undefined;
  readonly machine?: string | undefined;
  readonly repo?: string | undefined;
  readonly search?: string | undefined;
};

/**
 * The machine name a row's environmentId reads as: the name the summary source
 * gives it when it reports one (peer link label), else this client's own name
 * for the machine, else a placeholder.
 */
export function fleetMachineName(
  id: string,
  linked: ReadonlyMap<string, string>,
  directory: ReadonlyMap<string, string>,
): string {
  return linked.get(id) || directory.get(id) || "未命名机器";
}

/** The machine to aggregate from: this one when it answers, else the first readable one. */
export function defaultFleetSource<Id extends string>(
  primary: Id | null,
  readable: readonly Id[],
): Id | null {
  return primary ?? readable[0] ?? null;
}

export function fleetReason(reason: string): string {
  switch (reason) {
    case "waiting:command":
      return "等你批准命令";
    case "waiting:file-change":
      return "等你批准改文件";
    case "waiting:user_input":
      return "在等你回答";
    case "waiting:auth_refresh":
      return "要重新登录";
    default:
      return reason.startsWith("waiting:")
        ? "等待处理"
        : (reason.split(/\r?\n/, 1)[0]?.slice(0, 80) ?? "");
  }
}

export function fleetFullReason(reason: string): string {
  return reason.startsWith("waiting:") ? fleetReason(reason) : reason;
}

export function fleetStaleReason(
  row: Pick<FleetSummaryRow, "stale" | "staleReason">,
): string | null {
  if (!row.stale || row.staleReason === "environment offline") return null;
  if (row.staleReason === "lease lost") return "卡住 · 这台机器已不在做这单";
  return "卡住 · 信息可能过时";
}

/** The status age line; only needs-you rows carry the 状态截至 wording (they may be acted on late). */
export function fleetStatusAge(updatedAt: string, now: number, needsYou: boolean): string {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return needsYou ? `状态截至 ${minutes} 分钟前` : `${minutes} 分钟前`;
}

export function isFleetOfflineRow(row: Pick<FleetSummaryRow, "stale" | "staleReason">): boolean {
  return row.stale && row.staleReason === "environment offline";
}

export type FleetStatusCounts = Record<FleetBoardStatus, number> & { offline: number };

export function fleetStatusCounts(rows: readonly FleetSummaryRow[]): FleetStatusCounts {
  const counts: FleetStatusCounts = { needsYou: 0, stuck: 0, working: 0, done: 0, offline: 0 };
  for (const row of rows) {
    if (row.needsYou) counts.needsYou++;
    else counts[row.phase]++;
    if (isFleetOfflineRow(row)) counts.offline++;
  }
  return counts;
}

const matchesStatus = (row: FleetSummaryRow, status: FleetBoardStatus): boolean =>
  status === "needsYou" ? row.needsYou : !row.needsYou && row.phase === status;

export function filterFleetRows(
  rows: readonly FleetSummaryRow[],
  filter: FleetBoardFilter,
): FleetSummaryRow[] {
  const statuses = filter.statuses ?? (filter.status === undefined ? undefined : [filter.status]);
  const raw = filter.search?.trim().toLocaleLowerCase() ?? "";
  // A leading # turns the query into an issue-number lookup; the title is not searched.
  const issueQuery = raw.startsWith("#") ? raw.slice(1) : undefined;
  const query = issueQuery === undefined ? raw : "";
  return rows.filter(
    (row) =>
      (statuses === undefined || statuses.some((status) => matchesStatus(row, status))) &&
      (filter.machine === undefined || row.environmentId === filter.machine) &&
      (filter.repo === undefined || row.repo === filter.repo) &&
      (issueQuery !== undefined
        ? issueQuery === "" || String(row.issue ?? "") === issueQuery
        : query === "" ||
          row.title.toLocaleLowerCase().includes(query) ||
          (/^\d+$/.test(query) && String(row.issue ?? "") === query)),
  );
}

export function groupFleetRows(rows: readonly FleetSummaryRow[], name: (id: string) => string) {
  const groups = new Map<string, FleetSummaryRow[]>();
  for (const row of rows) {
    const group = groups.get(row.environmentId);
    if (group) group.push(row);
    else groups.set(row.environmentId, [row]);
  }
  const rank = (row: FleetSummaryRow) =>
    row.needsYou ? 0 : row.phase === "stuck" ? 1 : row.phase === "working" ? 2 : 3;
  return [...groups]
    .map(([environmentId, entries]) => {
      entries.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
      return {
        environmentId,
        name: name(environmentId),
        rows: entries,
        counts: fleetStatusCounts(entries),
      };
    })
    .sort(
      (a, b) =>
        Number(b.counts.needsYou > 0) - Number(a.counts.needsYou > 0) ||
        Number(b.counts.offline > 0) - Number(a.counts.offline > 0) ||
        a.name.localeCompare(b.name),
    );
}
