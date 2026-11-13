import type { SDKModel } from "@cursor/sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { CursorSettings } from "../settings.ts";
import { CursorSettings as CursorSettingsSchema } from "../settings.ts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildCursorCapabilitiesFromSdkModel,
  buildCursorDiscoveredModelsFromSdk,
  buildCursorProviderSnapshot,
  checkCursorProviderStatus,
} from "./status.ts";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";
import { loadCursorSdk } from "./sdk.ts";

const { CursorSdkError } = loadCursorSdk();

const decodeCursorSettings = Schema.decodeSync(CursorSettingsSchema);

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string, currentValue?: boolean) {
  return {
    id,
    label,
    type: "boolean" as const,
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}

const baseCursorSettings: CursorSettings = decodeCursorSettings({
  enabled: true,
  customModels: [],
});

const sdkParameterizedModel = {
  id: "claude-opus-4-8",
  displayName: "Opus 4.8",
  parameters: [
    {
      id: "thinking",
      displayName: "Thinking",
      values: [{ value: "false" }, { value: "true" }],
    },
    {
      id: "context",
      displayName: "Context",
      values: [
        { value: "300k", displayName: "300K" },
        { value: "1m", displayName: "1M" },
      ],
    },
    {
      id: "effort",
      displayName: "Effort",
      values: [
        { value: "low", displayName: "Low" },
        { value: "high", displayName: "High" },
      ],
    },
    {
      id: "fast",
      displayName: "Fast",
      values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
    },
  ],
  variants: [
    {
      displayName: "Opus 4.8",
      isDefault: true,
      params: [
        { id: "thinking", value: "true" },
        { id: "context", value: "1m" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
  ],
} satisfies SDKModel;

describe("buildCursorProviderSnapshot", () => {
  it("downgrades ready status to warning when SDK model discovery returns no models", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: baseCursorSettings,
        parsed: {
          version: null,
          status: "ready",
          auth: { status: "authenticated", type: "api-key", label: "Cursor API 密钥" },
        },
        discoveryWarning: "Cursor SDK 没有返回内置模型。",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Cursor SDK 没有返回内置模型。",
      models: [],
      supportsConversationRollback: false,
    });
  });
});

describe("Cursor SDK model discovery", () => {
  it("maps native SDK parameter ids and default variant values to model capabilities", () => {
    expect(buildCursorCapabilitiesFromSdkModel(sdkParameterizedModel)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("effort", "Effort", [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ]),
          selectDescriptor("contextWindow", "Context", [
            { id: "300k", label: "300K" },
            { id: "1m", label: "1M", isDefault: true },
          ]),
          booleanDescriptor("fastMode", "Fast", false),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });

  it("filters invalid and duplicate SDK model entries", () => {
    expect(
      buildCursorDiscoveredModelsFromSdk([
        sdkParameterizedModel,
        { ...sdkParameterizedModel, displayName: "Duplicate" },
        { id: "", displayName: "Invalid" },
      ]),
    ).toEqual([
      {
        slug: "claude-opus-4-8",
        name: "Opus 4.8",
        isCustom: false,
        capabilities: buildCursorCapabilitiesFromSdkModel(sdkParameterizedModel),
      },
    ]);
  });
});

describe("checkCursorProviderStatus", () => {
  it.effect("uses the SDK catalog when CURSOR_API_KEY is configured", () =>
    Effect.gen(function* () {
      const provider = yield* checkCursorProviderStatus(
        {
          ...baseCursorSettings,
          customModels: ["internal/cursor-model"],
        },
        { CURSOR_API_KEY: "test-cursor-key" },
      ).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest((apiKey) => {
            expect(apiKey).toBe("test-cursor-key");
            return Effect.succeed({
              user: {
                apiKeyName: "test-key",
                userEmail: "cursor@example.com",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              models: [sdkParameterizedModel],
            });
          }),
        ),
      );

      expect(provider).toMatchObject({
        status: "ready",
        auth: {
          status: "authenticated",
          type: "api-key",
          label: "Cursor API 密钥 (test-key)",
          email: "cursor@example.com",
        },
        models: [
          { slug: "claude-opus-4-8", isCustom: false },
          { slug: "internal/cursor-model", isCustom: true },
        ],
      });
    }),
  );

  it.effect("allows slow SDK discovery with a configured readiness timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* checkCursorProviderStatus(baseCursorSettings, {
        CURSOR_API_KEY: "test-key",
        T3CODE_CURSOR_PROBE_TIMEOUT_MS: "30000",
      }).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest(() =>
            Effect.sleep("20 seconds").pipe(
              Effect.as({
                user: {
                  apiKeyName: "test",
                  userEmail: "cursor@example.com",
                  createdAt: "2026-01-01",
                },
                models: [sdkParameterizedModel],
              }),
            ),
          ),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("20 seconds");
      expect((yield* Fiber.join(fiber)).status).toBe("ready");
    }),
  );

  it.effect("surfaces SDK authentication failures", () =>
    Effect.gen(function* () {
      const provider = yield* checkCursorProviderStatus(baseCursorSettings, {
        CURSOR_API_KEY: "invalid-test-key",
      }).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest(() =>
            Effect.fail(
              new CursorSdkCatalog.CursorSdkCatalogError({
                authenticationFailure: true,
                cause: new Error("unauthorized"),
              }),
            ),
          ),
        ),
      );

      expect(provider).toMatchObject({
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor SDK 身份验证失败。请检查 CURSOR_API_KEY。",
      });
    }),
  );

  it.effect.each([
    {
      authenticationType: "browser" as const,
      message: "在 T3 Code 中运行 Cursor 需要付费方案。请升级此账号，或改用其他账号登录。",
    },
    {
      authenticationType: "api-key" as const,
      message:
        "在 T3 Code 中运行 Cursor 需要付费方案。请升级 CURSOR_API_KEY 所属账号，或改用付费账号的密钥。",
    },
  ])(
    "explains a rejected plan for $authenticationType authentication",
    ({ authenticationType, message }) =>
      Effect.gen(function* () {
        const provider = yield* checkCursorProviderStatus(
          baseCursorSettings,
          { CURSOR_API_KEY: "free-plan-key" },
          authenticationType,
        ).pipe(
          Effect.provide(
            CursorSdkCatalog.layerTest(() =>
              Effect.fail(
                new CursorSdkCatalog.CursorSdkCatalogError({
                  authenticationFailure: false,
                  code: "plan_required",
                  cause: new CursorSdkError(
                    "[plan_required] Cloud Agent is not available for free users. Please upgrade to Pro.",
                    { code: "plan_required", status: 403 },
                  ),
                }),
              ),
            ),
          ),
        );

        expect(provider).toMatchObject({
          status: "error",
          auth: { status: "unknown" },
          message,
        });
      }),
  );

  it.effect.each([
    {
      name: "keeps models when /v1/me is blocked",
      meFailure: new CursorSdkError("[feature_unavailable] Not available for this team.", {
        code: "feature_unavailable",
        status: 403,
      }),
      expected: {
        status: "ready",
        auth: { status: "authenticated", type: "api-key", label: "Cursor API 密钥" },
        models: [{ slug: "claude-opus-4-8", isCustom: false }],
      },
    },
    {
      name: "keeps models when /v1/me returns a 403 without a code",
      meFailure: new CursorSdkError("[unknown] Forbidden", { code: "unknown", status: 403 }),
      expected: {
        status: "ready",
        auth: { status: "authenticated", type: "api-key", label: "Cursor API 密钥" },
        models: [{ slug: "claude-opus-4-8", isCustom: false }],
      },
    },
    {
      name: "keeps the paid-plan message when /v1/me returns plan_required",
      meFailure: new CursorSdkError("[plan_required] Not available for free users.", {
        code: "plan_required",
        status: 403,
      }),
      expected: {
        status: "error",
        auth: { status: "unknown" },
        message:
          "在 T3 Code 中运行 Cursor 需要付费方案。请升级 CURSOR_API_KEY 所属账号，或改用付费账号的密钥。",
      },
    },
    {
      name: "fails when /v1/me has a server error",
      meFailure: new CursorSdkError("[unknown] Service unavailable", {
        code: "unknown",
        status: 503,
      }),
      expected: {
        status: "error",
        auth: { status: "unknown" },
        message: "Cursor SDK 模型目录请求失败。请查看服务器日志。",
      },
    },
    {
      name: "rejects a 401 even when its code is feature_unavailable",
      meFailure: new CursorSdkError("Unauthorized", {
        code: "feature_unavailable",
        status: 401,
      }),
      expected: {
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor SDK 身份验证失败。请检查 CURSOR_API_KEY。",
      },
    },
    {
      name: "fails a key that /v1/me rejects",
      meFailure: new CursorSdkError("Unauthorized", { status: 401 }),
      expected: {
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor SDK 身份验证失败。请检查 CURSOR_API_KEY。",
      },
    },
  ])("$name", ({ meFailure, expected }) =>
    Effect.gen(function* () {
      const catalog = yield* CursorSdkCatalog.makeCursorSdkCatalog({
        readUser: () =>
          Effect.fail(
            new CursorSdkCatalog.CursorSdkCatalogError({
              authenticationFailure: meFailure.status === 401,
              ...(meFailure.status === undefined ? {} : { status: meFailure.status }),
              ...(meFailure.code === undefined ? {} : { code: meFailure.code }),
              cause: meFailure,
            }),
          ),
        readModels: () => Effect.succeed([sdkParameterizedModel]),
      });
      const provider = yield* checkCursorProviderStatus(baseCursorSettings, {
        CURSOR_API_KEY: "enterprise-key",
      }).pipe(Effect.provideService(CursorSdkCatalog.CursorSdkCatalog, catalog));

      expect(provider).toMatchObject(expected);
    }),
  );

  it.effect("does not report a single slow catalog read as a provider error", () =>
    Effect.gen(function* () {
      let reads = 0;
      const fiber = yield* checkCursorProviderStatus(baseCursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      }).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest(() => {
            reads += 1;
            return reads === 1
              ? Effect.never
              : Effect.succeed({
                  user: {
                    apiKeyName: "test-key",
                    userEmail: "cursor@example.com",
                    createdAt: "2026-01-01T00:00:00.000Z",
                  },
                  models: [sdkParameterizedModel],
                });
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 minute");
      const provider = yield* Fiber.join(fiber);

      expect(provider.status).not.toBe("error");
    }),
  );

  it.effect("requires a Cursor API key without probing any external Cursor binary", () =>
    Effect.gen(function* () {
      const provider = yield* checkCursorProviderStatus(baseCursorSettings).pipe(
        Effect.provide(
          CursorSdkCatalog.layerTest(() =>
            Effect.die("SDK catalog must not be used without CURSOR_API_KEY"),
          ),
        ),
      );

      expect(provider).toMatchObject({
        installed: true,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "请使用 Cursor 登录，或在提供方设置中添加 CURSOR_API_KEY。",
      });
    }),
  );
});
