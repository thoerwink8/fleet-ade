// @effect-diagnostics nodeBuiltinImport:off - Spawns real processes for the verification boundary tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { runtimePortOutput } from "./sshHelper.ts";

const liveProcess = Effect.acquireRelease(
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
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
    const child = yield* liveProcess;
    assert(child.pid !== undefined);
    yield* fs.writeFileString(runtimeFile, JSON.stringify(recordFor(child.pid)));

    assert.equal(yield* runtimePortOutput(runtimeFile), `${child.pid} 3773`);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("prints nothing for corrupt records, dead PIDs, and reused PIDs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sshhelper-refused-" });
    const child = yield* liveProcess;
    assert(child.pid !== undefined);

    const cases: Array<[string, string]> = [
      ["not-json.txt", "this is not json at all"],
      ["empty-object.txt", "{}"],
      [
        "non-loopback.txt",
        JSON.stringify(recordFor(child.pid, { origin: "http://192.168.1.5:3773" })),
      ],
      // A dead PID: the port cannot belong to this server anymore.
      ["dead-pid.txt", JSON.stringify(recordFor(2_147_483_647))],
      // The PID is alive but started long after this record: it was reused.
      [
        "reused-pid.txt",
        JSON.stringify(recordFor(child.pid, { startedAt: "2026-10-01T00:00:00.000Z" })),
      ],
      // The start time cannot be parsed, so the PID cannot be verified.
      ["unparseable-time.txt", JSON.stringify(recordFor(child.pid, { startedAt: "garbage" }))],
      // A lock-aware record without a held lock.
      [
        "unheld-lock-aware.txt",
        JSON.stringify(recordFor(child.pid, { ownerId: "4ec9f94a-0000-4000-8000-000000000000" })),
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
