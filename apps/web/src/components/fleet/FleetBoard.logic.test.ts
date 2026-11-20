import { expect, it } from "vite-plus/test";
import type { FleetSummaryRow } from "@t3tools/contracts";
import {
  filterFleetRows,
  fleetReason,
  fleetStaleReason,
  fleetStatusAge,
  groupFleetRows,
} from "./FleetBoard.logic.ts";

it("groups and filters a thousand rows without confusing issue searches", () => {
  const rows: FleetSummaryRow[] = Array.from({ length: 1000 }, (_, i) => ({
    environmentId: i % 2 ? "b" : "a",
    threadId: String(i),
    repo: "repo",
    issue: i + 1,
    title: `任务 ${String.fromCharCode(65 + (i % 26))}`,
    phase: i === 150 ? "stuck" : "working",
    reason: "",
    needsYou: i === 150,
    lastProgress: "",
    updatedAt: "2026-01-01T00:00:00Z",
    stale: false,
    revision: 1,
  }));
  rows.push({ ...rows[0]!, issue: 1510, title: "别的任务" });
  const groups = groupFleetRows(rows, (id) => id);
  expect(groups[0]?.environmentId).toBe("a");
  expect(groups[0]?.counts.needsYou).toBe(1);
  for (const search of ["151", "#151"]) {
    expect(filterFleetRows(rows, { search }).map((row) => row.issue)).toEqual([151]);
  }
  expect(filterFleetRows(rows, { status: "needsYou", machine: "a", repo: "repo" })[0]?.issue).toBe(
    151,
  );
});

it("formats reasons, ages and machine names", () => {
  expect(fleetReason("waiting:command")).toBe("等你批准命令");
  expect(fleetReason("waiting:file-change")).toBe("等你批准改文件");
  expect(fleetReason("waiting:user_input")).toBe("在等你回答");
  expect(fleetReason("waiting:auth_refresh")).toBe("要重新登录");
  expect(fleetReason("x".repeat(81) + "\nsecret")).toBe("x".repeat(80));
  expect(fleetStaleReason({ stale: true, staleReason: "environment offline" })).toBeNull();
  expect(fleetStaleReason({ stale: true, staleReason: "lease lost" })).toBe(
    "卡住 · 这台机器已不在做这单",
  );
  expect(fleetStaleReason({ stale: false, staleReason: "lease lost" })).toBeNull();
  expect(fleetStatusAge("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:02:00Z"))).toBe(
    "状态截至 2 分钟前",
  );
});
