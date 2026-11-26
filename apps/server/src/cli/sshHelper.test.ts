// @effect-diagnostics nodeBuiltinImport:off - Spawns real processes for the verification boundary tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { runtimePortOutput } from "./sshHelper.ts";
import { processIdentity } from "../legacyServerOwner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerRuntimeState from "../serverRuntimeState.ts";

const liveProcess = Effect.acquireRelease(
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    await NodeEvents.EventEmitter.once(child, "spawn");
    return child;
  }),
  (child) =>
    Effect.promise(async () => {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill();
      await exited;
    }),
);

const probeIdentityOf = async (pid: number) => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The probe must interrogate the real host, not a test platform.
  const identity = await processIdentity(pid, process.platform);
  assert(identity !== undefined, "the test host must answer the process start-time probe");
  return identity;
};

const recordFor = (pid: number, overrides: Record<string, unknown> = {}) => ({
  version: 1,
  pid,
  port: 3773,
  origin: "http://127.0.0.1:3773",
  startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
  ...overrides,
});

it.effect("prints the pid and port only for a verified live server", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sshhelper-live-" });
    const runtimeFile = path.join(root, "server-runtime.json");
    // The verified live server: this process owns the home, and its published record carries
    // the ownerId and the probed process identity.
    const owner = yield* ServerOwnership.acquireServerOwnership(runtimeFile);
    const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
      config: { host: undefined, devUrl: undefined },
      port: 3773,
    });
    yield* owner.publish(state);

    assert.equal(yield* runtimePortOutput(runtimeFile), `${process.pid} 3773`);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ProcessRunner.layer, NodeCrypto.layer).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("prints nothing for corrupt records, dead PIDs, and reused PIDs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sshhelper-refused-" });
    const child = yield* liveProcess;
    assert(child.pid !== undefined);
    const childIdentity = yield* Effect.promise(() => probeIdentityOf(child.pid!));

    const cases: Array<[string, string]> = [
      ["not-json.txt", "this is not json at all"],
      ["empty-object.txt", "{}"],
      [
        "non-loopback.txt",
        JSON.stringify(
          recordFor(child.pid, {
            ownerId: "4ec9f94a-0000-4000-8000-000000000000",
            processIdentity: childIdentity,
            origin: "http://192.168.1.5:3773",
          }),
        ),
      ],
      // A dead PID: the port cannot belong to this server anymore.
      ["dead-pid.txt", JSON.stringify(recordFor(2_147_483_647))],
      // The stored identity belongs to nobody: the PID was reused after the writer died.
      [
        "reused-pid.txt",
        JSON.stringify(
          recordFor(child.pid, {
            ownerId: "4ec9f94a-0000-4000-8000-000000000000",
            processIdentity: "an identity from a process long gone",
          }),
        ),
      ],
      // A pre-lock record carries no identity proof, so its live PID is never enough.
      ["pre-lock.txt", JSON.stringify(recordFor(child.pid))],
      // The identity is there but the ownership lock is not held.
      [
        "unheld-lock-aware.txt",
        JSON.stringify(
          recordFor(child.pid, {
            ownerId: "4ec9f94a-0000-4000-8000-000000000000",
            processIdentity: childIdentity,
          }),
        ),
      ],
    ];
    for (const [name, contents] of cases) {
      const runtimeFile = path.join(root, name);
      yield* fs.writeFileString(runtimeFile, contents);
      assert.equal(
        yield* runtimePortOutput(runtimeFile).pipe(
          Effect.catchDefect(() => Effect.succeed(undefined as string | undefined)),
        ),
        undefined,
        `${name} must not print a port`,
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
