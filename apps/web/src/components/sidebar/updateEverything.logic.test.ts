import { EnvironmentId, type ServerSelfUpdateCapability } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectRestartingMachines,
  collectServerUpdateTargets,
  describeUpdateCapsule,
  describeUpdateEverything,
  type UpdateEverythingMachine,
} from "./updateEverything.logic";

function machine(
  id: string,
  serverVersion: string,
  selfUpdate: ServerSelfUpdateCapability | undefined,
  overrides: Partial<UpdateEverythingMachine> = {},
): UpdateEverythingMachine {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion,
        capabilities: {
          repositoryIdentity: true,
          ...(selfUpdate ? { serverSelfUpdate: selfUpdate } : {}),
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
    ...overrides,
  };
}

describe("collectServerUpdateTargets", () => {
  it("updates remote servers that can move to the target and names every skipped one", () => {
    const { targets, skipped } = collectServerUpdateTargets(
      [
        machine("this-app", "0.0.40", "desktop-managed", { hostedByThisApp: true }),
        machine("service", "0.0.40", "boot-service"),
        machine("nightly-service", "0.0.49-nightly.20261001.3", "boot-service"),
        machine("other-desktop", "0.0.49-nightly.20261001.3", "desktop-managed"),
        machine("offline", "0.0.40", "boot-service", { connected: false }),
        machine("never-connected", "0.0.40", "boot-service", { serverConfig: null }),
        machine("no-scope", "0.0.40", "boot-service", { canMaintain: false }),
        machine("busy", "0.0.40", "boot-service", {
          updateState: {
            status: "running",
            stage: "downloading",
            fromVersion: "0.0.40",
            targetVersion: "0.0.50",
          },
        }),
        machine("current", "0.0.50", "boot-service"),
        machine("current-offline", "0.0.50", "boot-service", { connected: false }),
        machine("manual", "0.0.40", undefined),
      ],
      "0.0.50",
    );

    expect(targets.map((target) => [target.serverLabel, target.targetVersion])).toEqual([
      ["service", "0.0.50"],
    ]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["nightly-service", "使用 nightly 通道"],
      ["other-desktop", "需要手动更新"],
      ["offline", "未连接"],
      ["never-connected", "未连接"],
      ["no-scope", "没有权限"],
      ["busy", "正在更新"],
      ["manual", "需要手动更新"],
    ]);
  });
});

describe("collectRestartingMachines", () => {
  it("lists the servers the run is updating", () => {
    const withContinuation = (
      id: string,
      overrides: Partial<UpdateEverythingMachine> = {},
      enabled = false,
    ) => {
      const base = machine(id, "0.0.40", "boot-service", overrides);
      return {
        ...base,
        serverConfig: {
          environment: base.serverConfig!.environment,
          settings: { continueThreadsAfterServerUpdate: enabled },
        },
      };
    };
    const machines = [
      withContinuation("this-app", { hostedByThisApp: true }, true),
      withContinuation("alvin", {}, true),
      withContinuation("opted-out", {}, false),
      machine("old", "0.0.40", "boot-service"),
      withContinuation("providers-only"),
    ];
    const servers = ["alvin", "opted-out", "old"].map((id) => ({
      environmentId: EnvironmentId.make(id),
    }));

    expect(collectRestartingMachines(machines, servers)).toEqual([
      { environmentId: "alvin", continuesThreads: true },
      { environmentId: "opted-out", continuesThreads: false },
      { environmentId: "old", continuesThreads: false },
    ]);
  });
});

describe("describeUpdateEverything", () => {
  it("gives each machine one row with its server and provider updates", () => {
    const id = EnvironmentId.make;
    const { rows } = describeUpdateEverything({
      servers: [
        {
          environmentId: id("npm"),
          serverLabel: "bb-1",
          targetVersion: "1.1.0",
        },
      ],
      providerMachines: [
        { environmentId: id("npm"), label: "bb-1", providers: ["Codex", "Claude"] },
        { environmentId: id("local"), label: "Mainbook", providers: ["Codex"] },
        { environmentId: id("manual"), label: "alvin", providers: ["Claude"] },
      ],
      skipped: [
        { environmentId: id("manual"), label: "alvin", reason: "需要手动更新" },
        { environmentId: id("offline"), label: "TheoRoom", reason: "未连接" },
      ],
    });

    expect(
      rows.map(({ label, app, skipped, providers }) => [label, app, skipped, providers]),
    ).toEqual([
      ["bb-1", "server", null, ["Codex", "Claude"]],
      ["Mainbook", null, null, ["Codex"]],
      ["alvin", null, "需要手动更新", ["Claude"]],
      ["TheoRoom", null, "未连接", []],
    ]);
  });
});

describe("describeUpdateCapsule", () => {
  it("retries a failed server update", () => {
    const failed = {
      machine: {
        environmentId: EnvironmentId.make("remote"),
        label: "remote",
        updatesProviders: false,
        server: {
          environmentId: EnvironmentId.make("remote"),
          serverLabel: "remote",
          selfUpdate: "boot-service" as const,
          targetVersion: "0.1.3",
        },
        handedOffVersion: null,
        startedAt: 0,
        result: "failed" as const,
        failure: "offline",
        providerFailure: null,
      },
      status: "failed" as const,
    };
    const run = { phase: "servers" as const, machines: [] };

    expect(describeUpdateCapsule(run, [failed], 0).action).toBe("retry");
  });
});
