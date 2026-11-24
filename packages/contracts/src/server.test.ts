import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  applyServerProviderDeltas,
  OtlpEndpointCheckInput,
  resolveEnvironmentMachineKind,
  ServerConfigProviderStatusDeltasPayload,
  ServerLifecycleStreamEvent,
  ServerObservability,
  ServerProvider,
  serverProviderDeltas,
  ServerProviders,
} from "./server.ts";
import { ServerSettings } from "./settings.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerProviders = Schema.decodeUnknownSync(ServerProviders);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("ServerProvider", () => {
  it("preserves installed-version presence through the provider wire codec", () => {
    const encode = Schema.encodeSync(ServerProvider);
    for (const installation of [{}, { installedVersion: null }, { installedVersion: "1.2.3" }]) {
      const decoded = decodeServerProvider({ ...baseProviderSnapshot, ...installation });
      const wire = JSON.parse(JSON.stringify(encode(decoded)));
      expect(wire).toMatchObject({ version: "1.0.0", ...installation });
      expect(Object.hasOwn(wire, "installedVersion")).toBe(
        Object.hasOwn(installation, "installedVersion"),
      );
      expect(decodeServerProvider(wire)).toEqual(decoded);
    }
  });
});

describe("provider status deltas", () => {
  it("send a provider's lists only when they change and rebuild the full list", () => {
    const codex = decodeServerProvider({
      ...baseProviderSnapshot,
      models: [{ slug: "gpt", name: "GPT", isCustom: false, capabilities: null }],
      slashCommands: [{ name: "compact" }],
      skills: [{ name: "review", path: "/skills/review", enabled: true }],
    });
    const claude = decodeServerProvider({ ...baseProviderSnapshot, instanceId: "claudeAgent" });
    const previous = [codex];
    const next = [
      claude,
      { ...codex, checkedAt: "2026-04-10T00:05:00.000Z", skills: [], message: "Checked" },
    ];

    const deltas = serverProviderDeltas(previous, next);
    // Unchanged lists stay home; a provider the reader never saw travels whole.
    expect(deltas[0]).toEqual(claude);
    expect(deltas[1]).not.toHaveProperty("models");
    expect(deltas[1]).not.toHaveProperty("slashCommands");
    expect(deltas[1]).toMatchObject({ skills: [], message: "Checked" });

    const codec = Schema.toCodecJson(ServerConfigProviderStatusDeltasPayload);
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)({ providers: deltas })));
    const received = Schema.decodeUnknownSync(codec)(wire).providers;
    // A decoding default would turn the absent slash commands into an empty list.
    expect(received[1]).not.toHaveProperty("slashCommands");
    expect(applyServerProviderDeltas(previous, received)).toEqual(next);
    // Without the provider the delta builds on, its lists are unknown.
    expect(applyServerProviderDeltas([], received)).toEqual([claude]);
  });
});

describe("server config forward compatibility", () => {
  it("drops providers this build cannot decode instead of failing the whole array", () => {
    const decodedBase = decodeServerProvider(baseProviderSnapshot);

    const parsed = decodeServerProviders([
      baseProviderSnapshot,
      { ...baseProviderSnapshot, instanceId: "future", status: "some-future-status" },
    ]);

    expect(parsed).toEqual([decodedBase]);
  });

  it("drops usage windows this build cannot decode instead of failing the provider", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      usageLimits: {
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [
          { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
          { id: "future", kind: "some-future-kind", label: "Future", usedPercent: 1 },
          { id: "bad", kind: "weekly", label: "Weekly", usedPercent: 120 },
        ],
      },
    });

    expect(parsed.usageLimits?.windows).toEqual([
      { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
    ]);
  });
});

describe("ServerObservability", () => {
  const decodeServerObservability = Schema.decodeUnknownSync(ServerObservability);

  it("rejects an unknown endpoint source", () => {
    expect(() =>
      decodeServerObservability({
        logsDirectoryPath: "/tmp/t3/logs",
        localTracingEnabled: true,
        otlpTracesUrl: "https://collector.example.com/v1/traces",
        otlpTracesSource: "cli",
        otlpTracesEnabled: true,
        otlpMetricsEnabled: false,
      }),
    ).toThrow();
  });
});

describe("resolveEnvironmentMachineKind", () => {
  const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
  const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
  const descriptor = (platform: Record<string, unknown>) =>
    decodeDescriptor({
      environmentId: "env-1",
      label: "Box",
      platform: { os: "linux", arch: "x64", ...platform },
      serverVersion: "1.0.0",
      capabilities: {},
    });

  it("prefers the user's pick over what the server detected", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({ environmentIcon: "laptop" }),
      }),
    ).toBe("laptop");
  });

  it("drops a machine kind this build does not know instead of failing the descriptor", () => {
    const parsed = descriptor({ machine: "toaster" });

    expect(parsed.platform.machine).toBeUndefined();
    expect(
      resolveEnvironmentMachineKind({ environment: parsed, settings: decodeSettings({}) }),
    ).toBe("server");
  });
});

describe("retired self-update events", () => {
  const decodeReady = Schema.decodeUnknownSync(ServerLifecycleStreamEvent);

  it("decodes a ready event that names a finished self-update and drops an unknown key", () => {
    const decoded = decodeReady({
      version: 1,
      sequence: 1,
      type: "ready",
      selfUpdate: "boot-service",
      payload: {
        at: "2026-01-01T00:00:00.000Z",
        environment: {
          environmentId: "env_old",
          label: "old",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1.2.3",
          capabilities: { repositoryIdentity: true, serverSelfUpdate: "boot-service" },
        },
        updateOutcome: {
          id: "old-update",
          fromVersion: "1.2.2",
          targetVersion: "1.2.3",
          status: "committed",
        },
      },
    });

    expect(decoded).not.toHaveProperty("selfUpdate");
    expect(decoded.type).toBe("ready");
    if (decoded.type !== "ready") return;
    expect(decoded.payload.updateOutcome).toEqual({
      id: "old-update",
      fromVersion: "1.2.2",
      targetVersion: "1.2.3",
      status: "committed",
    });
    expect(decoded.payload.environment.capabilities.serverSelfUpdate).toBe("boot-service");
  });
});

describe("OtlpEndpointCheckInput", () => {
  const decode = Schema.decodeUnknownSync(OtlpEndpointCheckInput);

  it("accepts HTTP receivers only", () => {
    expect(decode({ signal: "traces", url: "https://collector.example.com/v1/traces" }).url).toBe(
      "https://collector.example.com/v1/traces",
    );
    for (const url of ["data:text/plain,ok", "file:///etc/hosts", "collector:4318/v1/traces"]) {
      expect(() => decode({ signal: "traces", url })).toThrow();
    }
  });
});

describe("ServerLifecycleWelcomePayload", () => {
  const decodeLifecycleEvent = Schema.decodeUnknownSync(ServerLifecycleStreamEvent);
  const environment = {
    environmentId: "env-1",
    label: "Test box",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: {},
  };

  it("decodes a fresh welcome payload without bootstrapThreadId", () => {
    const decoded = decodeLifecycleEvent({
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment,
        cwd: "/workspace/project",
        projectName: "project",
        bootstrapProjectId: "project-1",
      },
    });

    expect(decoded.type).toBe("welcome");
    if (decoded.type !== "welcome") return;
    expect(decoded.payload.bootstrapProjectId).toBe("project-1");
    expect(decoded.payload.bootstrapThreadId).toBeUndefined();
  });

  it("decodes legacy welcome payloads carrying bootstrapThreadId and retired bootstrap fields", () => {
    const decoded = decodeLifecycleEvent({
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        environment,
        cwd: "/workspace/project",
        projectName: "project",
        bootstrapStatus: "complete",
        bootstrapProjectId: "project-1",
        bootstrapThreadId: "thread-1",
        bootstrapProjectCreated: true,
        bootstrapThreadCreated: true,
      },
    });

    expect(decoded.type).toBe("welcome");
    if (decoded.type !== "welcome") return;
    expect(decoded.payload.bootstrapStatus).toBe("complete");
    expect(decoded.payload.bootstrapProjectId).toBe("project-1");
    expect(decoded.payload.bootstrapThreadId).toBe("thread-1");
    expect(decoded.payload.bootstrapProjectCreated).toBe(true);
    expect(decoded.payload.bootstrapThreadCreated).toBe(true);
  });
});
