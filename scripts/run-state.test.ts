import { describe, expect, it } from "vite-plus/test";

import {
  alreadyRunningText,
  commandLineMatches,
  DEV_MARKER,
  isLinkedWorktreeGitFile,
  parseDevRunnerPorts,
  parseStartPort,
  planKill,
  resolveStartBaseDir,
  type RunRecord,
  START_MARKER,
  stopTargets,
  takeFlag,
} from "./run-state.ts";

const devRecord = (pid: number, marker = DEV_MARKER): RunRecord => ({
  kind: "dev",
  pid,
  ports: [14000, 5800],
  address: "http://localhost:5800",
  marker,
  startedAt: "2026-11-14T00:00:00.000Z",
});

describe("run state", () => {
  it("reads server and web ports from the dev-runner line", () => {
    expect(
      parseDevRunnerPorts(
        "[dev-runner] mode=dev source=default ports serverPort=14010 webPort=5810 baseDir=/tmp/wt/.t3",
      ),
    ).toEqual({ serverPort: 14010, webPort: 5810 });
    expect(parseDevRunnerPorts("still starting")).toBeUndefined();
  });

  it("stops only a live pid whose command line still contains the marker", () => {
    const dev = devRecord(11);
    const start = { ...devRecord(22, START_MARKER), kind: "start" as const };
    const lines = new Map<number, string>([
      [11, "node D:/wt/scripts/dev-runner.ts dev"],
      [22, "node D:/wt/apps/server/dist/bin.mjs --host 127.0.0.1"],
      [33, "node D:/other/server.js"],
    ]);
    const commandLineOf = (pid: number) => lines.get(pid);
    expect(stopTargets([dev, start], commandLineOf).kill.map((record) => record.pid)).toEqual([
      11, 22,
    ]);
    expect(stopTargets([devRecord(33)], commandLineOf)).toEqual({ kill: [], idle: true });
    expect(stopTargets([devRecord(99)], commandLineOf).idle).toBe(true);
    expect(commandLineMatches("node scripts\\dev-runner.ts dev", DEV_MARKER)).toBe(true);
  });

  it("kills the recorded tree, not every node", () => {
    expect(planKill(4242, "win32")).toEqual({
      kind: "taskkill",
      command: "taskkill",
      args: ["/PID", "4242", "/T", "/F"],
    });
    expect(planKill(4242, "linux")).toEqual({ kind: "process-group", pid: 4242 });
    expect(planKill(4242, "win32").kind === "taskkill" && planKill(4242, "win32")).not.toEqual(
      expect.objectContaining({ args: expect.arrayContaining(["/IM"]) }),
    );
  });

  it("keeps start state off the home directory", () => {
    expect(isLinkedWorktreeGitFile("gitdir: D:/example/repo/.git/worktrees/14-cmds\n")).toBe(true);
    expect(isLinkedWorktreeGitFile("")).toBe(false);
    expect(
      resolveStartBaseDir({
        repoRoot: "D:/wt/14-cmds",
        linkedWorktree: true,
        envHome: "D:/example/repo/_tmp/t3home",
        flag: undefined,
      }),
    ).toBe("D:/wt/14-cmds/.t3");
    expect(
      resolveStartBaseDir({
        repoRoot: "D:/wt/14-cmds",
        linkedWorktree: true,
        envHome: "C:/Users/someone/.t3",
        flag: " D:/explicit ",
      }),
    ).toBe("D:/explicit");
    expect(
      resolveStartBaseDir({
        repoRoot: "D:/repo",
        linkedWorktree: false,
        envHome: undefined,
        flag: undefined,
      }),
    ).toBe("D:/repo/.t3");
    expect(
      resolveStartBaseDir({
        repoRoot: "D:/repo",
        linkedWorktree: false,
        envHome: "D:/repo/_tmp/t3home",
        flag: undefined,
      }),
    ).toBe("D:/repo/_tmp/t3home");
  });

  it("defaults the web service to 127.0.0.1:3773", () => {
    expect(parseStartPort([], undefined)).toBe(3773);
    expect(parseStartPort(["--port", "4000"], "3773")).toBe(4000);
    expect(parseStartPort([], "4100")).toBe(4100);
    expect(takeFlag(["--base-dir", "D:/state"], "--base-dir")).toBe("D:/state");
    expect(() => parseStartPort(["--port", "nope"], undefined)).toThrow(/端口不对/);
    expect(alreadyRunningText(devRecord(7))).toBe("已在跑\npid=7 http://localhost:5800");
  });
});
