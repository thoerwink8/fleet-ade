import { describe, expect, it } from "vite-plus/test";

import { effectiveRouteSentence, proxyUrlError } from "./NetworkSettings.logic";

describe("effectiveRouteSentence", () => {
  it("says the chosen direct line once", () => {
    expect(effectiveRouteSentence({ proxyUrl: null, source: "direct", detail: "直连" })).toBe(
      "当前走直连，因为你把线路设成了直连。",
    );
  });

  it("names the system proxy address and where it came from", () => {
    expect(
      effectiveRouteSentence({
        proxyUrl: "http://127.0.0.1:7890",
        source: "system",
        detail: "来自系统代理",
      }),
    ).toBe("当前走 http://127.0.0.1:7890，来源是系统代理。");
  });

  it("names a custom address as something you typed", () => {
    expect(
      effectiveRouteSentence({
        proxyUrl: "http://127.0.0.1:7890",
        source: "custom",
        detail: "指定地址",
      }),
    ).toBe("当前走 http://127.0.0.1:7890，来源是你填的代理地址。");
  });

  it("keeps the reason when direct is a fallback", () => {
    expect(
      effectiveRouteSentence({
        proxyUrl: null,
        source: "unavailable",
        detail: "读不到系统代理，按直连",
      }),
    ).toBe("当前走直连，因为读不到系统代理。");
    expect(
      effectiveRouteSentence({
        proxyUrl: null,
        source: "direct",
        detail: "系统代理没有开",
      }),
    ).toBe("当前走直连，因为系统代理没有开。");
    expect(
      effectiveRouteSentence({
        proxyUrl: null,
        source: "rejected",
        detail: "56879 是 reclaude 专用端口，不拿来做线路，已按直连",
      }),
    ).toBe("当前走直连，因为 56879 是 reclaude 专用端口，不拿来做线路。");
  });
});

describe("proxyUrlError", () => {
  const reason = "地址要写成 http://主机:端口";

  it.each([
    "",
    "   ",
    "http://127.0.0.1:7890",
    "https://proxy.example.com:8443",
    "127.0.0.1:7890",
    "proxy.example.com:1080",
    "http://[::1]:8080",
    // The server treats a scheme-less //host:port as http, so the client must too.
    "//127.0.0.1:7890",
  ])("accepts %s", (input) => {
    expect(proxyUrlError(input)).toBeNull();
  });

  it.each([
    "not a url",
    "http://127.0.0.1",
    "http://127.0.0.1:",
    "socks5://127.0.0.1:1080",
    "http://user:pass@127.0.0.1:7890",
    "http://user@127.0.0.1:7890",
    "ftp://example.com:21",
  ])("rejects %s with the format reason", (input) => {
    expect(proxyUrlError(input)).toBe(reason);
  });
});
