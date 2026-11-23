import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveDesktopPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs", () => {
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
    expect(
      resolveDesktopPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE"),
    ).toBe("https://host.tailnet.example.ts.net:3773/pair#token=PAIRCODE");
  });
});
