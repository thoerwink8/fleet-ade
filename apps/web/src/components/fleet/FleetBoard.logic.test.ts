import { expect, it } from "vite-plus/test";
import type { FleetSummaryRow } from "@t3tools/contracts";
import {
  defaultFleetSource,
  disambiguateMachineNames,
  filterFleetRows,
  fleetFullReason,
  fleetMachineName,
  fleetReason,
  fleetStaleReason,
  fleetStatusAge,
  fleetStatusCounts,
  groupFleetRows,
} from "./FleetBoard.logic.ts";

const row = (input: Partial<FleetSummaryRow>): FleetSummaryRow => ({
  environmentId: "a",
  threadId: "thread",
  title: "任务",
  phase: "working",
  reason: "",
  needsYou: false,
  lastProgress: "",
  updatedAt: "2026-01-01T00:00:00Z",
  stale: false,
  revision: 1,
  ...input,
});

it("names machines from peer-link names, then local labels, then a fallback", () => {
  const linked = new Map([
    ["a", "链接名"],
    ["expired", "旧名"],
  ]);
  const directory = new Map([
    ["a", "本机名"],
    ["b", "机器乙"],
  ]);
  expect(fleetMachineName("a", linked, directory)).toBe("链接名");
  expect(fleetMachineName("b", linked, directory)).toBe("机器乙");
  expect(fleetMachineName("gone", linked, directory)).toBe("未命名电脑");
  expect(fleetMachineName("", linked, directory)).toBe("未命名电脑");
});

it("disambiguates duplicate machine names with a short environment id suffix", () => {
  const names = disambiguateMachineNames(
    ["env-alpha-1111", "env-beta-2222", "env-gamma-3333"],
    (id) => (id === "env-gamma-3333" ? "工作机" : "未命名电脑"),
  );
  expect(names.get("env-alpha-1111")).toBe("未命名电脑 (env-al)");
  expect(names.get("env-beta-2222")).toBe("未命名电脑 (env-be)");
  expect(names.get("env-gamma-3333")).toBe("工作机");
});

it("defaults the summary source to the requested or primary machine when eligible, else the first candidate", () => {
  expect(defaultFleetSource("primary", ["other", "primary", "third"])).toBe("primary");
  expect(defaultFleetSource("missing", ["other", "third"])).toBe("other");
  expect(defaultFleetSource(null, ["other", "third"])).toBe("other");
  expect(defaultFleetSource("primary", [])).toBeNull();
});

it("groups and filters a thousand rows without confusing issue searches", () => {
  const rows: FleetSummaryRow[] = Array.from({ length: 1000 }, (_, i) =>
    row({
      environmentId: i % 2 ? "b" : "a",
      threadId: String(i),
      repo: "repo",
      issue: i + 1,
      title: `任务 ${String.fromCharCode(65 + (i % 26))}`,
      phase: i === 150 ? "stuck" : "working",
      needsYou: i === 150,
    }),
  );
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

it("searches title text and issue numbers loosely, but # only matches issue numbers", () => {
  const rows = [
    row({ threadId: "t1", title: "#4089 修机群看板", issue: 77 }),
    row({ threadId: "t2", title: "整理周报", issue: 4089 }),
    row({ threadId: "t3", title: "机群 PR-2", issue: 12 }),
  ];
  // A bare query matches title text loosely, but issue numbers exactly.
  expect(filterFleetRows(rows, { search: "4089" }).map((r) => r.threadId)).toEqual(["t1", "t2"]);
  expect(filterFleetRows(rows, { search: "89" }).map((r) => r.threadId)).toEqual(["t1"]);
  // # only searches issue numbers; titles that merely contain the digits stay out.
  expect(filterFleetRows(rows, { search: "#4089" }).map((r) => r.threadId)).toEqual(["t2"]);
  expect(filterFleetRows(rows, { search: "#89" }).map((r) => r.threadId)).toEqual([]);
  expect(filterFleetRows(rows, { search: "#4089 修" }).map((r) => r.threadId)).toEqual([]);
  expect(filterFleetRows(rows, { search: "#" }).map((r) => r.threadId)).toEqual(["t1", "t2", "t3"]);
});

it("filters by one status at a time and keeps needs-you out of stuck", () => {
  const rows = [
    row({ threadId: "need", needsYou: true, phase: "stuck" }),
    row({ threadId: "work", phase: "working" }),
    row({ threadId: "done", phase: "done" }),
    row({ threadId: "idle", phase: "stuck" }),
  ];
  expect(filterFleetRows(rows, { status: "needsYou" }).map((r) => r.threadId)).toEqual(["need"]);
  expect(filterFleetRows(rows, { status: "done" }).map((r) => r.threadId)).toEqual(["done"]);
  expect(filterFleetRows(rows, {}).map((r) => r.threadId)).toEqual([
    "need",
    "work",
    "done",
    "idle",
  ]);
  // A needs-you row is matched by needsYou, not by its stuck phase.
  expect(filterFleetRows(rows, { status: "stuck" }).map((r) => r.threadId)).toEqual(["idle"]);
});
it("counts statuses once, keeps needs-you out of phase, and marks offline rows", () => {
  const rows = [
    row({ threadId: "need", needsYou: true, phase: "stuck" }),
    row({ threadId: "stuck", phase: "stuck" }),
    row({ threadId: "work", phase: "working" }),
    row({ threadId: "done", phase: "done" }),
    row({ threadId: "offline", stale: true, staleReason: "environment offline" }),
  ];
  expect(fleetStatusCounts(rows)).toEqual({
    needsYou: 1,
    stuck: 1,
    working: 2,
    done: 1,
    offline: 1,
  });
});

it("counts a machine offline only for stale rows marked environment offline", () => {
  const rows = [
    row({ environmentId: "a", stale: true, staleReason: "environment offline" }),
    row({ environmentId: "a", stale: true, staleReason: "lease lost" }),
    row({ environmentId: "a", stale: false, staleReason: "environment offline" }),
    row({ environmentId: "b", stale: true, staleReason: "environment offline" }),
  ];
  const groups = groupFleetRows(rows, (id) => id);
  expect(groups.find((g) => g.environmentId === "a")?.counts.offline).toBe(1);
  expect(groups.find((g) => g.environmentId === "b")?.counts.offline).toBe(1);
});

it("formats reasons, ages and machine names", () => {
  expect(fleetReason("waiting:command")).toBe("等你批准命令");
  expect(fleetReason("waiting:file-change")).toBe("等你批准改文件");
  expect(fleetReason("waiting:user_input")).toBe("在等你回答");
  expect(fleetReason("waiting:auth_refresh")).toBe("要重新登录");
  expect(fleetReason("x".repeat(81) + "\nsecret")).toBe("x".repeat(80));
  expect(fleetFullReason("waiting:command")).toBe("等你批准命令");
  expect(fleetFullReason("line1\nline2")).toBe("line1\nline2");
  expect(fleetStaleReason({ stale: true, staleReason: "environment offline" })).toBeNull();
  expect(fleetStaleReason({ stale: true, staleReason: "lease lost" })).toBe(
    "卡住 · 这台电脑已不在做这单",
  );
  expect(fleetStaleReason({ stale: false, staleReason: "lease lost" })).toBeNull();
  const at = "2026-01-01T00:00:00Z";
  const now = Date.parse("2026-01-01T00:02:00Z");
  expect(fleetStatusAge(at, now, true)).toBe("状态截至 2 分钟前");
  expect(fleetStatusAge(at, now, false)).toBe("2 分钟前");
  expect(fleetStatusAge("not-a-date", now, true)).toBe("");
});
