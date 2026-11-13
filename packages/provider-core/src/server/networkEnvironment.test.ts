import { describe, expect, it } from "@effect/vitest";

import {
  applyAgentNetworkEnvironment,
  parseMacScutilProxy,
  parseWindowsInternetSettings,
  proxyUrlForServerRequest,
  resolveGlobalRoute,
  type AgentNetworkSettings,
  type SystemProxyRead,
} from "./networkEnvironment.ts";

const emptySystem: SystemProxyRead = {
  proxyUrl: null,
  noProxy: "",
  detail: "系统代理没有开",
  available: true,
};

const systemProxy: SystemProxyRead = {
  proxyUrl: "http://127.0.0.1:7890",
  noProxy: "intranet",
  detail: "来自系统代理",
  available: true,
};

const planted = {
  HTTP_PROXY: "http://127.0.0.1:56879",
  http_proxy: "http://127.0.0.1:56879",
  Http_Proxy: "http://127.0.0.1:56879",
  HTTPS_PROXY: "http://127.0.0.1:56879",
  ALL_PROXY: "http://127.0.0.1:56879",
  NO_PROXY: "example.test",
  NODE_USE_ENV_PROXY: "1",
  NODE_EXTRA_CA_CERTS: "C:\\reclaude\\ca.pem",
  PATH: "C:\\Windows",
};

function settings(patch: Partial<AgentNetworkSettings> = {}): AgentNetworkSettings {
  return {
    line: "auto",
    proxyUrl: "",
    noProxy: "",
    extraCaCertPath: "",
    agentOverrides: {},
    ...patch,
  };
}

describe("applyAgentNetworkEnvironment", () => {
  it("injects a custom proxy for grok and drops a planted reclaude proxy and CA", () => {
    const env = applyAgentNetworkEnvironment({
      hostEnv: planted,
      settings: settings({
        line: "custom",
        proxyUrl: "127.0.0.1:7890",
        noProxy: "example.com",
      }),
      systemProxy: emptySystem,
      target: { command: "grok", args: [] },
    });

    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.http_proxy).toBe("http://127.0.0.1:7890");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.https_proxy).toBe("http://127.0.0.1:7890");
    expect(env.ALL_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.NO_PROXY).toContain("example.com");
    expect(env.NO_PROXY).toContain("localhost");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.PATH).toBe("C:\\Windows");
    expect(env.Http_Proxy).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("56879");
    expect(planted.HTTP_PROXY).toBe("http://127.0.0.1:56879");
    expect(planted.NODE_EXTRA_CA_CERTS).toBe("C:\\reclaude\\ca.pem");
  });

  it("clears inherited proxy variables and the extra CA on a direct line", () => {
    const env = applyAgentNetworkEnvironment({
      hostEnv: planted,
      settings: settings({ line: "direct" }),
      systemProxy: systemProxy,
      target: { command: "C:\\Tools\\grok.exe", args: ["--model", "grok-build"] },
    });

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.PATH).toBe("C:\\Windows");
  });

  it("lets a per-agent direct override win over a global custom proxy", () => {
    const env = applyAgentNetworkEnvironment({
      hostEnv: planted,
      settings: settings({
        line: "custom",
        proxyUrl: "http://127.0.0.1:7890",
        agentOverrides: { grok: { line: "direct", proxyUrl: "", noProxy: "" } },
      }),
      systemProxy: emptySystem,
      target: { command: "grok", args: [] },
    });

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("lets a per-agent custom override win over a global direct line", () => {
    const env = applyAgentNetworkEnvironment({
      hostEnv: planted,
      settings: settings({
        line: "direct",
        agentOverrides: {
          grok: { line: "custom", proxyUrl: "http://192.0.2.8:8888", noProxy: "" },
        },
      }),
      systemProxy: emptySystem,
      target: { command: "grok", args: [] },
    });

    expect(env.HTTPS_PROXY).toBe("http://192.0.2.8:8888");
    expect(JSON.stringify(env)).not.toContain("56879");
  });

  it("strips proxy variables and the extra CA from a reclaude Claude launch", () => {
    const env = applyAgentNetworkEnvironment({
      hostEnv: planted,
      settings: settings({
        line: "custom",
        proxyUrl: "http://127.0.0.1:7890",
        extraCaCertPath: "D:\\corp\\root.pem",
        agentOverrides: {
          claudeAgent: { line: "custom", proxyUrl: "http://127.0.0.1:7890", noProxy: "" },
        },
      }),
      systemProxy: systemProxy,
      target: { command: "C:\\Users\\me\\AppData\\Roaming\\npm\\reclaude.cmd", args: [] },
    });

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("56879");
    expect(JSON.stringify(env)).not.toContain("root.pem");
  });

  it("treats node launching a reclaude script as reclaude", () => {
    const env = applyAgentNetworkEnvironment({
      hostEnv: planted,
      settings: settings({
        line: "custom",
        proxyUrl: "http://127.0.0.1:7890",
        extraCaCertPath: "D:\\corp\\root.pem",
      }),
      systemProxy: emptySystem,
      target: { command: "node", args: ["D:\\tools\\reclaude\\cli.js"] },
    });

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("gives a non-reclaude child the configured CA instead of the inherited one", () => {
    const env = applyAgentNetworkEnvironment({
      hostEnv: planted,
      settings: settings({
        line: "custom",
        proxyUrl: "http://127.0.0.1:7890",
        extraCaCertPath: "D:\\corp\\root.pem",
      }),
      systemProxy: emptySystem,
      target: { command: "claude", args: [] },
    });

    expect(env.NODE_EXTRA_CA_CERTS).toBe("D:\\corp\\root.pem");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(JSON.stringify(env)).not.toContain("reclaude\\ca.pem");
  });

  it("uses the system proxy on auto and direct when the system proxy is off", () => {
    expect(resolveGlobalRoute(settings(), systemProxy).proxyUrl).toBe("http://127.0.0.1:7890");
    const env = applyAgentNetworkEnvironment({
      hostEnv: planted,
      settings: settings(),
      systemProxy: emptySystem,
      target: { command: "grok", args: [] },
    });
    expect(env.HTTP_PROXY).toBeUndefined();
  });

  it("does not inject loopback port 56879 from a custom address", () => {
    const env = applyAgentNetworkEnvironment({
      hostEnv: { PATH: "C:\\Windows" },
      settings: settings({ line: "custom", proxyUrl: "http://127.0.0.1:56879" }),
      systemProxy: emptySystem,
      target: { command: "grok", args: [] },
    });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
  });

  it("matches a configured binary path before the file stem", () => {
    const env = applyAgentNetworkEnvironment({
      hostEnv: planted,
      settings: settings({
        line: "direct",
        agentOverrides: {
          grok: { line: "custom", proxyUrl: "http://127.0.0.1:7890", noProxy: "" },
        },
      }),
      systemProxy: emptySystem,
      target: { command: "D:\\apps\\my-grok.exe", args: [] },
      agents: [{ driver: "grok", binaryPath: "D:\\apps\\my-grok.exe" }],
    });
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  });
});

describe("system proxy text", () => {
  it("reads a Windows user proxy and maps local exceptions", () => {
    const read = parseWindowsInternetSettings(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    <local>;example.com
`);
    expect(read.proxyUrl).toBe("http://127.0.0.1:7890");
    expect(read.noProxy).toBe("localhost,127.0.0.1,example.com");
    expect(read.available).toBe(true);
  });

  it("prefers the https entry of a Windows per-scheme proxy", () => {
    const read = parseWindowsInternetSettings(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=192.0.2.2:8080;https=192.0.2.3:8443
`);
    expect(read.proxyUrl).toBe("http://192.0.2.3:8443");
  });

  it("reports a disabled Windows proxy as direct", () => {
    const read = parseWindowsInternetSettings(`
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7890
`);
    expect(read.proxyUrl).toBeNull();
    expect(read.detail).toBe("系统代理没有开");
  });

  it("reads the macOS HTTPS system proxy", () => {
    const read = parseMacScutilProxy(`
<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7891
  ExceptionsList : <array> {
    0 : localhost
    1 : *.local
  }
}
`);
    expect(read.proxyUrl).toBe("http://127.0.0.1:7891");
    expect(read.noProxy).toBe("localhost,*.local");
  });
});

describe("proxyUrlForServerRequest", () => {
  it("keeps loopback and a refused reclaude port off the server dispatcher", () => {
    const custom = resolveGlobalRoute(
      settings({ line: "custom", proxyUrl: "http://127.0.0.1:7890", noProxy: "npmjs.org" }),
      emptySystem,
    );
    expect(proxyUrlForServerRequest("registry.npmjs.org", custom)).toBeNull();
    expect(proxyUrlForServerRequest("github.com", custom)).toBe("http://127.0.0.1:7890");
    expect(proxyUrlForServerRequest("api.x.ai", custom)).toBe("http://127.0.0.1:7890");
    expect(proxyUrlForServerRequest("127.0.0.1", custom)).toBeNull();
    const refused = resolveGlobalRoute(
      settings({ line: "custom", proxyUrl: "http://127.0.0.1:56879" }),
      emptySystem,
    );
    expect(proxyUrlForServerRequest("api.anthropic.com", refused)).toBeNull();
    expect(refused.source).toBe("rejected");
  });
});
