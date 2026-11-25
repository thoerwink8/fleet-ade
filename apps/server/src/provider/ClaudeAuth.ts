import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

const AUTH_METHOD = {
  id: "claude",
  name: "Claude",
  description: null,
  type: "terminal",
} as const satisfies ProviderAuthMethod;

export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly credentialKey: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly resolveExecutable: Effect.Effect<string, ProviderSetupError>;
  readonly onChanged: (authenticated: boolean) => Effect.Effect<void, ProviderSetupError>;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });

  const run = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    context?: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    const executable = yield* options.resolveExecutable;
    if (Option.isNone(pty)) return yield* failure("start", "此环境不支持交互式提供方登录。");
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: executable,
        args: [...args],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: options.environment,
      })
      .pipe(Effect.mapError((cause) => failure("start", "无法打开 Claude 登录终端。", cause)));
    const detachData = process.onData((data) => Queue.offerUnsafe(output, data.slice(-16_384)));
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

    if (context) {
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
                  catch: () => failure("respond", "Claude 登录终端已不可用。"),
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
    }

    if ((yield* Deferred.await(exited)) !== 0) {
      return yield* failure("start", "Claude 登录命令没有成功结束。");
    }
  });

  const authenticate = Effect.fn("ClaudeAuth.authenticate")(function* (
    methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (methodId !== AUTH_METHOD.id) return yield* failure("start", "不支持这种 Claude 登录方式。");
    yield* run(["auth", "login"], context).pipe(Effect.scoped);
    yield* context.verifying;
    yield* options.onChanged(true);
  });

  const logout = run(["auth", "logout"]).pipe(
    Effect.scoped,
    Effect.andThen(Effect.suspend(() => options.onChanged(false))),
  );

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.credentialKey },
    methods: Effect.succeed([AUTH_METHOD]),
    defaultMethodId: AUTH_METHOD.id,
    authenticate,
    logout,
  });
});
