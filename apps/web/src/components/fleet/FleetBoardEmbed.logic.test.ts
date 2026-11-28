import { describe, expect, it } from "vite-plus/test";

import {
  FLEET_BOARD_TICKET_RENEWAL_LEAD_MS,
  FLEET_BOARD_TICKET_TTL_MS,
  fleetBoardEmbedUrl,
  fleetBoardRenewalDelayMs,
  resolveFleetBoardEmbed,
} from "./FleetBoardEmbed.logic";

describe("fleetBoardEmbedUrl", () => {
  it("cookie-authenticated connections embed the bare proxied path relative to the app", () => {
    expect(
      fleetBoardEmbedUrl({
        httpBaseUrl: "http://127.0.0.1:4001",
        appOrigin: "http://localhost:4000",
        authorization: null,
      }),
    ).toEqual({ kind: "cookie", src: "/fleet-board/" });
  });

  it("token-authenticated connections carry the ticket in the path of the environment origin", () => {
    expect(
      fleetBoardEmbedUrl({
        httpBaseUrl: "http://192.168.1.5:4100",
        appOrigin: "https://app.t3.codes",
        authorization: "token",
        ticket: { token: "abc.def", expiresAtEpochMs: 0 },
      }),
    ).toEqual({
      kind: "ticket",
      src: "http://192.168.1.5:4100/fleet-board/t/abc.def/",
    });
  });

  it("trailing slashes on the base url never double the prefix separator", () => {
    expect(
      fleetBoardEmbedUrl({
        httpBaseUrl: "http://192.168.1.5:4100/",
        appOrigin: "https://app.t3.codes",
        authorization: "token",
        ticket: { token: "abc.def", expiresAtEpochMs: 0 },
      }),
    ).toEqual({
      kind: "ticket",
      src: "http://192.168.1.5:4100/fleet-board/t/abc.def/",
    });
  });

  it("a token-authenticated iframe without a minted ticket is not a usable source", () => {
    expect(
      fleetBoardEmbedUrl({
        httpBaseUrl: "http://192.168.1.5:4100",
        appOrigin: "https://app.t3.codes",
        authorization: "token",
      }),
    ).toBeNull();
  });
});

describe("fleetBoardRenewalDelayMs", () => {
  it("renews a lead time before the ticket TTL expires", () => {
    const mintedAt = 1_000_000;
    const expiresAt = mintedAt + FLEET_BOARD_TICKET_TTL_MS;
    expect(fleetBoardRenewalDelayMs({ expiresAtEpochMs: expiresAt, nowEpochMs: mintedAt })).toBe(
      FLEET_BOARD_TICKET_TTL_MS - FLEET_BOARD_TICKET_RENEWAL_LEAD_MS,
    );
  });

  it("never schedules in the past when the ticket is already near expiry", () => {
    expect(fleetBoardRenewalDelayMs({ expiresAtEpochMs: 100, nowEpochMs: 1_000_000 })).toBe(0);
  });
});

describe("resolveFleetBoardEmbed", () => {
  it("running ensure yields the embed for a cookie connection", () => {
    expect(
      resolveFleetBoardEmbed(
        { status: "running", detail: null, checkedAt: "2026-11-29T00:00:00.000Z" },
        {
          httpBaseUrl: "http://127.0.0.1:4001",
          appOrigin: "http://localhost:4000",
          authorization: null,
        },
      ),
    ).toEqual({ kind: "ready", src: "/fleet-board/" });
  });

  it.each(["not-installed", "port-taken", "failed"] as const)(
    "the server-reported %s status drives its own state page with the detail text",
    (status) => {
      const resolved = resolveFleetBoardEmbed(
        { status, detail: "怎么修", checkedAt: "2026-11-29T00:00:00.000Z" },
        {
          httpBaseUrl: "http://127.0.0.1:4001",
          appOrigin: "http://localhost:4000",
          authorization: null,
        },
      );
      expect(resolved).toEqual({ kind: "unavailable", status, detail: "怎么修" });
    },
  );

  it("a running board on a token connection waits for its ticket", () => {
    expect(
      resolveFleetBoardEmbed(
        { status: "running", detail: null, checkedAt: "2026-11-29T00:00:00.000Z" },
        {
          httpBaseUrl: "http://192.168.1.5:4100",
          appOrigin: "https://app.t3.codes",
          authorization: "token",
        },
      ),
    ).toEqual({ kind: "needs-ticket" });
  });
});
