import type { SdkCredentialStore, SdkLoginOptions, SdkLoginResult } from "@cursor/sdk";
import {
  ProviderSetupError,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { isCursorSdkError, loadCursorSdk } from "./sdk.ts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";

const AUTH_TIMEOUT_MS = 300_000;

// The SDK has no code distinguishing these failures, so classify by its fixed message prefixes.
const loginFailureDetail = (cause: unknown) => {
  if (isCursorSdkError(cause, "CursorSdkError")) {
    if (cause.message.startsWith("Login succeeded, but creating an SDK API key failed")) {
      return "Cursor 已让你登录，但无法创建 API 密钥。团队设置可能限制了 API 密钥：请联系团队管理员，或在提供方设置中添加 CURSOR_API_KEY。";
    }
    if (cause.message.startsWith("Login failed or timed out")) {
      return "Cursor 登录失败或超时。请确认这台机器能访问 Cursor，然后重新登录。";
    }
  }
  return "Cursor 登录失败。请重新登录。";
};

interface AuthFlow {
  readonly id: string;
  readonly owner: string;
  fiber?: Fiber.Fiber<void>;
}

export interface CursorAuth {
  readonly controller: ProviderAuthController;
  readonly readApiKey: Effect.Effect<string | undefined, ProviderSetupError>;
  readonly requireApiKey: Effect.Effect<string, ProviderSetupError>;
  readonly usesApiKey: boolean;
  readonly withAccess: <A, E, R>(
    task: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderSetupError, R | Scope.Scope>;
}

export interface CursorAuthOptions {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly apiKey?: string;
  readonly store: SdkCredentialStore;
  readonly credentialBinding?: NonNullable<ProviderAuthController["credentialBinding"]>;
  readonly onChanged: (signedIn: boolean) => Effect.Effect<void, ProviderSetupError>;
  readonly login?: (options: SdkLoginOptions) => Promise<SdkLoginResult>;
}

export const makeCursorAuth = Effect.fn("makeCursorAuth")(function* (options: CursorAuthOptions) {
  const scope = yield* Scope.Scope;
  const random = yield* SecureRandom.SecureRandom;
  const lock = yield* Semaphore.make(1);
  const configuredKey = options.apiKey?.trim() || undefined;
  const emptyState: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
  };
  const snapshot = yield* SubscriptionRef.make({ owner: null as string | null, state: emptyState });
  let active: AuthFlow | undefined;
  let operation: "idle" | "login" | "stopping" | "closed" = "idle";
  const sessions = new Set<Scope.Closeable>();

  const publish = (flow: AuthFlow, patch: Partial<ProviderAuthState>) =>
    SubscriptionRef.update(snapshot, (current) => ({
      owner: flow.owner,
      state: { ...current.state, ...patch },
    }));

  const readApiKey = Effect.gen(function* () {
    if (configuredKey) return configuredKey;
    const credentials = yield* Effect.tryPromise({
      try: () => options.store.load(),
      catch: (cause) =>
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "credentials",
          detail: "无法读取 Cursor 登录信息。请重新登录。",
          cause,
        }),
    });
    const now = yield* Clock.currentTimeMillis;
    return credentials &&
      (credentials.apiKeyExpiresAtMs === undefined || credentials.apiKeyExpiresAtMs > now)
      ? credentials.apiKey
      : undefined;
  });

  const requireApiKey = Effect.gen(function* () {
    if (operation !== "idle") {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "credentials",
        detail: "Cursor 正在登录或退出。请等它结束后再试。",
      });
    }
    const apiKey = yield* readApiKey;
    if (!apiKey) {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "credentials",
        detail: "请使用 Cursor 登录，或在提供方设置中添加 CURSOR_API_KEY。",
      });
    }
    return apiKey;
  });

  // Closing admission before draining these scopes prevents cached credentials surviving sign-out.
  const withAccess: CursorAuth["withAccess"] = (task) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const parent = yield* Scope.Scope;
        const child = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (operation !== "idle")
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "session",
                detail: "Cursor 正在登录或退出。请等它结束后再试。",
              });
            const child = yield* Scope.make();
            sessions.add(child);
            yield* Scope.addFinalizer(
              child,
              Effect.sync(() => {
                sessions.delete(child);
              }),
            );
            yield* Scope.addFinalizer(parent, Scope.close(child, Exit.void));
            return child;
          }),
        );
        const fiber = yield* restore(task).pipe(
          Effect.provideService(Scope.Scope, child),
          Effect.forkIn(child),
        );
        return yield* restore(Fiber.await(fiber)).pipe(
          Effect.flatten,
          Effect.onExit((result) =>
            Exit.isFailure(result) ? Scope.close(child, Exit.void) : Effect.void,
          ),
        );
      }),
    );
  const stopSessionsWithCredentials = Effect.suspend(() =>
    Effect.forEach(Array.from(sessions), (session) => Scope.close(session, Exit.void), {
      discard: true,
      concurrency: "unbounded",
    }),
  );

  const runLogin = Effect.fn("CursorAuth.runLogin")(
    function* (flow: AuthFlow, stopSessions: Effect.Effect<void, ProviderSetupError>) {
      yield* stopSessions.pipe(Effect.ensuring(stopSessionsWithCredentials));
      // The SDK first writes into memory. Cancellation must not save a late login result.
      const { Cursor, InMemoryCredentialStore } = yield* Effect.try({
        try: loadCursorSdk,
        catch: (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "start",
            detail: "无法加载 Cursor SDK。请重新登录。",
            cause,
          }),
      });
      const pendingStore = new InMemoryCredentialStore();
      const urls = yield* Queue.unbounded<string>();
      yield* Queue.take(urls).pipe(
        Effect.flatMap((authorizationUrl) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (active !== flow) return;
              yield* publish(flow, {
                phase: "waiting",
                authorizationUrl,
                message: "请打开 Cursor 登录页并完成登录。此页面会自动更新。",
              });
            }),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* Effect.tryPromise({
        try: (signal) =>
          (options.login ?? Cursor.auth.login)({
            openBrowser: false,
            store: pendingStore,
            signal,
            apiKeyName: `T3 Code - ${options.displayName}`,
            onLoginUrl: (authorizationUrl) => {
              if (active === flow) Queue.offerUnsafe(urls, authorizationUrl);
            },
          }),
        catch: (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "start",
            detail: loginFailureDetail(cause),
            cause,
          }),
      });
      // Commit and publish together; interrupting a store Promise cannot stop a late write.
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (active !== flow) return;
          yield* publish(flow, {
            phase: "verifying",
            authorizationUrl: null,
            message: "正在检查 Cursor 登录。",
          });
          yield* Effect.tryPromise({
            try: async () => {
              const credentials = await pendingStore.load();
              if (!credentials) throw new Error("Cursor 登录没有返回凭证");
              await options.store.save(credentials);
            },
            catch: (cause) =>
              new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "无法保存 Cursor 登录信息。请再试一次。",
                cause,
              }),
          });
          const verified = yield* options.onChanged(true).pipe(Effect.exit);
          if (Exit.isFailure(verified)) {
            yield* Effect.tryPromise({
              try: () => options.store.clear(),
              catch: (cause) =>
                new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "start",
                  detail: "无法清除被拒绝的 Cursor 登录。请尝试退出登录。",
                  cause,
                }),
            });
            return yield* Effect.failCause(verified.cause);
          }
          active = undefined;
          operation = "idle";
          yield* publish(flow, {
            phase: "succeeded",
            authorizationUrl: null,
            expiresAt: null,
            message: "已使用 Cursor 登录。",
          });
        }).pipe(Effect.uninterruptible),
      );
    },
    (effect, flow, _stopSessions) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: AUTH_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "Cursor 登录已过期。请重新登录。",
              }),
            ),
        }),
        Effect.tapCause((cause) => Effect.logWarning("Cursor sign-in failed", cause)),
        Effect.exit,
        Effect.flatMap((result) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              if (active !== flow) return;
              active = undefined;
              operation = "idle";
              yield* publish(flow, {
                phase: Exit.isSuccess(result) ? "succeeded" : "failed",
                authorizationUrl: null,
                expiresAt: null,
                message: Exit.isSuccess(result)
                  ? "已使用 Cursor 登录。"
                  : Option.match(Cause.findErrorOption(result.cause), {
                      onNone: () => "Cursor 登录失败或已过期。请重新登录。",
                      onSome: (error) => error.detail,
                    }),
              });
            }),
          ),
        ),
      ),
  );

  const requireFlow = Effect.fn("CursorAuth.requireFlow")(function* (
    owner: string,
    id: string,
    name: string,
  ) {
    if (!active || active.owner !== owner || active.id !== id) {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: name,
        detail: "这次登录在此客户端已不再进行。",
      });
    }
    return active;
  });

  const controller: ProviderAuthController = {
    credentialBinding: options.credentialBinding ?? {
      owner: "t3",
      key: `cursor:${options.instanceId}`,
    },
    isChangingCredentials: Effect.sync(() => operation !== "idle"),
    start: (owner, stopSessions = Effect.void) =>
      lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (!options.enabled)
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "请先启用 Cursor，再登录。",
              });
            if (configuredKey)
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "使用浏览器登录前，请先从该提供方的环境中移除 CURSOR_API_KEY。",
              });
            if (active?.owner === owner && operation === "login") return snapshot.value.state;
            if (operation !== "idle")
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "Cursor 的设置已在进行中。",
              });
            const id = yield* random.uuidV4().pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSetupError({
                    instanceId: options.instanceId,
                    operation: "start",
                    detail: "无法开始 Cursor 登录。请再试一次。",
                    cause,
                  }),
              ),
            );
            const expiresAt = DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + AUTH_TIMEOUT_MS),
            );
            const flow: AuthFlow = { id, owner };
            active = flow;
            operation = "login";
            const state: ProviderAuthState = {
              ...emptyState,
              phase: "starting",
              flowId: id,
              expiresAt,
              message: "正在开始 Cursor 登录。",
            };
            yield* SubscriptionRef.set(snapshot, { owner, state });
            flow.fiber = yield* runLogin(flow, stopSessions).pipe(
              Effect.interruptible,
              Effect.forkIn(scope),
            );
            return state;
          }),
        ),
      ),
    complete: () =>
      Effect.fail(
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "complete",
          detail: "请在 Cursor 网站上完成登录。不需要重定向 URL。",
        }),
      ),
    cancel: (owner, id) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const flow = yield* requireFlow(owner, id, "cancel");
              active = undefined;
              operation = "stopping";
              yield* publish(flow, {
                phase: "cancelled",
                authorizationUrl: null,
                expiresAt: null,
                message: "Cursor 登录已取消。",
              });
              return flow;
            }),
          );
          if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
          operation = "idle";
          return snapshot.value.state;
        }),
      ),
    logout: (stopSessions) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const flow = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (configuredKey)
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail: "要断开连接，请从该提供方的环境中移除 CURSOR_API_KEY。",
                });
              if (operation !== "idle" && operation !== "login")
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail: "Cursor 的设置正在停止。",
                });
              operation = "stopping";
              const flow = active;
              active = undefined;
              return flow;
            }),
          );
          const result = yield* Effect.gen(function* () {
            if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
            yield* stopSessions.pipe(Effect.ensuring(stopSessionsWithCredentials));
            yield* Effect.tryPromise({
              try: () => options.store.clear(),
              catch: (cause) =>
                new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "logout",
                  detail: "无法清除 Cursor 登录信息。请再试一次。",
                  cause,
                }),
            });
            yield* options.onChanged(false);
          }).pipe(Effect.exit);
          operation = "idle";
          const state: ProviderAuthState = {
            ...emptyState,
            phase: Exit.isSuccess(result) ? "idle" : "failed",
            message: Exit.isSuccess(result)
              ? "已退出 Cursor 登录。"
              : "退出 Cursor 登录失败。请再试一次。",
          };
          yield* SubscriptionRef.set(snapshot, { owner: null, state });
          if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
          return state;
        }),
      ),
    subscribe: (owner) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((current) => {
          const state = {
            ...current.state,
            credentialOwner: "t3" as const,
            methods: [
              {
                id: "browser",
                name: "使用 Cursor 登录",
                description: null,
                type: "agent" as const,
              },
            ],
            interaction:
              current.state.phase === "waiting" &&
              current.state.authorizationUrl &&
              current.state.flowId
                ? {
                    type: "browser" as const,
                    id: current.state.flowId,
                    url: current.state.authorizationUrl,
                    requiresConsent: false,
                  }
                : null,
          };
          if (current.owner === null || current.owner === owner) return state;
          return {
            ...state,
            interaction: null,
            flowId: null,
            authorizationUrl: null,
            expiresAt: null,
            message: active ? "正在其他客户端中登录。" : current.state.message,
          };
        }),
      ),
    isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = active;
      active = undefined;
      if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
      yield* stopSessionsWithCredentials;
    }),
  );

  return {
    controller,
    readApiKey,
    requireApiKey,
    withAccess,
    usesApiKey: configuredKey !== undefined,
  } satisfies CursorAuth;
});
