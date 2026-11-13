import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { AcpRegistrySettings } from "../settings.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { normalizeAcpRegistryAuthMethods, normalizeAcpRegistryWebUrl } from "./probe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const MAX_ERROR_MESSAGE_LENGTH = 500;

export const formatFailureDetail = (detail: string, cause?: unknown): string => {
  const unwrapped = Cause.isCause(cause) ? Cause.squash(cause) : cause;
  if (isAcpRequestError(unwrapped)) {
    let message = unwrapped.errorMessage.trim();
    if (message.length > MAX_ERROR_MESSAGE_LENGTH) {
      message = `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH).trimEnd()}…`;
    }
    if (message.length > 0) {
      const trimmed = detail.trimEnd();
      const ended = trimmed.endsWith(".") || trimmed.endsWith("。");
      const terminator = /[\u4e00-\u9fff]/.test(trimmed) ? "。" : ".";
      const prefix = ended ? `${trimmed} ` : `${trimmed}${terminator} `;
      return `${prefix}${message}`;
    }
  }
  return detail;
};

type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "initialize" | "authenticate" | "start" | "handleElicitation" | "logout"
>;

export const makeAcpRegistryAuth = Effect.fn("makeAcpRegistryAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: (authenticated: boolean) => Effect.Effect<void>;
  readonly makeRuntime?: (
    spawn: AcpSessionRuntime.AcpSpawnInput,
  ) => Effect.Effect<Runtime, ProviderSetupError, Scope.Scope>;
}) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const random = yield* SecureRandom.SecureRandom;
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const coordinator = yield* Effect.serviceOption(
    AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
  );
  const agentKey =
    options.settings.source === "local" ? `local:${options.instanceId}` : options.settings.agentId;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation,
      detail: formatFailureDetail(detail, cause),
      cause,
    });
  const resolve = catalog
    .resolve(options.settings, options.cwd, options.environment)
    .pipe(Effect.mapError((cause) => failure("start", "无法准备所选的 ACP 代理。", cause)));
  const makeRuntime =
    options.makeRuntime ??
    ((spawn) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            spawn,
            cwd: options.cwd,
            authenticateOnAuthRequired: false,
            clientCapabilities: {
              auth: { terminal: Option.isSome(pty) },
              elicitation: { url: {} },
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "t3-code-provider-auth", version: "0.0.0" },
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Layer.succeed(SecureRandom.SecureRandom, random),
              ),
            ),
          ),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(context),
        );
      }).pipe(Effect.mapError((cause) => failure("start", "无法启动所选的 ACP 代理。", cause))));

  let knownMethods:
    | { readonly version: string | null; readonly methods: ReadonlyArray<ProviderAuthMethod> }
    | undefined;
  const discoverMethods = Effect.scoped(
    Effect.gen(function* () {
      const inspected = yield* catalog
        .inspect(options.settings, options.environment)
        .pipe(Effect.mapError((cause) => failure("methods", "无法检查所选的 ACP 代理。", cause)));
      if (inspected.status !== "ready")
        return yield* failure("methods", "登录前请先准备此 ACP 代理。");
      // Path overrides can change in place; cache discovery only for registry versions.
      if (inspected.version !== null && knownMethods?.version === inspected.version)
        return knownMethods.methods;
      const resolved = yield* resolve;
      const runtime = yield* makeRuntime(resolved.spawn);
      const initialized = yield* runtime
        .initialize()
        .pipe(Effect.mapError((cause) => failure("methods", "无法发现此代理的登录方式。", cause)));
      const advertised = normalizeAcpRegistryAuthMethods(initialized.authMethods)
        .filter(
          (method) => method.id.length <= 128 && (method.type !== "terminal" || Option.isSome(pty)),
        )
        .slice(0, 32)
        .map((method) => ({
          id: method.id,
          name: method.name,
          description: method.description,
          type: method.type === "env_var" ? ("credentials" as const) : method.type,
        }));
      knownMethods = { version: inspected.version, methods: advertised };
      return advertised;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(failure("methods", "ACP 代理没有及时提供登录方式。")),
    }),
  );

  const methods = Option.isSome(coordinator)
    ? coordinator.value
        .runBackgroundProbe(agentKey, discoverMethods)
        .pipe(
          Effect.flatMap((result) =>
            Effect.fromOption(result, () =>
              failure("methods", "登录方式发现被正在进行的提供方会话打断。请再试一次。"),
            ),
          ),
        )
    : discoverMethods;

  const runTerminal = Effect.fnUntraced(function* (
    resolved: AcpRegistrySupport.ResolvedAcpRegistryAgent,
    method: Extract<AcpSchema.AuthMethod, { readonly type: "terminal" }>,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (Option.isNone(pty)) return yield* failure("start", "此环境不支持交互式提供方登录。");
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: resolved.spawn.command,
        args: [...resolved.spawn.args, ...(method.args ?? [])],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: { ...options.environment, ...resolved.spawn.env, ...method.env },
      })
      .pipe(Effect.mapError((cause) => failure("start", "无法打开提供方登录终端。", cause)));
    const detachData = process.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-16_384));
    });
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          process.kill();
        } catch {}
      }),
    );
    let transcript = "";
    let outputOffset = 0;
    const update = () =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) =>
          response.type === "terminal"
            ? Effect.try({
                try: () => {
                  if (response.size) process.resize(response.size.cols, response.size.rows);
                  if (response.data) process.write(response.data);
                },
                catch: () => failure("respond", "提供方登录终端已不可用。"),
              })
            : Effect.void,
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-16_384);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    if ((yield* Deferred.await(exited)) !== 0)
      return yield* failure("start", "提供方登录命令没有成功结束。");
  });

  const authenticate = Effect.fn("AcpRegistryAuth.authenticate")(function* (
    methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (!options.settings.enabled) return yield* failure("start", "登录前请先启用此提供方。");
    const login = Effect.scoped(
      Effect.gen(function* () {
        const resolved = yield* resolve;
        const runtimeScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
        const runtime = yield* makeRuntime(resolved.spawn).pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
        );
        yield* runtime.handleElicitation((request) =>
          Effect.gen(function* () {
            if (
              request.mode !== "url" ||
              !("url" in request) ||
              !("elicitationId" in request) ||
              typeof request.url !== "string" ||
              typeof request.elicitationId !== "string"
            )
              return { action: "decline" } as const;
            const url = normalizeAcpRegistryWebUrl(request.url);
            const id = request.elicitationId.trim();
            if (!url || !id || id.length > 128) return { action: "decline" } as const;
            const consent = yield* Deferred.make<boolean>();
            yield* context.setInteraction(
              { type: "browser", id, url, requiresConsent: true },
              (response) =>
                response.type === "browser"
                  ? Deferred.succeed(consent, response.action === "accept").pipe(Effect.asVoid)
                  : Effect.void,
            );
            return (yield* Deferred.await(consent))
              ? ({ action: "accept" } as const)
              : ({ action: "decline" } as const);
          }),
        );
        const initialized = yield* runtime
          .initialize()
          .pipe(Effect.mapError((cause) => failure("start", "无法初始化所选的 ACP 代理。", cause)));
        const method = initialized.authMethods?.find((method) => method.id === methodId);
        if (!method) return yield* failure("start", "此代理不再提供这种登录方式。");
        if (method.type === "terminal") {
          yield* Scope.close(runtimeScope, Exit.void);
          yield* runTerminal(resolved, method, context).pipe(Effect.scoped);
          // Terminal login is a separate invocation. Reconnect after it exits so
          // the ACP process reads the credentials its login command persisted.
          const verifiedRuntime = yield* makeRuntime(resolved.spawn);
          yield* context.verifying;
          yield* verifiedRuntime
            .start()
            .pipe(
              Effect.mapError((cause) =>
                failure("verify", "终端登录后，提供方无法创建会话。", cause),
              ),
            );
        } else {
          if (method.type === undefined || method.type === "agent") {
            if (!runtime.authenticate)
              return yield* failure("start", "此运行时不支持显式的 ACP 登录。");
            yield* runtime
              .authenticate(methodId)
              .pipe(Effect.mapError((cause) => failure("start", "ACP 代理无法完成登录。", cause)));
          }
          // Legacy env_var methods use the secret-backed environment fields in
          // provider settings. Never send their ID to authenticate.
          yield* context.verifying;
          yield* runtime
            .start()
            .pipe(
              Effect.mapError((cause) => failure("verify", "登录后，提供方无法创建会话。", cause)),
            );
        }
      }),
    );
    yield* Option.isSome(coordinator)
      ? coordinator.value.withForegroundStartup(agentKey, login)
      : login;
    yield* options.onChanged(true);
  });
  const logout = Effect.scoped(
    Effect.gen(function* () {
      const resolved = yield* resolve;
      const runtime = yield* makeRuntime(resolved.spawn);
      yield* runtime.logout.pipe(
        Effect.mapError((cause) =>
          failure("logout", "此 ACP 代理无法退出登录。它可能没有提供退出支持。", cause),
        ),
      );
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => Effect.fail(failure("logout", "ACP 代理没有及时完成退出登录。")),
    }),
  );
  const signOut = (
    Option.isSome(coordinator) ? coordinator.value.withForegroundStartup(agentKey, logout) : logout
  ).pipe(Effect.andThen(options.onChanged(false)));
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // ACP omits credential scope; assume an agent's instances share credentials in this environment.
    credentialBinding: { owner: "provider", key: `acp:${agentKey}` },
    methods,
    ...(options.settings.authMethodId ? { defaultMethodId: options.settings.authMethodId } : {}),
    authenticate,
    logout: signOut,
  });
});
