import { ProviderDriverKind } from "@t3tools/contracts";
import * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect, it } from "vite-plus/test";

import { classifyAcpFailure } from "./adapter.ts";

describe("classifyAcpFailure", () => {
  it("maps -32000 and 401/unauthorized ACP request errors to non-retryable auth_error", () => {
    expect(
      classifyAcpFailure(
        new EffectAcpErrors.AcpRequestError({
          method: "session/prompt",
          code: -32000,
          errorMessage: "Authentication required",
        }),
      ),
    ).toEqual({
      class: "auth_error",
      requiresSignIn: true,
      notInstalled: false,
      retryable: false,
    });

    expect(
      classifyAcpFailure(
        new EffectAcpErrors.AcpRequestError({
          method: "session/prompt",
          code: -32603,
          errorMessage: "API error: 401 Unauthorized (invalid_api_key)",
        }),
      ),
    ).toEqual({
      class: "auth_error",
      requiresSignIn: true,
      notInstalled: false,
      retryable: false,
    });
  });

  it("maps 403 and permission errors to non-retryable permission_error instead of auth_error", () => {
    expect(
      classifyAcpFailure(
        new EffectAcpErrors.AcpRequestError({
          method: "session/prompt",
          code: -32603,
          errorMessage: "HTTP 403 Forbidden: model access denied",
        }),
      ),
    ).toEqual({
      class: "permission_error",
      requiresSignIn: false,
      notInstalled: false,
      retryable: false,
    });
  });

  it("maps ENOENT and transport errors accurately and honors flavor hooks", () => {
    expect(
      classifyAcpFailure(Object.assign(new Error("spawn acp ENOENT"), { code: "ENOENT" })),
    ).toEqual({
      class: "not_installed",
      requiresSignIn: false,
      notInstalled: true,
      retryable: false,
    });

    expect(
      classifyAcpFailure(
        new EffectAcpErrors.AcpTransportError({
          detail: "connection reset by peer",
          cause: undefined,
        }),
      ),
    ).toEqual({
      class: "transport_error",
      requiresSignIn: false,
      notInstalled: false,
      retryable: true,
    });

    expect(
      classifyAcpFailure(new Error("custom missing runtime"), {
        notInstalled: (cause) =>
          cause instanceof Error && cause.message.includes("missing runtime"),
      }),
    ).toEqual({
      class: "not_installed",
      requiresSignIn: false,
      notInstalled: true,
      retryable: false,
    });

    expect(
      classifyAcpFailure(new Error("unexpected internal failure"), {
        requiresSignIn: () => false,
        notInstalled: () => false,
      }),
    ).toEqual({
      class: "provider_error",
      requiresSignIn: false,
      notInstalled: false,
    });
  });

  it("never confuses flavor driver metadata when unknown", () => {
    void ProviderDriverKind.make("acpRegistry");
    expect(classifyAcpFailure("random string failure")).toEqual({
      class: "provider_error",
      requiresSignIn: false,
      notInstalled: false,
    });
  });
});
