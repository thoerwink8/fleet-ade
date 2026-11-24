import { describe, expect, it } from "vite-plus/test";

import { selectCheckSteps } from "./check.ts";

const sampleSteps = [
  { name: "lint" },
  { name: "ui-no-english" },
  { name: "ui-no-old-terms" },
  { name: "typecheck" },
  { name: "ensure-electron" },
  { name: "chromium" },
  { name: "packages" },
  { name: "web" },
  { name: "server 1/8" },
  { name: "server 2/8" },
];

describe("selectCheckSteps", () => {
  it("returns every step unchanged when neither CLI args nor CHECK_STEPS are provided", () => {
    expect(selectCheckSteps(sampleSteps, [])).toBe(sampleSteps);
    expect(selectCheckSteps(sampleSteps, ["--"], " , ")).toBe(sampleSteps);
  });

  it("selects requested CLI steps in canonical check order and strips leading --", () => {
    expect(
      selectCheckSteps(sampleSteps, ["--", "packages", "ensure-electron"]).map((step) => step.name),
    ).toEqual(["ensure-electron", "packages"]);
    expect(selectCheckSteps(sampleSteps, ["server 2/8"]).map((step) => step.name)).toEqual([
      "server 2/8",
    ]);
  });

  it("supports sharded web and server steps in canonical order while rejecting out-of-range shards", () => {
    const createWebShard = (shard: string) => [
      { name: `web ${shard} (unit)` },
      { name: `web ${shard} (browser)` },
    ];
    const createServerShard = (shard: string) => ({ name: `server ${shard}` });
    expect(
      selectCheckSteps(
        sampleSteps,
        ["server 2/2", "web 2/2", "chromium"],
        undefined,
        createWebShard,
        createServerShard,
      ).map((step) => step.name),
    ).toEqual(["chromium", "web 2/2 (unit)", "web 2/2 (browser)", "server 2/2"]);
    expect(() =>
      selectCheckSteps(sampleSteps, ["web 3/2"], undefined, createWebShard, createServerShard),
    ).toThrow(/web 3\/2/);
    expect(() =>
      selectCheckSteps(sampleSteps, ["server 3/2"], undefined, createWebShard, createServerShard),
    ).toThrow(/server 3\/2/);
  });

  it("reads comma-separated CHECK_STEPS when CLI args are absent and prefers CLI args when both exist", () => {
    expect(
      selectCheckSteps(sampleSteps, [], "web, chromium , web").map((step) => step.name),
    ).toEqual(["chromium", "web"]);
    expect(
      selectCheckSteps(sampleSteps, ["lint"], "web,chromium").map((step) => step.name),
    ).toEqual(["lint"]);
  });

  it("rejects unknown step names with the list of valid steps", () => {
    expect(() => selectCheckSteps(sampleSteps, ["lint", "nonexistent"])).toThrow(/nonexistent/);
  });
});
