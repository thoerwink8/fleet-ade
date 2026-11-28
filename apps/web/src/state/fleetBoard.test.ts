import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ensureFleetBoard, mintFleetBoardTicket } from "./fleetBoard";

const connection = { httpBaseUrl: "http://127.0.0.1:4001", authorization: null };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fleet board requests", () => {
  it("decodes the server's wire result, including the failed launch detail", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        status: "failed",
        detail: "健康检查没通过",
        checkedAt: "2026-11-29T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureFleetBoard(connection)).resolves.toEqual({
      status: "failed",
      detail: "健康检查没通过",
      checkedAt: "2026-11-29T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4001/api/fleet-board/ensure",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("shares one in-flight ensure between concurrent mounts of the same connection", async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal("fetch", fetchMock);

    const first = ensureFleetBoard(connection);
    const second = ensureFleetBoard(connection);
    resolveResponse(
      jsonResponse({ status: "running", detail: null, checkedAt: "2026-11-29T00:00:00.000Z" }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "running", detail: null, checkedAt: "2026-11-29T00:00:00.000Z" },
      { status: "running", detail: null, checkedAt: "2026-11-29T00:00:00.000Z" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("decodes the redacted ticket and ISO expiry from the mint endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ticket: "abc.def", expiresAt: "2026-11-29T00:05:00.000Z" })),
    );

    await expect(
      mintFleetBoardTicket({ ...connection, authorization: "session-token" }),
    ).resolves.toEqual({
      token: "abc.def",
      expiresAtEpochMs: Date.parse("2026-11-29T00:05:00.000Z"),
    });
  });

  it("maps an HTTP rejection instead of treating its body as a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );

    await expect(mintFleetBoardTicket(connection)).resolves.toEqual({ _tag: "http", status: 403 });
  });
});
