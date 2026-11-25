import {
  EnvironmentAuthInvalidError,
  type AuthBrowserSessionResult,
  type AuthCreatePairingCredentialInput,
  type AuthSessionState,
  type DesktopBridge,
} from "@t3tools/contracts";
import { createBrowserHistory } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installEnvironmentHttpTest } from "../test/environmentHttpTest";
import { __setPrimaryHttpRunnerForTests } from "./lib/runtime";

type TestWindow = {
  location: URL;
  history: {
    state: unknown;
    replaceState: (_data: unknown, _unused: string, url?: string) => void;
  };
  desktopBridge?: DesktopBridge;
  sessionStorage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  };
};

const LOOPBACK_AUTH = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
} as const;

const DESKTOP_AUTH = {
  policy: "desktop-managed-local",
  bootstrapMethods: ["desktop-bootstrap"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
} as const;

const SESSION_EXPIRES_AT = DateTime.makeUnsafe("2026-04-05T00:00:00.000Z");
const unauthenticatedSession = (auth: AuthSessionState["auth"]): AuthSessionState => ({
  authenticated: false,
  auth,
});

const authenticatedSession = (auth: AuthSessionState["auth"]): AuthSessionState => ({
  authenticated: true,
  auth,
  sessionMethod: "browser-session-cookie",
  expiresAt: SESSION_EXPIRES_AT,
});

const browserSession = (scopes: AuthBrowserSessionResult["scopes"]): AuthBrowserSessionResult => ({
  authenticated: true,
  scopes,
  sessionMethod: "browser-session-cookie",
  expiresAt: SESSION_EXPIRES_AT,
});

function installTestBrowser(url: string) {
  const testWindow: TestWindow = {
    location: new URL(url),
    history: {
      state: null,
      replaceState: (data, _unused, nextUrl) => {
        testWindow.history.state = data;
        if (nextUrl !== undefined) {
          testWindow.location = new URL(nextUrl, testWindow.location.href);
        }
      },
    },
    sessionStorage: (() => {
      const entries = new Map<string, string>();
      return {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => void entries.set(key, value),
        removeItem: (key: string) => void entries.delete(key),
      };
    })(),
  };

  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "Fleet ADE" });

  return testWindow;
}

function sequence<A>(...values: ReadonlyArray<A>) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function createSignal() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let disposeHttpTest: (() => Promise<void>) | undefined;

async function installAuthApi(input: {
  readonly session?: () => AuthSessionState;
  readonly browserSession?: (
    credential: string,
  ) => Effect.Effect<AuthBrowserSessionResult, EnvironmentAuthInvalidError>;
  readonly pairingCredential?: (payload: AuthCreatePairingCredentialInput) => Effect.Effect<{
    readonly id: string;
    readonly credential: string;
    readonly label?: string;
    readonly expiresAt: DateTime.Utc;
  }>;
}) {
  const testApi = await installEnvironmentHttpTest({
    ...(input.session ? { session: () => Effect.succeed(input.session!()) } : {}),
    ...(input.browserSession
      ? { browserSession: (payload) => input.browserSession!(payload.credential) }
      : {}),
    ...(input.pairingCredential
      ? { pairingCredential: (payload) => input.pairingCredential!(payload) }
      : {}),
  });
  disposeHttpTest = testApi.dispose;
  return testApi;
}

describe("resolveInitialServerAuthGateState", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    await disposeHttpTest?.();
    disposeHttpTest = undefined;
    const { __resetServerAuthBootstrapForTests } = await import("./environments/primary");
    __resetServerAuthBootstrapForTests();
    __setPrimaryHttpRunnerForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reuses an in-flight silent bootstrap attempt", async () => {
    const nextSession = sequence(
      unauthenticatedSession(DESKTOP_AUTH),
      authenticatedSession(DESKTOP_AUTH),
    );
    const testApi = await installAuthApi({
      session: nextSession,
      browserSession: () => Effect.succeed(browserSession(["orchestration:read", "access:write"])),
    });

    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstraps: () => [
        {
          id: "primary",
          label: "Windows",
          httpBaseUrl: "http://localhost:3773",
          wsBaseUrl: "ws://localhost:3773",
          bootstrapToken: "desktop-bootstrap-token",
        },
      ],
    } as unknown as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await Promise.all([resolveInitialServerAuthGateState(), resolveInitialServerAuthGateState()]);

    expect(testApi.calls.session).toBe(2);
    expect(testApi.calls.browserSession).toEqual([{ credential: "desktop-bootstrap-token" }]);
  });

  it("takes a pairing token from the location hash and strips it immediately", async () => {
    const testWindow = installTestBrowser("http://localhost/#token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./environments/primary");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.hash).toBe("");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it.each([
    { suffix: "#token=replacement-token", cached: false },
    { suffix: "#token=replacement-token", cached: true },
    { suffix: "?token=replacement-token", cached: true },
    { suffix: "/#token=replacement-token", cached: true },
  ])(
    "re-pairs an authenticated browser with $suffix when cached=$cached",
    async ({ suffix, cached }) => {
      let scopes: AuthBrowserSessionResult["scopes"] = ["orchestration:read"];
      const testApi = await installAuthApi({
        session: () => ({ ...authenticatedSession(LOOPBACK_AUTH), scopes }),
        browserSession: () =>
          Effect.sync(() => {
            scopes = ["orchestration:read", "orchestration:operate"];
            return browserSession(scopes);
          }),
      });
      const testWindow = installTestBrowser("http://localhost/");
      const {
        resolveInitialServerAuthGateState,
        submitServerAuthCredential,
        takePairingTokenFromUrl,
      } = await import("./environments/primary");
      const { fetchSessionState } = await import("./environments/primary/auth");

      if (cached) {
        await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
          status: "authenticated",
        });
      }

      testWindow.location = new URL(`http://localhost/pair${suffix}`);
      await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
        status: "requires-auth",
        auth: LOOPBACK_AUTH,
      });
      expect(testApi.calls.browserSession).toEqual([]);

      const token = takePairingTokenFromUrl();
      expect(token).toBe("replacement-token");
      await submitServerAuthCredential(token!);

      expect(testApi.calls.browserSession).toEqual([{ credential: "replacement-token" }]);
      await expect(fetchSessionState()).resolves.toMatchObject({
        authenticated: true,
        scopes: ["orchestration:read", "orchestration:operate"],
      });
      await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
        status: "authenticated",
      });
    },
  );

  it.each([false, true])(
    "restores an authenticated browser after a rejected replacement when cached=%s",
    async (cached) => {
      const existingSession = {
        ...authenticatedSession(LOOPBACK_AUTH),
        scopes: ["orchestration:read"] as const,
      };
      const exchangeStarted = createSignal();
      const finishExchange = createSignal();
      const testApi = await installAuthApi({
        session: () => existingSession,
        browserSession: () =>
          Effect.gen(function* () {
            exchangeStarted.resolve();
            yield* Effect.promise(() => finishExchange.promise);
            return yield* new EnvironmentAuthInvalidError({
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: "trace-invalid-replacement",
            });
          }),
      });
      const testWindow = installTestBrowser("http://localhost/");
      const {
        resolveInitialServerAuthGateState,
        submitServerAuthCredential,
        takePairingRecoveryNotice,
        takePairingTokenFromUrl,
      } = await import("./environments/primary");
      const { fetchSessionState } = await import("./environments/primary/auth");
      if (cached) {
        await resolveInitialServerAuthGateState();
      }
      testWindow.location = new URL("http://localhost/pair#token=invalid-replacement");
      const history = createBrowserHistory({
        window: {
          get location() {
            return testWindow.location;
          },
          history: testWindow.history,
          addEventListener() {},
          removeEventListener() {},
        },
      });
      const gateLoads: Array<ReturnType<typeof resolveInitialServerAuthGateState>> = [];
      const unsubscribe = history.subscribe(() => {
        gateLoads.push(resolveInitialServerAuthGateState());
      });
      try {
        const requiresAuth = { status: "requires-auth", auth: LOOPBACK_AUTH };
        await expect(resolveInitialServerAuthGateState()).resolves.toEqual(requiresAuth);

        // Token removal synchronously reloads the TanStack auth gate via replaceState.
        const token = takePairingTokenFromUrl();
        expect(gateLoads).toHaveLength(1);
        await expect(gateLoads[0]).resolves.toEqual(requiresAuth);
        const submitted = submitServerAuthCredential(token!);
        await exchangeStarted.promise;
        await expect(resolveInitialServerAuthGateState()).resolves.toEqual(requiresAuth);
        finishExchange.resolve();
        await submitted;
        await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
          status: "authenticated",
        });
        expect(takePairingRecoveryNotice()).toBe("这台浏览器已经连着，配对链接用过了也没关系。");
        expect(takePairingRecoveryNotice()).toBeNull();
        expect(testApi.calls.browserSession).toEqual([{ credential: "invalid-replacement" }]);
        await expect(fetchSessionState()).resolves.toEqual(existingSession);

        testWindow.history.replaceState({}, "", "/");
        await expect(gateLoads[1]).resolves.toEqual({ status: "authenticated" });
        testWindow.history.replaceState({}, "", "/pair");
        await expect(gateLoads[2]).resolves.toEqual({ status: "authenticated" });
      } finally {
        finishExchange.resolve();
        unsubscribe();
        history.destroy();
      }
    },
  );

  it("makes later callers wait for a URL token that arrives during bootstrap", async () => {
    let releaseExchange!: () => void;
    const exchangeRelease = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });
    const nextSession = sequence(
      authenticatedSession(LOOPBACK_AUTH),
      authenticatedSession(LOOPBACK_AUTH),
    );
    const testApi = await installAuthApi({
      session: nextSession,
      browserSession: () => {
        markExchangeStarted();
        return Effect.promise(() => exchangeRelease).pipe(
          Effect.andThen(
            Effect.fail(
              new EnvironmentAuthInvalidError({
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "trace-rejected-queued-credential",
              }),
            ),
          ),
        );
      },
    });
    const testWindow = installTestBrowser("http://localhost/");
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const initialBootstrap = resolveInitialServerAuthGateState();
    testWindow.location = new URL("http://localhost/#token=reusable-token");
    const explicitPairing = resolveInitialServerAuthGateState();
    const laterCaller = resolveInitialServerAuthGateState();
    let laterCallerSettled = false;
    void laterCaller.then(() => {
      laterCallerSettled = true;
    });

    try {
      await expect(initialBootstrap).resolves.toEqual({ status: "authenticated" });
      await exchangeStarted;
      expect(laterCallerSettled).toBe(false);
    } finally {
      releaseExchange();
    }

    const recoveredState = { status: "authenticated" } as const;
    await expect(explicitPairing).resolves.toEqual(recoveredState);
    await expect(laterCaller).resolves.toEqual(recoveredState);
    expect(testApi.calls.browserSession).toEqual([{ credential: "reusable-token" }]);
    expect(testApi.calls.session).toBe(2);
  });

  it("recovers an authenticated browser when a URL token is rejected", async () => {
    const cause = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-invalid-url-credential",
    });
    const nextSession = sequence(
      authenticatedSession(LOOPBACK_AUTH),
      unauthenticatedSession(LOOPBACK_AUTH),
    );
    const testApi = await installAuthApi({
      session: nextSession,
      browserSession: () => Effect.fail(cause),
    });
    installTestBrowser("http://localhost/#token=rejected-token");
    const { resolveInitialServerAuthGateState, takePairingRecoveryNotice } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(takePairingRecoveryNotice()).toBe("这台浏览器已经连着，配对链接用过了也没关系。");
    expect(testApi.calls.browserSession).toEqual([{ credential: "rejected-token" }]);
  });

  it("recovers an authenticated browser onto the app after a dead URL token", async () => {
    const cause = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      credentialFailureReason: "consumed",
      traceId: "trace-consumed-url-credential",
    });
    const testApi = await installAuthApi({
      session: () => authenticatedSession(LOOPBACK_AUTH),
      browserSession: () => Effect.fail(cause),
    });
    installTestBrowser("http://localhost/#token=consumed-token");
    const { resolveInitialServerAuthGateState, takePairingRecoveryNotice } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(takePairingRecoveryNotice()).toBe("这台浏览器已经连着，配对链接用过了也没关系。");
    expect(testApi.calls.browserSession).toEqual([{ credential: "consumed-token" }]);
  });

  it("still rejects a dead credential when no session is valid", async () => {
    const cause = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      credentialFailureReason: "expired",
      traceId: "trace-expired-credential",
    });
    await installAuthApi({
      session: () => unauthenticatedSession(LOOPBACK_AUTH),
      browserSession: () => Effect.fail(cause),
    });
    installTestBrowser("http://localhost/pair#token=expired-token");
    const { submitServerAuthCredential, takePairingRecoveryNotice, takePairingTokenFromUrl } =
      await import("./environments/primary");

    await expect(submitServerAuthCredential(takePairingTokenFromUrl()!)).rejects.toMatchObject({
      _tag: "PrimaryEnvironmentPairingCredentialRejectedError",
      credentialFailureReason: "expired",
      message:
        "这个配对码已过期。在这台电脑的 设置 → 连接 里点「创建链接」，或在这台电脑上运行 t3 pair。",
    });
    expect(takePairingRecoveryNotice()).toBeNull();
  });

  it("describes transport failures as a connectivity problem", async () => {
    const { describePairingSubmitError, PrimaryEnvironmentRequestError } =
      await import("./environments/primary");
    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "exchange-bootstrap-credential",
      cause: new TypeError("fetch failed"),
    });
    expect(describePairingSubmitError(error)).toBe(
      "连不上这台电脑。检查网络，或确认这台电脑上的服务还在运行，再重试。",
    );
  });

  it("keeps a structured server error as the submit failure", async () => {
    const { describePairingSubmitError, PrimaryEnvironmentRequestError } =
      await import("./environments/primary");
    const { EnvironmentInternalError } = await import("@t3tools/contracts");
    const cause = new EnvironmentInternalError({
      code: "internal_error",
      reason: "browser_session_issuance_failed",
      traceId: "trace-server-error",
    });
    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "exchange-bootstrap-credential",
      cause,
    });
    expect(describePairingSubmitError(error)).toBe(
      "后台服务在 exchange-bootstrap-credential 期间请求失败（HTTP 500）。",
    );
  });

  it("does not recover onto a valid session when the exchange fails without a rejection", async () => {
    const cause = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "missing_credential",
      traceId: "trace-missing-credential",
    });
    await installAuthApi({
      session: () => authenticatedSession(LOOPBACK_AUTH),
      browserSession: () => Effect.fail(cause),
    });
    installTestBrowser("http://localhost/pair#token=unreachable-token");
    const { submitServerAuthCredential, takePairingRecoveryNotice, takePairingTokenFromUrl } =
      await import("./environments/primary");

    await expect(submitServerAuthCredential(takePairingTokenFromUrl()!)).rejects.toMatchObject({
      _tag: "PrimaryEnvironmentRequestError",
    });
    expect(takePairingRecoveryNotice()).toBeNull();
  });
});
