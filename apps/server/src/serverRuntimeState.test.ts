// @effect-diagnostics nodeBuiltinImport:off - Injects a real file replacement during the native SQLite transaction.
import * as DateTime from "effect/DateTime";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { renderBootServicePlist, renderBootServiceUnit } from "./cloud/bootService.ts";
import { ServiceLauncherHostProcess } from "./cloud/serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "./cloud/serviceProtocol.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as ServerRuntimeState from "./serverRuntimeState.ts";
import { processIdentity } from "./legacyServerOwner.ts";

const startBesideBootService = Effect.fn("test.startBesideBootService")(function* (input: {
  readonly platform: "darwin" | "linux";
  readonly outputs: Readonly<Record<string, { readonly code: number; readonly stdout?: string }>>;
  readonly unitServesOtherHome?: boolean;
  readonly restartPending?: boolean;
  readonly activeVersion?: string;
  readonly npmRuntime?: boolean;
  readonly missingServiceState?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly connected?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-boot-service-" });
  const t3Home = path.join(root, ".t3");
  const serviceHome = input.unitServesOtherHome ? path.join(root, "other") : t3Home;
  for (const home of [t3Home, serviceHome]) {
    yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
  }
  yield* fs.makeDirectory(path.join(serviceHome, "runtime"));
  const activeVersion = input.activeVersion ?? "0.0.42";
  if (!input.missingServiceState) {
    yield* fs.writeFileString(
      path.join(serviceHome, "runtime", "service-state.json"),
      JSON.stringify({ protocol: input.npmRuntime ? 2 : 3, activeVersion }),
    );
  }
  if (input.npmRuntime) {
    const versionDir = path.join(serviceHome, "runtime", "versions", activeVersion);
    const entryPath = path.join(versionDir, "node_modules", "t3", "dist", "bin.mjs");
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(entryPath, "");
  }

  if (input.restartPending) {
    yield* fs.writeFileString(
      path.join(serviceHome, "runtime", ".restart-pending"),
      `${activeVersion}\n`,
    );
  }
  const plan = {
    program: input.npmRuntime
      ? ["/usr/bin/node", path.join(serviceHome, "runtime", "service-launcher.mjs")]
      : [],
    baseDir: serviceHome,
    logPath: "",
    unitPath: "",
  };
  const [unitPath, unit] =
    input.platform === "darwin"
      ? [
          path.join(root, "Library", "LaunchAgents", "com.t3tools.t3code.service.plist"),
          renderBootServicePlist(plan, { homeDir: root, environmentPath: "" }),
        ]
      : [
          path.join(root, ".config", "systemd", "user", "t3code.service"),
          renderBootServiceUnit(plan),
        ];
  yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
  yield* fs.writeFileString(unitPath, unit);

  const probes: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (run) =>
      Effect.gen(function* () {
        const probe = `${path.basename(run.command)} ${run.args.find((arg) => !arg.startsWith("--"))}`;
        probes.push(probe);
        const output = input.outputs[probe];
        return yield* output === undefined
          ? Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: run.command,
                argumentCount: run.args.length,
                cause: new Error("not found"),
              }),
            )
          : Effect.succeed({
              stdout: output.stdout ?? "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(output.code),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
      }),
  });
  const result = yield* Effect.scoped(
    ServerOwnership.acquireServerOwnership(path.join(t3Home, "userdata", "server-runtime.json")),
  ).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HostProcess.Platform, input.platform),
    Effect.provideService(HostProcess.UserId, 501),
    Effect.provideService(HostProcess.HomeDirectory, root),
    Effect.provideService(HostProcess.Environment, input.environment ?? {}),
    Effect.provideService(ServiceLauncherHostProcess, {
      connected: input.connected ?? false,
      send: () => false,
      on: () => undefined,
      off: () => undefined,
    }),
    Effect.result,
  );
  assert.includeMembers(
    ["launchctl print", "launchctl print-disabled", "systemctl is-active", "systemctl is-enabled"],
    probes,
  );
  return { result, t3Home };
});

describe("server ownership", () => {
  // An empty home, so no boot service unit installed on this machine is read.
  const layerOwnership = Layer.mergeAll(
    ProcessRunner.layer,
    Layer.effect(
      HostProcess.HomeDirectory,
      Effect.gen(function* () {
        return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      }),
    ),
    Layer.succeed(HostProcess.Environment, {}),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  const makeState = ServerRuntimeState.makePersistedServerRuntimeState({
    config: { host: undefined, devUrl: undefined },
    port: 3773,
  });

  it.effect("lets only one of two racing starts own a state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-race-" });
      const statePath = path.join(root, "server-runtime.json");
      const attempts = yield* Effect.all(
        [
          ServerOwnership.acquireServerOwnership(statePath).pipe(Effect.result),
          ServerOwnership.acquireServerOwnership(statePath).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(attempts.filter((result) => result._tag === "Success").length, 1);
      const refused = attempts.find((result) => result._tag === "Failure");
      assert.equal(refused?.failure._tag, "ServerAlreadyRunningError");
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("refuses a second owner without touching its record, then allows a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
          yield* owner.publish(state);
          const before = yield* fs.readFileString(statePath);
          const refused = yield* ServerOwnership.acquireServerOwnership(statePath).pipe(
            Effect.flip,
          );
          assert.equal(refused._tag, "ServerAlreadyRunningError");
          assert.include(refused.message, "do not delete it while a server is running");
          assert.equal(yield* fs.readFileString(statePath), before);
        }),
      );
      assert.isFalse(yield* fs.exists(statePath));
      yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
    }).pipe(Effect.provide(layerOwnership)),
  );

  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("lock file checks", () => {
    it.effect.each([
      "unchanged",
      "unlink",
      "replace",
      "during acquisition",
      "first acquisition",
      // Root bypasses directory permissions, so chmod cannot force EACCES.
      ...(process.getuid?.() === 0 ? [] : (["stat error"] as const)),
    ] as const)("monitors ownership after %s", (operation) => {
      const messages: unknown[] = [];
      const warnings: unknown[] = [];
      const logger = Logger.make(({ message, logLevel }) =>
        (logLevel === "Warn" ? warnings : messages).push(message),
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-lost-" });
        const statePath = path.join(root, "server-runtime.json");
        const lockPath = path.join(root, "server-owner.sqlite");
        const replacement = path.join(root, "replacement.sqlite");
        if (operation === "during acquisition" || operation === "first acquisition") {
          if (operation === "during acquisition") yield* fs.writeFileString(lockPath, "");
          yield* fs.writeFileString(replacement, "");
          const exec = NodeSqlite.DatabaseSync.prototype.exec;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(NodeSqlite.DatabaseSync.prototype, "exec").mockImplementationOnce(function (
                this: NodeSqlite.DatabaseSync,
                sql: string,
              ) {
                exec.call(this, sql);
                NodeFS.renameSync(replacement, lockPath);
              }),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
        }
        yield* ServerOwnership.acquireServerOwnership(statePath);
        if (operation === "unlink") {
          yield* fs.remove(lockPath);
        } else if (operation === "replace") {
          yield* fs.writeFileString(replacement, "");
          yield* fs.rename(replacement, lockPath);
        }
        if (operation === "stat error") {
          yield* fs.chmod(root, 0);
          yield* TestClock.adjust("15 seconds").pipe(
            Effect.ensuring(fs.chmod(root, 0o700).pipe(Effect.orDie)),
          );
          assert.deepEqual(warnings, [
            [`Cannot check server ownership lock at ${lockPath} (EACCES).`],
          ]);
          yield* TestClock.adjust("5 seconds");
          assert.deepEqual(messages, []);
          yield* fs.remove(lockPath);
        }
        yield* TestClock.adjust("5 seconds");
        const expected =
          operation === "unchanged"
            ? []
            : [
                [
                  `Server ownership lock at ${lockPath} was deleted or replaced. Another server may now share this T3 home. Stop any other server using this home, then restart this server. Do not delete server-owner.sqlite while a server is running.`,
                ],
              ];
        assert.deepEqual(messages, expected);
        if (operation !== "unchanged") {
          yield* fs.remove(`${lockPath}-journal`, { force: true });
          yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
        }
        yield* TestClock.adjust("15 seconds");
        assert.deepEqual(messages, expected);
        assert.lengthOf(warnings, operation === "stat error" ? 1 : 0);
      }).pipe(
        Effect.provide(
          Layer.merge(layerOwnership, Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    });
  });

  it.effect("refuses beside a live pre-lock server and ignores a stale record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-legacy-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        // Any record time after this process started proves the PID was not reused.
        state: { ...state, startedAt: "2100-01-01T00:00:00.000Z" },
      });
      const refused = yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath)).pipe(
        Effect.flip,
      );
      assert.equal(refused._tag, "ServerAlreadyRunningError");
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: { ...state, pid: 0 },
      });
      yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("never removes a runtime record another server published", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-cleanup-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
          yield* owner.publish(state);
          yield* ServerRuntimeState.persistServerRuntimeState({
            path: statePath,
            state: { ...state, ownerId: "other-owner" },
          });
        }),
      );
      const remaining = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.equal(Option.getOrThrow(remaining).ownerId, "other-owner");
      // A record from a build that still wrote the retired managedPolicy key reads the same.
      yield* fs.writeFileString(
        statePath,
        JSON.stringify({
          ...Option.getOrThrow(remaining),
          managedPolicy: { source: "/etc/t3code/policy.json", organization: "Example Corp" },
        }),
      );
      assert.deepEqual(
        yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath),
        remaining,
      );
    }).pipe(Effect.provide(layerOwnership)),
  );

  describe("beside an installed boot service", () => {
    it.effect("refuses an old active or scheduled service even without its runtime record", () =>
      Effect.gen(function* () {
        for (const fixture of [
          {
            platform: "darwin",
            outputs: { "launchctl print": { code: 0 } },
          },
          {
            platform: "darwin",
            outputs: {
              "launchctl print": { code: 113 },
              "launchctl print-disabled": {
                code: 0,
                stdout: '"com.t3tools.t3code.service" => false',
              },
            },
          },
          {
            platform: "linux",
            outputs: {
              // Restart= keeps an otherwise disabled service alive during its restart delay.
              "systemctl is-active": { code: 3, stdout: "activating\n" },
              "systemctl is-enabled": { code: 1, stdout: "disabled\n" },
            },
          },
          {
            platform: "linux",
            outputs: {
              "systemctl is-active": { code: 3, stdout: "inactive\n" },
              "systemctl is-enabled": { code: 0, stdout: "enabled\n" },
            },
          },
          {
            platform: "darwin",
            outputs: { "launchctl print": { code: 0 } },
            environment: { [SERVICE_LAUNCHER_CONTEXT_ENV]: "{}" },
          },
        ] as const) {
          const { result, t3Home } = yield* startBesideBootService(fixture);
          assert.equal(result._tag, "Failure");
          if (result._tag !== "Failure") return;
          assert.equal(result.failure._tag, "OlderBootServiceError");
          assert.equal(Runtime.getErrorExitCode(result.failure), 78);
          assert.include(result.failure.message, t3Home);
          assert.include(result.failure.message, "t3 service install");
          assert.include(result.failure.message, "t3 service restart");
          assert.include(result.failure.message, "No server was stopped");
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );

    it.effect(
      "refuses an active npm-installed service with no standalone executable or runtime record",
      () =>
        Effect.gen(function* () {
          const { result } = yield* startBesideBootService({
            platform: "linux",
            activeVersion: "0.0.40",
            npmRuntime: true,
            outputs: {
              "systemctl is-active": { code: 0, stdout: "active\n" },
            },
          });
          assert.equal(result._tag, "Failure");
          if (result._tag !== "Failure") return;
          assert.equal(result.failure._tag, "OlderBootServiceError");
          assert.equal(Runtime.getErrorExitCode(result.failure), 78);
        }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );

    it.effect("refuses while the loaded service has not restarted into its lock-aware update", () =>
      Effect.gen(function* () {
        const { result } = yield* startBesideBootService({
          platform: "darwin",
          restartPending: true,
          activeVersion: "0.1.0",
          outputs: {
            "launchctl print": { code: 0 },
          },
        });
        assert.equal(result._tag === "Failure" && result.failure._tag, "OlderBootServiceError");
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );

    it.effect("allows lock-aware stable services that are loaded or stopped and enabled", () =>
      Effect.gen(function* () {
        for (const fixture of [
          {
            platform: "darwin",
            outputs: {
              "launchctl print": { code: 0 },
            },
          },
          {
            platform: "linux",
            outputs: {
              "systemctl is-active": { code: 3, stdout: "inactive\n" },
              "systemctl is-enabled": { code: 0, stdout: "enabled\n" },
            },
          },
        ] as const) {
          const { result } = yield* startBesideBootService({ ...fixture, activeVersion: "0.1.0" });
          assert.equal(result._tag, "Success");
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );

    it.effect("allows services that cannot compete for this home", () =>
      Effect.gen(function* () {
        const outputs = {
          "launchctl print": { code: 0 },
        };
        for (const fixture of [
          { platform: "darwin", outputs, unitServesOtherHome: true },
          {
            platform: "darwin",
            outputs,
            environment: { [SERVICE_LAUNCHER_CONTEXT_ENV]: "{}" },
            connected: true,
          },
          {
            platform: "darwin",
            outputs: {
              "launchctl print": { code: 113 },
              "launchctl print-disabled": {
                code: 0,
                stdout: '"com.t3tools.t3code.service" => disabled',
              },
            },
          },
          {
            platform: "linux",
            outputs: {
              "systemctl is-active": { code: 3, stdout: "inactive\n" },
              "systemctl is-enabled": { code: 1, stdout: "disabled\n" },
            },
          },
        ] as const) {
          const { result } = yield* startBesideBootService(fixture);
          assert.equal(result._tag, "Success");
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );

    it.effect("allows startup when the service configuration or manager is unavailable", () =>
      Effect.gen(function* () {
        for (const fixture of [
          { outputs: {} },
          {
            outputs: {
              "launchctl print": { code: 113 },
              "launchctl print-disabled": { code: 1 },
            },
          },
          { outputs: { "launchctl print": { code: 0 } }, missingServiceState: true },
        ]) {
          const { result } = yield* startBesideBootService({ platform: "darwin", ...fixture });
          assert.equal(result._tag, "Success");
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );
  });
});

describe("readLiveServerRuntimeState", () => {
  const layerIdentity = Layer.mergeAll(
    ProcessRunner.layer,
    Layer.succeed(HostProcess.Environment, {}),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
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
  /** A child holding `BEGIN EXCLUSIVE` on `T3_LOCK_PATH`; resolves only after it reports the lock. */
  const lockHoldingProcess = (lockPath: string) =>
    Effect.acquireRelease(
      Effect.promise(async () => {
        const lockScript =
          'const s=require("node:sqlite");const db=new s.DatabaseSync(process.env.T3_LOCK_PATH);db.exec("BEGIN EXCLUSIVE");process.stdout.write("locked\\n");process.stdin.resume();';
        const child = NodeChildProcess.spawn(process.execPath, ["-e", lockScript], {
          stdio: ["pipe", "pipe", "ignore"],
          env: { ...process.env, T3_LOCK_PATH: lockPath },
          windowsHide: true,
        });
        const locked = Promise.race([
          NodeEvents.EventEmitter.once(child.stdout, "data"),
          NodeEvents.EventEmitter.once(child, "exit").then(() => {
            throw new Error("lock holder exited before locking");
          }),
        ]);
        await NodeEvents.EventEmitter.once(child, "spawn");
        await locked;
        return child;
      }),
      (child) =>
        Effect.promise(async () => {
          const exited = NodeEvents.EventEmitter.once(child, "exit");
          child.kill();
          await exited;
        }),
    );

  it.effect("reads a record while its owner still holds the lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-livestate-held-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 3773,
      });
      const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
      yield* owner.publish({ ...state, pid: process.pid });

      assert.isTrue(Option.isSome(yield* ServerRuntimeState.readLiveServerRuntimeState(statePath)));

      // The in-process owner binding is authoritative for this process: even a record whose
      // stored identity was corrupted still reads live while the registered ownerId matches.
      const published = JSON.parse(yield* fs.readFileString(statePath));
      yield* fs.writeFileString(
        statePath,
        JSON.stringify({ ...published, processIdentity: "corrupted-on-disk" }),
      );
      assert.isTrue(
        Option.isSome(yield* ServerRuntimeState.readLiveServerRuntimeState(statePath)),
        "the registered in-process owner must not re-prove its own identity",
      );
    }).pipe(Effect.provide(layerIdentity)),
  );

  it.effect(
    "rejects a record whose process identity belongs to another process, whoever holds the lock",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-livestate-crossproc-" });
        const statePath = path.join(root, "server-runtime.json");
        const impostor = yield* liveProcess;
        assert(impostor.pid !== undefined);
        // A different process holds the ownership lock, like a server still acquiring its home.
        const holder = yield* lockHoldingProcess(path.join(root, "server-owner.sqlite"));
        assert(holder.pid !== undefined);
        assert.notEqual(holder.pid, impostor.pid);

        // The impostor owns the record's PID, but the stored identity was written by the dead
        // original owner: exact identity comparison proves the reuse without any clock.
        yield* fs.writeFileString(
          statePath,
          JSON.stringify(
            recordFor(impostor.pid, {
              ownerId: "4ec9f94a-0000-4000-8000-000000000000",
              processIdentity: yield* Effect.promise(() => probeIdentityOf(holder.pid!)),
            }),
          ),
        );
        assert.isTrue(
          Option.isNone(yield* ServerRuntimeState.readLiveServerRuntimeState(statePath)),
          "a PID whose live identity differs from the record is a reused PID, not the owner",
        );

        // The real lock holder with its own identity in the record reads live.
        const holderIdentity = yield* Effect.promise(() => probeIdentityOf(holder.pid!));
        yield* fs.writeFileString(
          statePath,
          JSON.stringify(
            recordFor(holder.pid, {
              ownerId: "4ec9f94a-0000-4000-8000-000000000000",
              processIdentity: holderIdentity,
            }),
          ),
        );
        assert.isTrue(
          Option.isSome(yield* ServerRuntimeState.readLiveServerRuntimeState(statePath)),
          "the process whose identity matches and whose home is locked is the owner",
        );

        // Wall-clock text in the record is informational only: shifting it either way must not
        // change the verdict in either direction.
        for (const shifted of [
          DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { milliseconds: -5_000 })),
          DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { milliseconds: 65_000 })),
        ]) {
          yield* fs.writeFileString(
            statePath,
            JSON.stringify(
              recordFor(holder.pid, {
                ownerId: "4ec9f94a-0000-4000-8000-000000000000",
                processIdentity: holderIdentity,
                startedAt: shifted,
              }),
            ),
          );
          assert.isTrue(
            Option.isSome(yield* ServerRuntimeState.readLiveServerRuntimeState(statePath)),
            `startedAt shifted to ${shifted} must not affect identity-based verification`,
          );
        }
      }).pipe(Effect.provide(layerIdentity)),
  );

  it.effect(
    "does not trust a corrupt record that names this process's PID without an ownerId",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-livestate-ownpid-" });
        const statePath = path.join(root, "server-runtime.json");
        // No ownerId and no registered owner here: the in-process binding must not match on
        // undefined === undefined, so verification falls through to identity plus lock proof.
        const corrupt = recordFor(process.pid, {
          processIdentity: yield* Effect.promise(() => probeIdentityOf(process.pid)),
        });
        delete (corrupt as Record<string, unknown>).ownerId;
        yield* fs.writeFileString(statePath, JSON.stringify(corrupt));

        assert.isTrue(
          Option.isNone(yield* ServerRuntimeState.readLiveServerRuntimeState(statePath)),
        );
      }).pipe(Effect.provide(layerIdentity)),
  );

  it.effect(
    "treats pre-lock records as unknown while their PID lives: connectors drop them, startup still refuses",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-livestate-legacy-" });
        const statePath = path.join(root, "server-runtime.json");
        const child = yield* liveProcess;
        assert(child.pid !== undefined);

        // A pre-lock record carries no identity proof, so a live PID cannot distinguish the
        // real legacy server from a reused PID: unknown, never live.
        yield* fs.writeFileString(statePath, JSON.stringify(recordFor(child.pid)));
        assert.equal(
          yield* ServerRuntimeState.verifyRecordedServerProcessLiveness(
            { pid: child.pid, ownerId: undefined, processIdentity: undefined },
            statePath,
          ),
          "unknown",
        );
        assert.isTrue(
          Option.isNone(yield* ServerRuntimeState.readLiveServerRuntimeState(statePath)),
        );

        // Startup stays conservative over an unknown record: the same home refuses a second owner.
        const refused = yield* Effect.scoped(
          ServerOwnership.acquireServerOwnership(statePath),
        ).pipe(Effect.result);
        assert.equal(refused._tag, "Failure");
        if (refused._tag === "Failure") {
          assert.equal(refused.failure._tag, "ServerAlreadyRunningError");
        }

        // A dead PID is the only conclusive pre-lock verdict: the record is stale.
        const deadRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-livestate-legacydead-" });
        const deadPath = path.join(deadRoot, "server-runtime.json");
        yield* fs.writeFileString(deadPath, JSON.stringify(recordFor(2_147_483_647)));
        assert.equal(
          yield* ServerRuntimeState.verifyRecordedServerProcessLiveness(
            { pid: 2_147_483_647, ownerId: undefined, processIdentity: undefined },
            deadPath,
          ),
          "stale",
        );
      }).pipe(Effect.provide(layerIdentity)),
  );

  it.effect(
    "reports unknown when the identity probe has no answer, even for a complete record",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-livestate-probefail-" });
        const statePath = path.join(root, "server-runtime.json");
        const child = yield* liveProcess;
        assert(child.pid !== undefined);
        const failingProbe = Effect.provideService(ServerRuntimeState.ProcessIdentityProbe, () =>
          Promise.resolve(undefined),
        );

        yield* fs.writeFileString(
          statePath,
          JSON.stringify(
            recordFor(child.pid, {
              ownerId: "4ec9f94a-0000-4000-8000-000000000000",
              processIdentity: yield* Effect.promise(() => probeIdentityOf(child.pid!)),
            }),
          ),
        );
        assert.equal(
          yield* failingProbe(
            ServerRuntimeState.verifyRecordedServerProcessLiveness(
              JSON.parse(yield* fs.readFileString(statePath)),
              statePath,
            ),
          ),
          "unknown",
        );
        assert.isTrue(
          Option.isNone(
            yield* failingProbe(ServerRuntimeState.readLiveServerRuntimeState(statePath)),
          ),
        );
      }).pipe(Effect.provide(layerIdentity)),
  );

  it.effect("distinguishes held, free, and unreadable ownership locks for lock-aware records", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const [name, lockContents] of [
        ["missing", undefined],
        ["corrupt", "this is not a sqlite database"],
      ] as const) {
        const root = yield* fs.makeTempDirectoryScoped({ prefix: `t3-livestate-lock-${name}-` });
        const statePath = path.join(root, "server-runtime.json");
        if (lockContents !== undefined) {
          yield* fs.writeFileString(path.join(root, "server-owner.sqlite"), lockContents);
        }
        const child = yield* liveProcess;
        assert(child.pid !== undefined);
        yield* fs.writeFileString(
          statePath,
          JSON.stringify(
            recordFor(child.pid, {
              ownerId: "4ec9f94a-0000-4000-8000-000000000000",
              processIdentity: yield* Effect.promise(() => probeIdentityOf(child.pid!)),
            }),
          ),
        );
        const liveness = yield* ServerRuntimeState.verifyRecordedServerProcessLiveness(
          JSON.parse(yield* fs.readFileString(statePath)),
          statePath,
        );
        assert.equal(liveness, name === "missing" ? "stale" : "unknown");
        assert.isTrue(
          Option.isNone(yield* ServerRuntimeState.readLiveServerRuntimeState(statePath)),
        );
      }
    }).pipe(Effect.provide(layerIdentity)),
  );
});
