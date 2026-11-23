import { describe, expect, it } from "@effect/vitest";

import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import {
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
} from "../rpc/http.ts";

describe("mapRemoteEnvironmentError", () => {
  it("blocks an invalid credential with the server's trace id", () => {
    const mapped = mapRemoteEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-1",
      }),
    );
    expect(mapped).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
      traceId: "trace-1",
      hop: "server",
    });
  });

  it("blocks a scope refusal as a permission problem", () => {
    const mapped = mapRemoteEnvironmentError(
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId: "trace-2",
      }),
    );
    expect(mapped).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "permission",
      traceId: "trace-2",
      hop: "server",
    });
  });

  it.each([
    new RemoteEnvironmentAuthFetchError({
      message: "Failed to fetch remote environment endpoint.",
      cause: new TypeError("Failed to fetch"),
    }),
    new RemoteEnvironmentAuthTimeoutError({
      requestUrl: "https://environment.example.test",
      timeoutMs: 10_000,
    }),
  ])("maps $error._tag to a transient error", (error) => {
    const mapped = mapRemoteEnvironmentError(error);
    expect(mapped).toMatchObject({
      _tag: "ConnectionTransientError",
      detail: error.message,
      hop: "server",
    });
  });
});
