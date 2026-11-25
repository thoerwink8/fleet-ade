import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSetupError, type ProviderAuthState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import { makeClaudeAuth } from "./ClaudeAuth.ts";

const instanceId = ProviderInstanceId.make("claude-auth-test");
const owner = "t3-auth-session-owner";
const otherOwner = "t3-auth-session-other";

const makeHarness = Effect.fn("makeClaudeAuthHarness")(function* (
  options: {
    readonly onChanged?: (authenticated: boolean) => Effect.Effect<void, ProviderSetupError>;
    readonly missingExecutable?: boolean;
  } = {},
) {
  const spawned: Array<PtyAdapter.PtySpawnInput> = [];
  const written: string[] = [];
  const changes: boolean[] = [];
  let killed = 0;
  let emit: (data: string) => void = () => {};
  let exit: (exitCode: number) => void = () => {};
  const spawnedProcess = yield* Deferred.make<void>();
  const pty = Layer.succeed(PtyAdapter.PtyAdapter, {
    spawn: (input) =>
      Effect.sync(() => {
        spawned.push(input);
        Deferred.doneUnsafe(spawnedProcess, Effect.void);
        return {
          pid: 1,
          write: (data: string) => void written.push(data),
          resize: () => {},
          kill: () => void (killed += 1),
          onData: (callback: (data: string) => void) => {
            emit = callback;
            return () => {};
          },
          onExit: (callback: (event: PtyAdapter.PtyExitEvent) => void) => {
            exit = (exitCode) => callback({ exitCode, signal: null });
            return () => {};
          },
        };
      }),
  });
  const auth = yield* makeClaudeAuth({
    instanceId,
    credentialKey: "claude:home:/test",
    cwd: "/state",
    environment: { CLAUDE_CONFIG_DIR: "/test-config" },
    resolveExecutable: options.missingExecutable
      ? Effect.fail(new ProviderSetupError({ instanceId, operation: "start", detail: "没装" }))
      : Effect.succeed("/bin/reclaude"),
    onChanged: (authenticated) =>
      (options.onChanged ?? (() => Effect.void))(authenticated).pipe(
        Effect.tap(() => Effect.sync(() => void changes.push(authenticated))),
      ),
  }).pipe(Effect.provide(pty));
  return {
    auth,
    spawned,
    written,
    changes,
    killed: () => killed,
    spawnedProcess,
    emit: (data: string) => emit(data),
    exit: (code: number) => exit(code),
  };
});

const phase = (
  harness: { readonly auth: { readonly subscribe: any } },
  value: ProviderAuthState["phase"],
  sessionId = owner,
): Effect.Effect<ProviderAuthState> =>
  (harness.auth.subscribe(sessionId) as Stream.Stream<ProviderAuthState>).pipe(
    Stream.filter((state) => state.phase === value),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.layer(NodeCrypto.layer)("ClaudeAuth", (it) => {
  it.effect("runs `auth login` with the instance environment and verifies after a clean exit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auth.start(owner);
      yield* Deferred.await(harness.spawnedProcess);
      assert.deepEqual(harness.spawned[0]?.args, ["auth", "login"]);
      assert.equal(harness.spawned[0]?.shell, "/bin/reclaude");
      assert.equal(harness.spawned[0]?.cwd, "/state");
      assert.equal(harness.spawned[0]?.env.CLAUDE_CONFIG_DIR, "/test-config");

      yield* phase(harness, "waiting");
      harness.emit("Open https://claude.ai/oauth/authorize?code=abc\r\n");
      const waiting = yield* (
        harness.auth.subscribe(owner) as Stream.Stream<ProviderAuthState>
      ).pipe(
        Stream.filter(
          (state) => state.interaction?.type === "terminal" && state.interaction.output !== "",
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.equal(waiting.phase, "waiting");
      assert.deepEqual(harness.changes, []);

      harness.exit(0);
      yield* phase(harness, "succeeded");
      assert.deepEqual(harness.changes, [true]);
      assert.equal(harness.killed(), 1);
    }),
  );

  it.effect("keeps the terminal private to the owner and forwards typed input to the process", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* harness.auth.start(owner);
      yield* Deferred.await(harness.spawnedProcess);
      const waiting = yield* phase(harness, "waiting");
      assert.equal(waiting.interaction?.type, "terminal");

      const other = yield* phase(harness, "waiting", otherOwner);
      assert.isNull(other.interaction);
      assert.isNull(other.flowId);
      const stolen = yield* harness.auth.respond!(otherOwner, {
        instanceId,
        flowId: state.flowId!,
        interactionId: "terminal",
        response: { type: "terminal", data: "stolen" },
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(stolen));

      yield* harness.auth.respond!(owner, {
        instanceId,
        flowId: state.flowId!,
        interactionId: "terminal",
        response: { type: "terminal", data: "pasted-code\r" },
      });
      assert.deepEqual(harness.written, ["pasted-code\r"]);
    }),
  );

  it.effect("ignores terminal input that arrives after the command has exited", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* harness.auth.start(owner);
      yield* Deferred.await(harness.spawnedProcess);
      yield* phase(harness, "waiting");
      harness.exit(1);
      // The flow may not have moved on yet; typing into the dead terminal must not fail.
      yield* harness.auth.respond!(owner, {
        instanceId,
        flowId: state.flowId!,
        interactionId: "terminal",
        response: { type: "terminal", data: "x" },
      }).pipe(Effect.exit);
      assert.deepEqual(harness.written, []);
      const failed = yield* phase(harness, "failed");
      assert.equal(failed.message, "Claude 登录命令没有成功结束。");
    }),
  );

  it.effect("fails without verifying when the login command exits with an error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.auth.start(owner);
      yield* Deferred.await(harness.spawnedProcess);
      yield* phase(harness, "waiting");
      harness.exit(1);
      const failed = yield* phase(harness, "failed");
      assert.equal(failed.message, "Claude 登录命令没有成功结束。");
      assert.isNull(failed.interaction);
      assert.deepEqual(harness.changes, []);
    }),
  );

  it.effect("surfaces a failed verification and lets the user retry", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const harness = yield* makeHarness({
        onChanged: () =>
          ++attempts === 1
            ? Effect.fail(
                new ProviderSetupError({
                  instanceId,
                  operation: "verify",
                  detail: "Claude 登录命令已结束，但这台电脑上的 Claude 仍未登录。",
                }),
              )
            : Effect.void,
      });
      yield* harness.auth.start(owner);
      yield* Deferred.await(harness.spawnedProcess);
      yield* phase(harness, "waiting");
      harness.exit(0);
      const failed = yield* phase(harness, "failed");
      assert.equal(failed.message, "Claude 登录命令已结束，但这台电脑上的 Claude 仍未登录。");

      const retry = yield* harness.auth.start(owner);
      assert.equal(retry.phase, "starting");
      yield* phase(harness, "waiting");
      assert.equal(harness.spawned.length, 2);
      yield* harness.auth.cancel(owner, retry.flowId!);
    }),
  );

  it.effect("kills the login process when the flow is cancelled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* harness.auth.start(owner);
      yield* Deferred.await(harness.spawnedProcess);
      yield* phase(harness, "waiting");
      const cancelled = yield* harness.auth.cancel(owner, state.flowId!);
      assert.equal(cancelled.phase, "cancelled");
      assert.equal(harness.killed(), 1);
      assert.deepEqual(harness.changes, []);
    }),
  );

  it.effect("reports a missing executable instead of opening a terminal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ missingExecutable: true });
      yield* harness.auth.start(owner);
      const failed = yield* phase(harness, "failed");
      assert.equal(failed.message, "没装");
      assert.equal(harness.spawned.length, 0);
    }),
  );

  it.effect("signs out with `auth logout` and re-checks the status", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* Effect.all(
        [
          harness.auth.logout(Effect.void),
          Deferred.await(harness.spawnedProcess).pipe(
            Effect.andThen(Effect.sync(() => harness.exit(0))),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(result[0].phase, "idle");
      assert.deepEqual(harness.spawned[0]?.args, ["auth", "logout"]);
      assert.deepEqual(harness.changes, [false]);
    }),
  );

  it.effect("does not report a sign-out that the command failed to perform", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const [result] = yield* Effect.all(
        [
          harness.auth.logout(Effect.void).pipe(Effect.exit),
          Deferred.await(harness.spawnedProcess).pipe(
            Effect.andThen(Effect.sync(() => harness.exit(2))),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.isTrue(Exit.isFailure(result));
      assert.deepEqual(harness.changes, []);
    }),
  );
});
