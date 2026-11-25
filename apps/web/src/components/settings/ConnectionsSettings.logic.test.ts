import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { type DesktopWslState, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Socket from "effect/socket/Socket";
import {
  applyWslEnableSelection,
  isServerNetworkAccessible,
  mutationFailureMessage,
  peerLinkHostSections,
  resolveAccessEnvironmentId,
  resolveTailscaleServeBaseUrl,
  selectQrEndpointOption,
  togglePairingScopeSelection,
} from "./ConnectionsSettings.logic";

describe("togglePairingScopeSelection", () => {
  it.each([
    {
      label: "adds terminal:read when terminal:operate is selected",
      current: ["orchestration:read"],
      scope: "terminal:operate",
      checked: true,
      expected: ["orchestration:read", "terminal:operate", "terminal:read"],
    },
    {
      label: "drops terminal:operate when terminal:read is cleared",
      current: ["terminal:read", "terminal:operate", "access:read"],
      scope: "terminal:read",
      checked: false,
      expected: ["access:read"],
    },
    {
      label: "keeps terminal:read when terminal:operate is cleared",
      current: ["terminal:read", "terminal:operate"],
      scope: "terminal:operate",
      checked: false,
      expected: ["terminal:read"],
    },
    {
      label: "toggles unrelated scopes on their own",
      current: ["terminal:read"],
      scope: "filesystem:read",
      checked: true,
      expected: ["terminal:read", "filesystem:read"],
    },
  ] as const)("$label", ({ current, scope, checked, expected }) => {
    expect(togglePairingScopeSelection(current, scope, checked)).toEqual(expected);
  });
});

describe("resolveTailscaleServeBaseUrl", () => {
  it.each([
    ["https://host.tail.ts.net:441/", 443, "https://host.tail.ts.net"],
    ["https://host.tail.ts.net:441/", 444, "https://host.tail.ts.net:444"],
  ] as const)("previews %s on port %i", (httpBaseUrl, port, expected) => {
    expect(resolveTailscaleServeBaseUrl({ httpBaseUrl }, port, true)).toBe(expected);
  });

  it("returns null without a pending endpoint", () => {
    expect(resolveTailscaleServeBaseUrl(null, 443, true)).toBeNull();
  });

  it.each([
    ["https://host.tail.ts.net:441/", 0, false],
    ["not a URL", 443, true],
  ] as const)("preserves %s when port %i cannot be previewed", (httpBaseUrl, port, isPortValid) => {
    expect(resolveTailscaleServeBaseUrl({ httpBaseUrl }, port, isPortValid)).toBe(httpBaseUrl);
  });
});

const baseWslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: true,
  wslOnly: true,
  distros: [],
  preflightError: null,
};

describe("applyWslEnableSelection", () => {
  it("clears WSL-only and updates the distro before enabling both backends", async () => {
    const calls: Array<string> = [];
    let persistedWslOnly = true;
    let persistedDistro: string | null = "Ubuntu";
    const setWslDistro = vi.fn(async (distro: string | null) => {
      calls.push(`setWslDistro:${distro ?? "default"}`);
      persistedDistro = distro;
      return { ...baseWslState, distro, wslOnly: persistedWslOnly };
    });
    const setWslBackendEnabled = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslBackendEnabled:${enabled}`);
      return {
        ...baseWslState,
        enabled,
        distro: persistedDistro,
        wslOnly: persistedWslOnly,
      };
    });
    const setWslOnly = vi.fn(async (enabled: boolean) => {
      calls.push(`setWslOnly:${enabled}`);
      persistedWslOnly = enabled;
      return { ...baseWslState, distro: persistedDistro, wslOnly: enabled };
    });

    const state = await applyWslEnableSelection({
      bridge: { setWslDistro, setWslBackendEnabled, setWslOnly },
      mode: "both",
      nextDistro: "Debian",
      persistedDistro: "Ubuntu",
    });

    expect(calls).toEqual(["setWslOnly:false", "setWslDistro:Debian", "setWslBackendEnabled:true"]);
    expect(state).toMatchObject({ enabled: true, distro: "Debian", wslOnly: false });
  });
});

describe("selectQrEndpointOption", () => {
  const options = [
    {
      id: "desktop-loopback:4780",
      preferenceKey: "desktop-core:loopback:http",
      qrShareable: false,
    },
    {
      id: "tailscale-ip:http://100.84.12.7:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "tailscale-ip:http://100.84.12.8:4780",
      preferenceKey: "tailscale:ip:http",
      qrShareable: true,
    },
    {
      id: "desktop-lan:http://192.168.1.42:4780",
      preferenceKey: "desktop-core:lan:http",
      qrShareable: true,
    },
  ];

  it("resolves an explicit selection by unique endpoint id, not the shared preference key", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:http://100.84.12.8:4780", null)?.id).toBe(
      "tailscale-ip:http://100.84.12.8:4780",
    );
  });

  it("skips non-QR-shareable options in the fallback so the panel never opens on loopback", () => {
    expect(selectQrEndpointOption(options, "tailscale-ip:gone", "nope")?.id).toBe(
      "tailscale-ip:http://100.84.12.7:4780",
    );
  });
});

describe("resolveAccessEnvironmentId", () => {
  const primary = EnvironmentId.make("primary");
  const service = EnvironmentId.make("service");
  const laptop = EnvironmentId.make("laptop");
  it.each([
    {
      label: "defaults to the primary environment",
      primaryEnvironmentId: primary,
      environments: [
        { environmentId: primary, connected: true },
        { environmentId: service, connected: true },
      ],
      selected: null,
      expected: primary,
    },
    {
      label: "falls back to a connected saved environment without a primary",
      primaryEnvironmentId: null,
      environments: [
        { environmentId: laptop, connected: false },
        { environmentId: service, connected: true },
      ],
      selected: null,
      expected: service,
    },
    {
      label: "keeps an explicit choice",
      primaryEnvironmentId: primary,
      environments: [
        { environmentId: primary, connected: true },
        { environmentId: laptop, connected: false },
      ],
      selected: laptop,
      expected: laptop,
    },
    {
      label: "drops a choice that is no longer listed",
      primaryEnvironmentId: null,
      environments: [{ environmentId: service, connected: true }],
      selected: laptop,
      expected: service,
    },
    {
      label: "has nothing to show without environments",
      primaryEnvironmentId: null,
      environments: [],
      selected: null,
      expected: null,
    },
  ])("$label", ({ primaryEnvironmentId, environments, selected, expected }) => {
    expect(resolveAccessEnvironmentId({ primaryEnvironmentId, environments, selected })).toBe(
      expected,
    );
  });
});

describe("isServerNetworkAccessible", () => {
  const served = [{ kind: "tailnet", httpBaseUrl: "https://host.example.ts.net:8443/" }] as const;
  it.each([
    { authPolicy: "remote-reachable", directEndpoints: undefined, expected: true },
    { authPolicy: "loopback-browser", directEndpoints: undefined, expected: false },
    { authPolicy: "loopback-browser", directEndpoints: [], expected: false },
    { authPolicy: "loopback-browser", directEndpoints: served, expected: true },
    { authPolicy: null, directEndpoints: served, expected: false },
  ] as const)("$authPolicy with $directEndpoints.length endpoints", (row) => {
    expect(isServerNetworkAccessible(row)).toBe(row.expected);
  });
});

describe("peerLinkHostSections", () => {
  const primary = (id: string, label: string, displayUrl = "http://127.0.0.1:3773") => ({
    environmentId: EnvironmentId.make(id),
    label,
    displayUrl,
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make(id),
      label,
      httpBaseUrl: displayUrl,
      wsBaseUrl: "ws://127.0.0.1:3773",
    }),
  });
  const bearer = (
    id: string,
    label: string,
    displayUrl: string,
    connectionId = `bearer:${id}`,
  ) => ({
    environmentId: EnvironmentId.make(id),
    label,
    displayUrl,
    target: new BearerConnectionTarget({
      environmentId: EnvironmentId.make(id),
      label,
      connectionId,
    }),
  });

  it("lists one environment once, even when a second path repeats its id", () => {
    const local = primary("env-local", "bb-1");
    const repeated = bearer("env-local", "bb-1", "http://127.0.0.1:39721");
    expect(peerLinkHostSections([local, repeated, local])).toEqual([
      { environmentId: EnvironmentId.make("env-local"), environmentLabel: null },
    ]);
    expect(
      peerLinkHostSections([
        local,
        repeated,
        bearer("env-vps", "机房", "https://vps.example:8443"),
      ]).map((section) => [section.environmentId, section.environmentLabel]),
    ).toEqual([
      [EnvironmentId.make("env-local"), "bb-1"],
      [EnvironmentId.make("env-vps"), "机房"],
    ]);
  });

  it("keeps two different computers that share a name and tells them apart", () => {
    expect(
      peerLinkHostSections([
        primary("env-local", "bb-1"),
        bearer("env-serve", "bb-1", "http://127.0.0.1:39721"),
      ]),
    ).toEqual([
      { environmentId: EnvironmentId.make("env-local"), environmentLabel: "bb-1（本机）" },
      { environmentId: EnvironmentId.make("env-serve"), environmentLabel: "bb-1（远程）" },
    ]);
    expect(
      peerLinkHostSections([
        bearer("env-a", "bb-1", "http://127.0.0.1:4000"),
        bearer("env-b", "bb-1", "http://127.0.0.1:4001"),
      ]).map((section) => section.environmentLabel),
    ).toEqual(["bb-1（127.0.0.1:4000）", "bb-1（127.0.0.1:4001）"]);
    expect(
      peerLinkHostSections([
        primary("env-local", "bb-1"),
        bearer("env-wsl", "bb-1", "http://127.0.0.1:39722", "local:wsl"),
      ]).map((section) => section.environmentLabel),
    ).toEqual(["bb-1（本机）", "bb-1（WSL）"]);
    expect(
      peerLinkHostSections([
        bearer("env-serve", "bb-1", "http://127.0.0.1:39721"),
        {
          environmentId: EnvironmentId.make("env-ssh"),
          label: "bb-1",
          displayUrl: "ada@build:22",
          target: new SshConnectionTarget({
            environmentId: EnvironmentId.make("env-ssh"),
            label: "bb-1",
            connectionId: "ssh-build",
          }),
        },
      ]).map((section) => section.environmentLabel),
    ).toEqual(["bb-1（127.0.0.1:39721）", "bb-1（ada@build:22）"]);
    expect(
      peerLinkHostSections([
        bearer("env-a", "bb-1", "http://127.0.0.1:4000"),
        bearer("env-b", "bb-1", "http://127.0.0.1:4000"),
      ]).map((section) => section.environmentLabel),
    ).toEqual(["bb-1（127.0.0.1:4000 · env-a）", "bb-1（127.0.0.1:4000 · env-b）"]);
  });

  it("shows a single computer as one section", () => {
    const local = primary("env-local", "bb-1");
    expect(peerLinkHostSections([local])).toEqual([
      { environmentId: local.environmentId, environmentLabel: null },
    ]);
  });

  it("keeps distinct names unchanged", () => {
    expect(
      peerLinkHostSections([
        primary("env-local", "办公室"),
        bearer("env-vps", "机房", "https://vps.example:8443"),
        {
          environmentId: EnvironmentId.make("env-ssh"),
          label: "构建机",
          displayUrl: "ada@build:22",
          target: new SshConnectionTarget({
            environmentId: EnvironmentId.make("env-ssh"),
            label: "构建机",
            connectionId: "ssh-build",
          }),
        },
      ]).map((section) => section.environmentLabel),
    ).toEqual(["办公室", "机房", "构建机"]);
  });
});

describe("mutationFailureMessage", () => {
  it("replaces an interrupted or dropped connection with the shared sentence", () => {
    expect(mutationFailureMessage(Cause.interrupt(1), "无法配置 Tailscale HTTPS。")).toBe(
      "连接已断开，内容已保留，恢复后再试。",
    );

    const dropped = Cause.fail(
      new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1006 }) }),
    );
    expect(mutationFailureMessage(dropped, "无法配置 Tailscale HTTPS。")).toBe(
      "连接已断开，内容已保留，恢复后再试。",
    );
  });

  it("keeps the server's own rejection and the fallback for non-error defects", () => {
    expect(
      mutationFailureMessage(
        Cause.fail(new Error("此连接无权更改网络访问。")),
        "无法配置 Tailscale HTTPS。",
      ),
    ).toBe("此连接无权更改网络访问。");
    expect(mutationFailureMessage(Cause.die("boom"), "无法配置 Tailscale HTTPS。")).toBe(
      "无法配置 Tailscale HTTPS。",
    );
  });
});
