import {
  ProviderSetupError,
  type ProviderAuthInteraction,
  type ProviderAuthMethod,
  type ProviderAuthRespondInput,
  type ProviderAuthResponse,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type * as ProviderAuth from "./auth.ts";

export interface ProviderAuthFlowContext {
  readonly flowId: string;
  readonly expiresAt: number;
  readonly returnUrl?: string;
  readonly callbackMode?: "server" | "client";
  readonly setInteraction: (
    interaction: ProviderAuthInteraction,
    respond?: (response: ProviderAuthResponse) => Effect.Effect<void, ProviderSetupError>,
    complete?: (callbackUrl: string) => Effect.Effect<void, ProviderSetupError>,
  ) => Effect.Effect<void>;
  readonly verifying: Effect.Effect<void>;
}

const isSetupError = Schema.is(ProviderSetupError);

const failureMessage = (cause: Cause.Cause<ProviderSetupError>) => {
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && isSetupError(error.value)
    ? error.value.detail
    : "登录失败。请重新开始。";
};

interface Flow {
  readonly id: string;
  readonly owner: string;
  readonly expiresAt: number;
  complete?: ((callbackUrl: string) => Effect.Effect<void, ProviderSetupError>) | undefined;
  fiber?: Fiber.Fiber<void>;
  responseFiber?: Fiber.Fiber<void, ProviderSetupError>;
  respond:
    | ((response: ProviderAuthResponse) => Effect.Effect<void, ProviderSetupError>)
    | undefined;
}

export const make = Effect.fn("ProviderAuthFlow.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly credentialBinding: NonNullable<ProviderAuth.ProviderAuthController["credentialBinding"]>;
  readonly methods: Effect.Effect<ReadonlyArray<ProviderAuthMethod>, ProviderSetupError>;
  readonly defaultMethodId?: string;
  readonly refreshMethodsAfterAuth?: boolean;
  /** Fail with ProviderSetupError containing safe text for the user, never native token data. */
  readonly authenticate: (
    methodId: string,
    context: ProviderAuthFlowContext,
  ) => Effect.Effect<void, ProviderSetupError, Scope.Scope>;
  readonly logout: Effect.Effect<void | string, ProviderSetupError>;
  readonly removeMethod?: (methodId: string) => Effect.Effect<void, ProviderSetupError>;
  readonly timeoutMs?: number;
}) {
  const scope = yield* Scope.Scope;
  const random = yield* SecureRandom.SecureRandom;
  const lock = yield* Semaphore.make(1);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const empty: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    interaction: null,
    credentialOwner: options.credentialBinding.owner,
  };
  const snapshot = yield* SubscriptionRef.make({ owner: null as string | null, state: empty });
  let active: Flow | undefined;
  // The last flow that ended, so its terminal's trailing traffic can be told from a stranger's.
  let ended: { readonly owner: string; readonly id: string } | undefined;
  let operation: "idle" | "auth" | "stopping" | "closed" = "idle";
  const sessions = new Set<Scope.Closeable>();
  const stopOwnedSessions = Effect.suspend(() =>
    Effect.forEach(Array.from(sessions), (session) => Scope.close(session, Exit.void), {
      discard: true,
      concurrency: "unbounded",
    }),
  );
  const publish = (flow: Flow, patch: Partial<ProviderAuthState>) =>
    Effect.suspend(() =>
      active === flow
        ? SubscriptionRef.update(snapshot, (current) => ({
            owner: flow.owner,
            state: { ...current.state, ...patch },
          }))
        : Effect.void,
    );

  const requireFlow = Effect.fnUntraced(function* (owner: string, id: string) {
    if (
      operation !== "auth" ||
      !active ||
      active.owner !== owner ||
      active.id !== id ||
      (yield* Clock.currentTimeMillis) >= active.expiresAt
    ) {
      return yield* new ProviderSetupError({
        instanceId: options.instanceId,
        operation: "respond",
        detail: "这次登录在此客户端已不再进行。",
      });
    }
    return active;
  });

  const refreshMethods = options.methods.pipe(
    Effect.flatMap((methods) =>
      SubscriptionRef.update(snapshot, (current) => ({
        ...current,
        state: { ...current.state, methods },
      })),
    ),
    Effect.catch((error) =>
      SubscriptionRef.update(snapshot, (current) => ({
        ...current,
        state: { ...current.state, methods: current.state.methods ?? [], message: error.detail },
      })),
    ),
  );
  yield* refreshMethods.pipe(Effect.forkIn(scope));

  const respondToLiveFlow = (owner: string, input: ProviderAuthRespondInput) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const { flow, fiber, ready } = yield* lock.withPermit(
          Effect.gen(function* () {
            const flow = yield* requireFlow(owner, input.flowId);
            const interaction = snapshot.value.state.interaction;
            if (
              !interaction ||
              interaction.id !== input.interactionId ||
              interaction.type !== input.response.type ||
              !flow.respond
            )
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "respond",
                detail: "这次登录交互已不可用。",
              });
            if (flow.responseFiber)
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "respond",
                detail: "已有一个登录响应正在处理。",
              });
            const ready = yield* Deferred.make<void>();
            const callback = flow.respond;
            const fiber = yield* Deferred.await(ready).pipe(
              Effect.andThen(Effect.suspend(() => callback(input.response))),
              Effect.interruptible,
              Effect.forkIn(scope),
            );
            flow.responseFiber = fiber;
            return { flow, fiber, ready };
          }),
        );
        yield* Deferred.succeed(ready, undefined);
        yield* restore(Fiber.join(fiber)).pipe(
          Effect.onInterrupt(() => Fiber.interrupt(fiber).pipe(Effect.asVoid)),
          Effect.ensuring(
            lock.withPermit(
              Effect.sync(() => {
                if (flow.responseFiber === fiber) delete flow.responseFiber;
              }),
            ),
          ),
        );
        return snapshot.value.state;
      }),
    );

  const controller: ProviderAuth.ProviderAuthController = {
    credentialBinding: options.credentialBinding,
    adoptCredentials: Effect.fn("providerAuthFlow.adoptCredentials")(function* (
      update,
      stopSessions,
    ) {
      yield* lock.withPermit(
        Effect.gen(function* () {
          if (operation !== "idle")
            return yield* new ProviderSetupError({
              instanceId: options.instanceId,
              operation: "import",
              detail: "请先完成或取消正在进行的登录。",
            });
          operation = "stopping";
        }),
      );
      const result = yield* Effect.gen(function* () {
        yield* stopOwnedSessions;
        yield* stopSessions;
        yield* update;
        yield* refreshMethods;
      }).pipe(Effect.exit);
      const state: ProviderAuthState = {
        ...empty,
        methods: snapshot.value.state.methods ?? [],
        phase: Exit.isSuccess(result) ? "succeeded" : "failed",
        message: Exit.isSuccess(result) ? null : failureMessage(result.cause),
      };
      yield* lock.withPermit(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(snapshot, { owner: null, state });
          operation = "idle";
        }),
      );
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
      return state;
    }, Effect.uninterruptible),
    refreshMethods,
    ...(options.removeMethod
      ? {
          removeMethod: Effect.fn("providerAuthFlow.removeMethod")(function* (methodId: string) {
            return yield* lock.withPermit(
              Effect.gen(function* () {
                if (operation !== "idle")
                  return yield* new ProviderSetupError({
                    instanceId: options.instanceId,
                    operation: "removeMethod",
                    detail: "请先完成或取消正在进行的登录。",
                  });
                yield* options.removeMethod!(methodId);
                const methods = yield* options.methods;
                const state = { ...empty, methods };
                yield* SubscriptionRef.set(snapshot, { owner: null, state });
                return state;
              }),
            );
          }, Effect.uninterruptible),
        }
      : {}),
    invalidate: lock.withPermit(
      Effect.gen(function* () {
        if (operation !== "idle") return;
        yield* stopOwnedSessions;
        yield* SubscriptionRef.set(snapshot, {
          owner: null,
          state: {
            ...empty,
            methods: snapshot.value.state.methods ?? [],
            message: "此提供方的共享登录已改变。",
          },
        });
      }),
    ),
    isChangingCredentials: Effect.sync(() => operation !== "idle"),
    withAccess: (task) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const parent = yield* Scope.Scope;
          const child = yield* lock.withPermit(
            Effect.gen(function* () {
              if (operation !== "idle")
                return yield* new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "session",
                  detail: "提供方登录正在变更。请等它结束后再试。",
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
      ),
    start: (owner, stopSessions = Effect.void, selectedMethodId, returnUrl, callbackMode) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (operation === "auth" && active?.owner === owner) return snapshot.value.state;
          if (operation !== "idle")
            return yield* new ProviderSetupError({
              instanceId: options.instanceId,
              operation: "start",
              detail: "提供方设置已在进行中。",
            });
          const id = yield* random.uuidV4().pipe(
            Effect.mapError(
              () =>
                new ProviderSetupError({
                  instanceId: options.instanceId,
                  operation: "start",
                  detail: "无法开始登录。请再试一次。",
                }),
            ),
          );
          const flow: Flow = {
            id,
            owner,
            expiresAt: (yield* Clock.currentTimeMillis) + timeoutMs,
            respond: undefined,
          };
          active = flow;
          operation = "auth";
          const state: ProviderAuthState = {
            ...empty,
            methods: snapshot.value.state.methods ?? [],
            phase: "starting",
            flowId: id,
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(flow.expiresAt)),
            message: "正在开始登录。",
          };
          yield* SubscriptionRef.set(snapshot, { owner, state });
          flow.fiber = yield* Effect.gen(function* () {
            const methods = yield* options.methods;
            yield* publish(flow, { methods });
            const methodId = selectedMethodId ?? options.defaultMethodId ?? methods[0]?.id;
            if (!methodId || !methods.some((method) => method.id === methodId))
              return yield* new ProviderSetupError({
                instanceId: options.instanceId,
                operation: "start",
                detail: "此提供方没有提供这种登录方式。",
              });
            yield* stopSessions.pipe(Effect.ensuring(stopOwnedSessions));
            yield* options.authenticate(methodId, {
              flowId: id,
              expiresAt: flow.expiresAt,
              ...(returnUrl ? { returnUrl } : {}),
              ...(callbackMode ? { callbackMode } : {}),
              // Terminal sign-in updates this for every output chunk within the auth operation.
              setInteraction: Effect.fnUntraced(function* (interaction, respond, complete) {
                if (active !== flow) return;
                flow.respond = respond;
                flow.complete = complete;
                yield* publish(flow, {
                  phase: "waiting",
                  interaction,
                  authorizationUrl:
                    interaction.type === "browser" || interaction.type === "deviceCode"
                      ? interaction.url
                      : null,
                  message: "请完成登录后再继续。",
                });
              }),
              verifying: Effect.gen(function* () {
                flow.respond = undefined;
                flow.complete = undefined;
                yield* publish(flow, {
                  phase: "verifying",
                  interaction: null,
                  authorizationUrl: null,
                  message: "正在检查提供方登录。",
                });
              }),
            });
          }).pipe(
            Effect.scoped,
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () =>
                Effect.fail(
                  new ProviderSetupError({
                    instanceId: options.instanceId,
                    operation: "start",
                    detail: "登录已过期。请重新开始。",
                  }),
                ),
            }),
            Effect.exit,
            Effect.flatMap((result) =>
              Effect.gen(function* () {
                const finishing = yield* lock.withPermit(
                  Effect.sync(() => {
                    if (active !== flow) return false;
                    operation = "stopping";
                    return true;
                  }),
                );
                if (!finishing) return;
                if (flow.responseFiber) yield* Fiber.interrupt(flow.responseFiber);
                yield* lock.withPermit(
                  Effect.gen(function* () {
                    if (active !== flow) return;
                    if (options.refreshMethodsAfterAuth) yield* refreshMethods;
                    yield* publish(flow, {
                      phase: Exit.isSuccess(result) ? "succeeded" : "failed",
                      interaction: null,
                      authorizationUrl: null,
                      expiresAt: null,
                      message: Exit.isSuccess(result) ? "登录完成。" : failureMessage(result.cause),
                    });
                    ended = { owner: flow.owner, id: flow.id };
                    active = undefined;
                    operation = "idle";
                  }),
                );
              }),
            ),
            Effect.interruptible,
            Effect.forkIn(scope),
          );
          return state;
        }).pipe(Effect.uninterruptible),
      ),
    respond: (owner, input) =>
      // Terminal traffic (data, resize, replies) trails a finished command; the flow's own outcome
      // is already published, so it is dropped rather than reported as a second error. Checked under
      // the lock so a flow that has published its end but not yet been cleared counts as ended.
      lock
        .withPermit(
          Effect.sync(
            () =>
              input.response.type === "terminal" &&
              ended?.owner === owner &&
              ended.id === input.flowId &&
              active?.id !== input.flowId,
          ),
        )
        .pipe(
          Effect.flatMap((trailing) =>
            trailing ? Effect.sync(() => snapshot.value.state) : respondToLiveFlow(owner, input),
          ),
        ),
    complete: (owner, input) =>
      lock.withPermit(
        Effect.gen(function* () {
          const flow = yield* requireFlow(owner, input.flowId);
          const interaction = snapshot.value.state.interaction;
          if (
            snapshot.value.state.phase !== "waiting" ||
            interaction?.type !== "browser" ||
            !interaction.acceptsCallback ||
            !flow.complete
          )
            return yield* new ProviderSetupError({
              instanceId: options.instanceId,
              operation: "complete",
              detail: "这次登录不接受重定向 URL。",
            });
          yield* flow.complete(input.callbackUrl);
          return snapshot.value.state;
        }),
      ),
    cancel: Effect.fn("providerAuthFlow.cancel")(function* (owner, id) {
      const flow = yield* lock.withPermit(
        Effect.gen(function* () {
          const flow = yield* requireFlow(owner, id);
          yield* publish(flow, {
            phase: "cancelled",
            interaction: null,
            authorizationUrl: null,
            expiresAt: null,
            message: "登录已取消。",
          });
          ended = { owner: flow.owner, id: flow.id };
          active = undefined;
          operation = "stopping";
          return flow;
        }),
      );
      if (flow.responseFiber) yield* Fiber.interrupt(flow.responseFiber);
      if (flow.fiber) yield* Fiber.interrupt(flow.fiber);
      operation = "idle";
      return snapshot.value.state;
    }, Effect.uninterruptible),
    logout: Effect.fn("providerAuthFlow.logout")(function* (stopSessions) {
      const flow = yield* lock.withPermit(
        Effect.gen(function* () {
          if (operation !== "idle" && operation !== "auth")
            return yield* new ProviderSetupError({
              instanceId: options.instanceId,
              operation: "logout",
              detail: "提供方设置正在停止。",
            });
          operation = "stopping";
          const flow = active;
          active = undefined;
          return flow;
        }),
      );
      const result = yield* Effect.gen(function* () {
        if (flow?.responseFiber) yield* Fiber.interrupt(flow.responseFiber);
        if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
        yield* stopSessions.pipe(Effect.ensuring(stopOwnedSessions));
        const message = yield* options.logout;
        if (options.refreshMethodsAfterAuth) yield* refreshMethods;
        return message;
      }).pipe(Effect.exit);
      const state: ProviderAuthState = {
        ...empty,
        methods: snapshot.value.state.methods ?? [],
        phase: Exit.isSuccess(result) ? "idle" : "failed",
        message: Exit.isSuccess(result)
          ? (result.value ?? "已退出登录。")
          : "无法退出登录。请再试一次。",
      };
      yield* lock.withPermit(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(snapshot, { owner: null, state });
          operation = "idle";
        }),
      );
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
      return state;
    }, Effect.uninterruptible),
    subscribe: (owner) =>
      SubscriptionRef.changes(snapshot).pipe(
        Stream.map((current) =>
          current.owner === null || current.owner === owner
            ? current.state
            : {
                ...current.state,
                flowId: null,
                authorizationUrl: null,
                interaction: null,
                expiresAt: null,
                message: active ? "正在其他客户端中登录。" : current.state.message,
              },
        ),
      ),
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      operation = "closed";
      const flow = active;
      active = undefined;
      if (flow?.responseFiber) yield* Fiber.interrupt(flow.responseFiber);
      if (flow?.fiber) yield* Fiber.interrupt(flow.fiber);
      // Settings rebuild instances; admitted sessions sharing this binding retain their own scopes.
    }),
  );
  return controller;
});
