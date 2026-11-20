import type { FleetSummaryRow } from "@t3tools/contracts";

export type FleetBoardFilter = {
  readonly status?: "needsYou" | "stuck" | "working" | "done";
  readonly machine?: string;
  readonly repo?: string;
  readonly search?: string;
};

export function fleetMachineName(
  id: string,
  linked: ReadonlyMap<string, string>,
  directory: ReadonlyMap<string, string>,
): string {
  return linked.get(id) || directory.get(id) || "未命名机器";
}

export function defaultFleetSource(
  primary: string | null,
  readable: readonly string[],
): string | null {
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
        : (reason.split(/\r?\n/, 1)[0] ?? "").slice(0, 80);
  }
}

export function fleetStaleReason(reason: string | undefined): string | null {
  if (reason === "environment offline") return null;
  if (reason === "lease lost") return "卡住 · 这台机器已不在做这单";
  return "卡住 · 信息可能过时";
}

export function fleetStatusAge(updatedAt: string, now: number): string {
  return `状态截至 ${Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 60_000))} 分钟前`;
}

export function filterFleetRows(
  rows: readonly FleetSummaryRow[],
  filter: FleetBoardFilter,
): FleetSummaryRow[] {
  const query = filter.search?.trim().toLocaleLowerCase().replace(/^#/, "") ?? "";
  return rows.filter(
    (row) =>
      (filter.status === undefined ||
        (filter.status === "needsYou" ? row.needsYou : row.phase === filter.status)) &&
      (filter.machine === undefined || row.environmentId === filter.machine) &&
      (filter.repo === undefined || row.repo === filter.repo) &&
      (query === "" ||
        row.title.toLocaleLowerCase().includes(query) ||
        String(row.issue ?? "").includes(query)),
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
      const counts = { needsYou: 0, stuck: 0, working: 0, done: 0, offline: 0 };
      for (const row of entries) {
        counts[row.phase]++;
        if (row.needsYou) counts.needsYou++;
        if (row.staleReason === "environment offline") counts.offline++;
      }
      return { environmentId, name: name(environmentId), rows: entries, counts };
    })
    .sort(
      (a, b) =>
        Number(b.counts.needsYou > 0) - Number(a.counts.needsYou > 0) ||
        Number(b.counts.offline > 0) - Number(a.counts.offline > 0) ||
        a.name.localeCompare(b.name),
    );
}
