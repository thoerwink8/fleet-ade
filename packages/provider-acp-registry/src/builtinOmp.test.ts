import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  OMP_ACP_BUILTIN,
  OMP_ACP_INSTANCE_ID,
  isConfiguredOmpAcp,
  ompAcpProviderInstance,
  ompAcpSettings,
  ompNeedsInstallerExecutable,
} from "./builtinOmp.ts";

describe("omp ACP builtin", () => {
  it("defaults to the local omp acp command and keeps acp when the path changes", () => {
    expect(ompAcpSettings()).toMatchObject({
      source: "local",
      enabled: true,
      commandPath: "omp",
      commandArgs: ["acp"],
    });
    expect(ompAcpSettings("D:/tools/omp.exe")).toMatchObject({
      source: "local",
      commandPath: "D:/tools/omp.exe",
      commandArgs: ["acp"],
    });
    expect(ompAcpProviderInstance()).toEqual({
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: OMP_ACP_BUILTIN.name,
      enabled: true,
      config: ompAcpSettings(),
    });
  });

  it("uses the installer binary only for a bare omp command that is missing or a batch shim", () => {
    expect(ompNeedsInstallerExecutable({ commandPath: "omp", resolvedPath: undefined })).toBe(true);
    expect(
      ompNeedsInstallerExecutable({
        commandPath: "omp",
        resolvedPath: "D:/Tools/node/omp.cmd",
      }),
    ).toBe(true);
    expect(
      ompNeedsInstallerExecutable({
        commandPath: "omp",
        resolvedPath: "C:/omp/omp.exe",
      }),
    ).toBe(false);
    expect(
      ompNeedsInstallerExecutable({
        commandPath: "D:/tools/omp.exe",
        resolvedPath: undefined,
      }),
    ).toBe(false);
    expect(OMP_ACP_INSTANCE_ID).toBe("omp");
  });

  it("treats the omp instance id or the default local command as already configured", () => {
    expect(isConfiguredOmpAcp({})).toBe(false);
    expect(
      isConfiguredOmpAcp({
        omp: {
          driver: "acpRegistry",
          config: { source: "local", commandPath: "D:/tools/omp.exe" },
        },
      }),
    ).toBe(true);
    expect(
      isConfiguredOmpAcp({
        other: {
          driver: "acpRegistry",
          config: { source: "local", commandPath: "omp", commandArgs: ["acp"] },
        },
      }),
    ).toBe(true);
    expect(
      isConfiguredOmpAcp({
        other: { driver: "acpRegistry", config: { source: "registry", agentId: "devin" } },
      }),
    ).toBe(false);
  });
});
