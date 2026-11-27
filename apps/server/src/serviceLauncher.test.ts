// @effect-diagnostics-next-line nodeBuiltinImport:off - observes the children the launcher spawns with Node built-ins.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - the free-space probe is a plain Promise callback.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - models the service manager reading disk through the launcher's Promise callback.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - builds the Windows single-executable fixture once per file.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { afterAll, vi } from "vite-plus/test";

import {
  renderBootServicePlist,
  renderBootServiceTask,
  renderBootServiceUnit,
} from "./cloud/bootService.ts";
import {
  databaseBackupBlocker,
  Launcher,
  main,
  readServiceEnvironment,
  type BackupSpaceProbe,
  readServiceState,
  registerServiceTask,
  serviceLauncherIsRunning,
  serviceLauncherLockPath,
  stateDirOwned,
  writeServiceState,
} from "./serviceLauncher.ts";
import {
  compareExactServiceVersions,
  decodeServiceState,
  isExactServiceVersion,
  decodeServiceUnit,
  disabledServiceTask,
  encodeServiceTask,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  serviceTaskIsDisabled,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";

const spawnedChildren = vi.hoisted((): Array<NodeChildProcess.ChildProcess> => []);
const spawnHook = vi.hoisted(() => ({
  current: undefined as ((child: NodeChildProcess.ChildProcess) => void) | undefined,
}));

const failRm = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  const rm: typeof actual.rm = (path, options) =>
    path === failRm.path
      ? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
      : actual.rm(path, options);
  return { ...actual, rm };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    spawnedChildren.push(child);
    spawnHook.current?.(child);
    return child;
  };
  return { ...actual, spawn: spawn as typeof actual.spawn };
});

const writeSparseFile = (filePath: string, size: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, "");
    yield* fileSystem.truncate(filePath, size);
  });

it("accepts only exact semantic versions", () => {
  for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3-0", "1.2.3+001"]) {
    assert.isTrue(isExactServiceVersion(version), version);
  }
  for (const version of ["latest", "01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+."]) {
    assert.isFalse(isExactServiceVersion(version), version);
  }
});

it("orders exact semantic versions without treating build metadata as precedence", () => {
  assert.equal(compareExactServiceVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareExactServiceVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.1", "2.0.0-alpha.2"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.2", "2.0.0-alpha.beta"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha-beta", "2.0.0-alpha-alpha"), 1);
  assert.equal(compareExactServiceVersions("2.0.0", "2.0.0-rc.1"), 1);
  assert.equal(compareExactServiceVersions("2.0.0+one", "2.0.0+two"), 0);
});

it("rejects contradictory service state", () => {
  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "0.0.31",
      update: {
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.32",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-3",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-2",
        fromVersion: "1.0.0",
        targetVersion: "0.9.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );
});

const unitPlan = (root: string, version: string) => ({
  program: [`${root}/runtime/versions/${version}/t3`, "__service-launcher"],
  baseDir: root,
  logPath: `${root}/logs/boot-service.log`,
  unitPath: `${root}/unit/t3code.service`,
});

// systemd refuses an executable with a backslash and unescapes them in Environment=, so the
// systemd-shaped tests render units for a POSIX-spelled home; on Windows the systemd manager
// never runs, and the launcher's repointing is what these tests exercise.
const systemdUnitPlan = (root: string, version: string) => {
  const posixRoot = root.replaceAll("\\", "/");
  return unitPlan(posixRoot, version);
};

// systemd renders use the POSIX spelling (see systemdUnitPlan); every other manager's verbatim.
const unitPlanFor = (render: unknown) =>
  render === renderBootServiceUnit ? systemdUnitPlan : unitPlan;

// Windows runs `t3.exe`, a self-contained binary. The fixture is one too, built once per file:
// production embeds its CLI and reads it through a load hook in bin.ts; the fixture's hook
// instead reads the `serve` file beside each copy of the executable, so version directories can
// carry their own child script like the POSIX fixture's shebang entry.
const seaFixtureSource = `const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");
const Module = require("node:module");
const servePath = path.join(path.dirname(process.execPath), "serve");
const serveUrl = url.pathToFileURL(servePath).href;
Module.registerHooks({
  load(requested, context, next) {
    if (requested !== serveUrl) return next(requested, context);
    return { format: "module", source: fs.readFileSync(servePath, "utf8"), shortCircuit: true };
  },
});
Module.createRequire(process.execPath + "/t3.cjs")(servePath);
`;

let seaFixtureDir: string | undefined;
let seaFixtureBuild: Promise<string> | undefined;
const buildWindowsSeaFixture = (): Promise<string> =>
  (seaFixtureBuild ??= (async () => {
    seaFixtureDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-test-sea-"));
    const entryPath = NodePath.join(seaFixtureDir, "sea-entry.cjs");
    const configPath = NodePath.join(seaFixtureDir, "sea-config.json");
    const outputPath = NodePath.join(seaFixtureDir, "t3.exe");
    await NodeFSP.writeFile(entryPath, seaFixtureSource);
    await NodeFSP.writeFile(
      configPath,
      JSON.stringify({ main: entryPath, output: outputPath, disableExperimentalSEAWarning: true }),
    );
    await NodeUtil.promisify(NodeChildProcess.execFile)(
      process.execPath,
      [`--build-sea=${configPath}`],
      { windowsHide: true },
    );
    return outputPath;
  })());

afterAll(async () => {
  if (seaFixtureDir !== undefined)
    await NodeFSP.rm(seaFixtureDir, { recursive: true, force: true });
});

const writeFakeRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionDir: string,
  childSource: string,
) =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(versionDir, { recursive: true });
    let entryPath: string;
    if (HostProcess.Platform.defaultValue() === "win32") {
      entryPath = path.join(versionDir, "t3.exe");
      yield* Effect.promise(async () => {
        const fixture = await buildWindowsSeaFixture();
        await NodeFSP.link(fixture, entryPath).catch(() => NodeFSP.copyFile(fixture, entryPath));
      });
      // The hook loads `serve` as ESM; the require shim keeps child scripts that use CJS
      // require() working. Windows kill() cannot deliver SIGTERM, so production servers stop
      // over IPC; the same message drives any SIGTERM handler the child installs.
      const prelude = [
        'import { createRequire } from "node:module";',
        "const require = createRequire(import.meta.url);",
        'process.on("message", (message) => {',
        '  if (typeof message !== "object" || message === null || message.type !== "stop") return;',
        '  if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM");',
        '  else if (process.listenerCount("message") === 1) setImmediate(() => process.exit(0));',
        "});",
      ].join("\n");
      yield* fs.writeFileString(path.join(versionDir, "serve"), `${prelude}\n${childSource}`);
    } else {
      entryPath = path.join(versionDir, "t3");
      yield* fs.writeFileString(entryPath, `#!${process.execPath}\n${childSource}`);
      yield* fs.chmod(entryPath, 0o755);
    }
    yield* fs.writeFileString(
      path.join(versionDir, ".install-complete"),
      `${path.basename(versionDir)}\n`,
    );
    return entryPath;
  });

const runLauncher = async (root: string) => {
  vi.stubEnv("T3CODE_HOME", root);
  try {
    await main();
  } finally {
    vi.unstubAllEnvs();
  }
};

/** Task Scheduler units are UTF-16LE after a repoint; systemd and launchd units stay UTF-8. */
const readUnitFile = async (unitPath: string): Promise<string> =>
  decodeServiceUnit(await NodeFSP.readFile(unitPath));

const fakeServiceUnit = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  version: string,
  render = renderBootServiceUnit,
  unitName = "t3code.service",
) =>
  Effect.gen(function* () {
    const plan = unitPlanFor(render)(root, version);
    const unitPath = `${root}/unit/${unitName}`;
    yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
    // The file starts as the installer's write: UTF-8 without a BOM on every platform.
    const contents = render(plan);
    yield* fs.writeFileString(unitPath, contents);
    const unit = {
      path: unitPath,
      reloads: 0,
      loadedContents: contents,
      failReload: false,
      reload: async () => {
        unit.reloads += 1;
        if (unit.failReload) throw new Error("daemon-reload failed");
        unit.loadedContents = await readUnitFile(unit.path);
      },
    };
    return unit;
  });

it.layer(NodeServices.layer)("service state persistence", (it) => {
  it.effect(
    "loads optional service.env literally without changing inherited or managed variables",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-env-" });
        const inherited = Object.freeze({
          PATH: "inherited-path",
          T3CODE_HOME: root,
          T3_BOOT_SERVICE_UNIT: "managed-unit",
          T3_SERVICE_LAUNCHER_CONTEXT: "managed-context",
          T3CODE_PORT: "ambient",
        });
        assert.deepEqual(
          yield* Effect.promise(() => readServiceEnvironment(root, inherited)),
          inherited,
        );
        yield* fs.writeFileString(
          path.join(root, SERVICE_ENV_FILE),
          [
            "# service configuration",
            "export T3CODE_PORT=1234 # inline comment",
            'T3CODE_TOKEN="literal $HOME ${USER} $(whoami) # token"',
            'MULTILINE="first\nsecond"',
            "EMPTY=",
            "PATH=/bad",
            "Path=/bad",
            "T3CODE_HOME=/bad",
            "t3code_home=/bad",
            "T3_BOOT_SERVICE_UNIT=bad",
            "t3_boot_service_unit=bad",
            "T3_SERVICE_LAUNCHER_CONTEXT=bad",
            "t3_service_launcher_context=bad",
          ].join("\n"),
        );
        assert.deepEqual(yield* Effect.promise(() => readServiceEnvironment(root, inherited)), {
          ...inherited,
          T3CODE_PORT: "1234",
          T3CODE_TOKEN: "literal $HOME ${USER} $(whoami) # token",
          MULTILINE: "first\nsecond",
          EMPTY: "",
        });
      }),
  );

  it.effect("registers its task again without enabling one the CLI disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-task-" });
      const unitPath = path.join(root, "t3code-task.xml");
      const unit = renderBootServiceTask(unitPlan(root, "1.1.0"), {
        userId: "PC\\theo",
        homeDir: "C:\\Users\\theo",
        conhostPath: "conhost.exe",
      });
      yield* fs.writeFileString(unitPath, unit);
      // Task Scheduler's copy: `t3 doctor` disabled it to keep the service stopped.
      let task = disabledServiceTask(unit.replace("1.1.0", "1.0.0"));
      const schtasks = async (...args: ReadonlyArray<string>) => {
        if (args[0] === "/Create") task = decodeServiceUnit(await NodeFSP.readFile(args[2] ?? ""));
        return { stdout: task };
      };

      yield* Effect.promise(() => registerServiceTask(unitPath, "t3code-PC-theo", schtasks));
      assert.equal(task, disabledServiceTask(unit));
      assert.deepEqual(yield* fs.readDirectory(root), ["t3code-task.xml"]);

      task = unit.replace("1.1.0", "1.0.0");
      yield* Effect.promise(() => registerServiceTask(unitPath, "t3code-PC-theo", schtasks));
      assert.equal(task, unit);
    }),
  );

  const chineseTaskPlan = (root: string) =>
    renderBootServiceTask(
      {
        program: [`${root}/runtime/versions/1.1.0/t3.exe`, "__service-launcher"],
        baseDir: root,
        logPath: `${root}/logs/boot-service.log`,
        unitPath: `${root}/unit/t3code-task.xml`,
      },
      { userId: "PC\\theo", homeDir: "C:\\Users\\theo", conhostPath: "conhost.exe" },
    );

  it.effect("registers a legacy UTF-8 task file as UTF-16LE, keeping its Chinese path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-测试服务-" });
      const unitPath = path.join(root, "t3code-task.xml");
      const unit = chineseTaskPlan(root);
      // The installer's original write: undeclared UTF-8, no BOM.
      yield* fs.writeFileString(unitPath, unit);

      let created: { readonly xmlPath: string; readonly bytes: Uint8Array } | undefined;
      const schtasks = async (...args: ReadonlyArray<string>) => {
        if (args[0] === "/Create") {
          created = { xmlPath: args[2] ?? "", bytes: await NodeFSP.readFile(args[2] ?? "") };
        }
        return { stdout: unit };
      };

      yield* Effect.promise(() => registerServiceTask(unitPath, "t3code-PC-theo", schtasks));
      assert.isDefined(created);
      assert.deepEqual([...created!.bytes.subarray(0, 2)], [0xff, 0xfe]);
      const registered = decodeServiceUnit(created!.bytes);
      assert.equal(registered, unit);
      assert.include(registered, root);
      assert.isFalse(serviceTaskIsDisabled(registered));
      // The legacy file itself is untouched; the transcoded copy is removed after registration.
      assert.equal(yield* fs.readFileString(unitPath), unit);
      assert.deepEqual(yield* fs.readDirectory(root), ["t3code-task.xml"]);
    }),
  );

  it.effect("keeps a disabled task disabled when its legacy file is transcoded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-测试服务-" });
      const unitPath = path.join(root, "t3code-task.xml");
      const unit = chineseTaskPlan(root);
      yield* fs.writeFileString(unitPath, unit);

      let created: { readonly xmlPath: string; readonly bytes: Uint8Array } | undefined;
      const schtasks = async (...args: ReadonlyArray<string>) => {
        if (args[0] === "/Create") {
          created = { xmlPath: args[2] ?? "", bytes: await NodeFSP.readFile(args[2] ?? "") };
        }
        return { stdout: disabledServiceTask(unit) };
      };

      yield* Effect.promise(() => registerServiceTask(unitPath, "t3code-PC-theo", schtasks));
      assert.isDefined(created);
      assert.notEqual(created!.xmlPath, unitPath);
      assert.deepEqual([...created!.bytes.subarray(0, 2)], [0xff, 0xfe]);
      const registered = decodeServiceUnit(created!.bytes);
      assert.equal(registered, disabledServiceTask(unit));
      assert.isTrue(serviceTaskIsDisabled(registered));
      assert.include(registered, root);
      assert.deepEqual(yield* fs.readDirectory(root), ["t3code-task.xml"]);
    }),
  );

  it.effect("registers an already UTF-16LE task file in place without copying", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-测试服务-" });
      const unitPath = path.join(root, "t3code-task.xml");
      const unit = chineseTaskPlan(root);
      yield* Effect.promise(() => NodeFSP.writeFile(unitPath, encodeServiceTask(unit)));

      let created: { readonly xmlPath: string; readonly bytes: Uint8Array } | undefined;
      const schtasks = async (...args: ReadonlyArray<string>) => {
        if (args[0] === "/Create") {
          created = { xmlPath: args[2] ?? "", bytes: await NodeFSP.readFile(args[2] ?? "") };
        }
        return { stdout: unit };
      };

      yield* Effect.promise(() => registerServiceTask(unitPath, "t3code-PC-theo", schtasks));
      assert.isDefined(created);
      assert.equal(created!.xmlPath, unitPath);
      assert.deepEqual([...created!.bytes.subarray(0, 2)], [0xff, 0xfe]);
      assert.equal(decodeServiceUnit(created!.bytes), unit);
      assert.isFalse(serviceTaskIsDisabled(decodeServiceUnit(created!.bytes)));
      assert.deepEqual(yield* fs.readDirectory(root), ["t3code-task.xml"]);
    }),
  );

  it.effect("finds its unit through the manager's environment, not service.env", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-unit-" });
      const home = path.join(root, "home");
      const unitPath = path.join(home, "Library", "LaunchAgents", "t3code.plist");
      const render = (version: string) =>
        renderBootServicePlist(unitPlan(root, version), { homeDir: home, environmentPath: "" });
      yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
      yield* fs.writeFileString(unitPath, render("1.0.0"));
      // The server may run with another HOME; the launch agent still lives in the manager's.
      yield* fs.writeFileString(path.join(root, SERVICE_ENV_FILE), "HOME=/elsewhere\n");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.1.0"),
        "process.exit(0);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(path.join(root, "runtime", "service-state.json"), {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.1.0",
          update: {
            id: "update-1",
            fromVersion: "1.0.0",
            targetVersion: "1.1.0",
            status: "committed",
          },
        }),
      );
      vi.stubEnv("HOME", home);
      vi.stubEnv("T3_BOOT_SERVICE_UNIT", "t3code.plist");

      yield* Effect.promise(() =>
        expect(runLauncher(root)).rejects.toThrow("Active child exited unexpectedly (0)."),
      );

      assert.equal(yield* fs.readFileString(unitPath), render("1.1.0"));
    }),
  );

  // Windows cannot execute the shell-script busctl and systemctl stand-ins; its service manager
  // is Task Scheduler. Linux and macOS both run them.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "repoints the systemd unit the manager loads when environment.d moves XDG_CONFIG_HOME",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-xdg-" });
        const home = path.join(root, "home");
        const managerUnitDir = path.join(home, ".config", "systemd", "user");
        const unitPath = path.join(managerUnitDir, "t3code.service");
        const render = (version: string) =>
          renderBootServiceUnit({ ...systemdUnitPlan(root, version), unitPath });
        yield* fs.makeDirectory(managerUnitDir, { recursive: true });
        yield* fs.writeFileString(unitPath, render("1.0.0"));
        // Fake manager: busctl reports the unit search path, systemctl reloads.
        const bin = path.join(root, "bin");
        yield* fs.makeDirectory(bin, { recursive: true });
        const unitPathJson = JSON.stringify({
          type: "as",
          data: [`${managerUnitDir}.control`, managerUnitDir, "/usr/lib/systemd/user"],
        });
        yield* fs.writeFileString(
          path.join(bin, "busctl"),
          `#!/bin/sh\nprintf '%s\\n' '${unitPathJson}'\n`,
        );
        yield* fs.writeFileString(
          path.join(bin, "systemctl"),
          `#!/bin/sh\necho reload >> '${path.join(root, "reloads")}'\n`,
        );
        yield* fs.chmod(path.join(bin, "busctl"), 0o755);
        yield* fs.chmod(path.join(bin, "systemctl"), 0o755);
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", "1.1.0"),
          "process.exit(0);\n",
        );
        yield* Effect.promise(() =>
          writeServiceState(path.join(root, "runtime", "service-state.json"), {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.1.0",
            update: {
              id: "update-1",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              status: "committed",
            },
          }),
        );
        vi.stubEnv("PATH", bin);
        vi.stubEnv("HOME", home);
        // environment.d changes what services inherit, not where the manager reads units.
        vi.stubEnv("XDG_CONFIG_HOME", path.join(home, "service-config"));
        vi.stubEnv("T3_BOOT_SERVICE_UNIT", "t3code.service");

        yield* Effect.promise(() =>
          expect(runLauncher(root)).rejects.toThrow("Active child exited unexpectedly (0)."),
        );

        assert.equal(yield* fs.readFileString(unitPath), render("1.1.0"));
        assert.equal(yield* fs.readFileString(path.join(root, "reloads")), "reload\n");
      }),
  );

  it.effect("keeps the service manager's append log bounded when it starts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-log-" });
      const home = path.join(root, "home");
      const unitPath = path.join(home, "Library", "LaunchAgents", "t3code.plist");
      const plan = unitPlan(root, "1.0.0");
      yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
      yield* fs.writeFileString(
        unitPath,
        renderBootServicePlist(plan, { homeDir: home, environmentPath: "" }),
      );
      const oversized = 64 * 1024 * 1024;
      yield* fs.makeDirectory(path.dirname(plan.logPath), { recursive: true });
      yield* fs.writeFileString(plan.logPath, "");
      yield* fs.truncate(plan.logPath, oversized);
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "process.exit(0);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(path.join(root, "runtime", "service-state.json"), {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      vi.stubEnv("HOME", home);
      vi.stubEnv("T3_BOOT_SERVICE_UNIT", "t3code.plist");

      yield* Effect.promise(() =>
        expect(runLauncher(root)).rejects.toThrow("Active child exited unexpectedly (0)."),
      );

      const { size } = yield* fs.stat(plan.logPath);
      expect(Number(size)).toBeLessThan(oversized);
    }),
  );

  it.effect("adopts a legacy install record without rewriting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-migrate-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const activeVersion = "0.0.43-nightly.20260919.1962+build.1";
      const versionDir = path.join(root, "runtime", "versions", activeVersion);
      yield* writeFakeRuntime(
        fs,
        path,
        versionDir,
        `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./started", import.meta.url), "");
process.exit(0);
`,
      );
      const legacyContents = `{ "protocol": 2, "activeVersion": "${activeVersion}" }`;
      yield* fs.writeFileString(statePath, legacyContents);
      const restartPending = path.join(root, "runtime", ".restart-pending");
      yield* fs.writeFileString(restartPending, `${activeVersion}\n`);

      yield* Effect.promise(() =>
        expect(runLauncher(root)).rejects.toThrow("Active child exited unexpectedly (0)."),
      );

      assert.isTrue(yield* fs.exists(path.join(versionDir, "started")));
      assert.isFalse(yield* fs.exists(restartPending));
      assert.equal(yield* fs.readFileString(statePath), legacyContents);
    }),
  );

  it.effect("starts the runtime in a T3 home whose name ends in a space", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-space-" });
      const root = path.join(parent, "T3 data ");
      const versionDir = path.join(root, "runtime", "versions", "1.0.0");
      yield* writeFakeRuntime(
        fs,
        path,
        versionDir,
        `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./started", import.meta.url), "");
process.exit(0);
`,
      );
      yield* fs.writeFileString(
        path.join(root, "runtime", "service-state.json"),
        JSON.stringify({ protocol: 4, activeVersion: "1.0.0" }),
      );

      yield* Effect.promise(() =>
        expect(runLauncher(root)).rejects.toThrow("Active child exited unexpectedly (0)."),
      );

      assert.isTrue(yield* fs.exists(path.join(versionDir, "started")));
    }),
  );

  it.effect("refuses non-install legacy documents without rewriting or spawning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-reject-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "process.exit(0);\n",
      );
      const legacy = { protocol: 2, activeVersion: "1.0.0" };
      const childCount = spawnedChildren.length;
      for (const contents of [
        JSON.stringify({
          ...legacy,
          update: {
            id: "u",
            fromVersion: "1.0.0",
            targetVersion: "1.1.0",
            dbPath: "/tmp/state.sqlite",
            status: "pending",
          },
        }),
        JSON.stringify({ ...legacy, update: null }),
        JSON.stringify({ ...legacy, extra: true }),
        JSON.stringify({ ...legacy, protocol: 1 }),
        JSON.stringify({ ...legacy, protocol: 5 }),
        JSON.stringify({ ...legacy, activeVersion: "latest" }),
        "{ invalid JSON",
      ]) {
        yield* fs.writeFileString(statePath, contents);
        yield* Effect.promise(() =>
          expect(runLauncher(root)).rejects.toThrow("Service state is invalid or unsupported."),
        );
        assert.equal(yield* fs.readFileString(statePath), contents);
        assert.equal(spawnedChildren.length, childCount);
      }
    }),
  );

  it.effect("refuses a legacy state whose runtime is missing without rewriting or spawning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-layout-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const contents = '{ "protocol": 2, "activeVersion": "1.0.0" }';
      yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
      yield* fs.writeFileString(statePath, contents);
      const childCount = spawnedChildren.length;

      yield* Effect.promise(() =>
        expect(runLauncher(root)).rejects.toThrow(
          "Selected t3@1.0.0 runtime is missing or incomplete.",
        ),
      );
      assert.equal(yield* fs.readFileString(statePath), contents);
      assert.equal(spawnedChildren.length, childCount);
    }),
  );

  it.effect("a fresh launcher clears a restart deferred by t3 update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-restart-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const restartPending = path.join(root, "runtime", SERVICE_RESTART_PENDING_FILE);
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const run = () =>
        Effect.gen(function* () {
          const launcher = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
          );
          const running = launcher.run();
          yield* Effect.promise(() => launcher.stop("SIGTERM"));
          yield* Effect.promise(() => running);
        });

      yield* fs.writeFileString(restartPending, "1.0.1\n");
      yield* run();
      assert.isTrue(yield* fs.exists(restartPending));

      yield* fs.writeFileString(restartPending, "1.0.0\n");
      yield* run();
      assert.isFalse(yield* fs.exists(restartPending));
    }),
  );

  it.effect.each([
    { unitVersion: "1.0.0", replacement: "an intentional downgrade" },
    { unitVersion: "1.2.0", replacement: "another T3 home" },
  ])(
    "recovers a rolled-back update with unit $unitVersion and preserves $replacement",
    ({ unitVersion, replacement }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-repoint-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", "1.1.0"),
          "setInterval(() => {}, 1_000);\n",
        );
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.1.0",
            update: {
              id: "update-1",
              fromVersion: "1.1.0",
              targetVersion: "1.2.0",
              status: "rolled-back",
            },
          }),
        );
        const unit = yield* fakeServiceUnit(fs, path, root, unitVersion);
        const expected = renderBootServiceUnit(
          systemdUnitPlan(root, unitVersion === "1.0.0" ? "1.1.0" : unitVersion),
        );
        const createLauncher = Effect.gen(function* () {
          return new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)), {
            serviceUnit: unit,
          });
        });
        const run = (launcher: Launcher) =>
          Effect.gen(function* () {
            const running = launcher.run();
            yield* Effect.promise(() => launcher.stop("SIGTERM"));
            yield* Effect.promise(() => running);
          });

        yield* run(yield* createLauncher);
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);

        yield* run(yield* createLauncher);
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);

        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.1.0",
            update: {
              id: "update-2",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              status: "committed",
            },
          }),
        );
        const staleLauncher = yield* createLauncher;
        // A local install can replace the selection or service owner without stopping this launcher.
        const selectedRoot =
          replacement === "another T3 home" ? path.join(root, "other-home") : root;
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(selectedRoot, "runtime", "versions", "1.0.0"),
          "setInterval(() => {}, 1_000);\n",
        );
        const selectedStatePath = path.join(selectedRoot, "runtime", "service-state.json");
        yield* Effect.promise(() =>
          writeServiceState(selectedStatePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );
        const selectedUnit = renderBootServiceUnit({
          ...systemdUnitPlan(selectedRoot, "1.0.0"),
          unitPath: unit.path,
        });
        yield* fs.writeFileString(unit.path, selectedUnit);
        yield* Effect.promise(() => unit.reload());
        const oldHomeState = yield* fs.readFileString(statePath);
        const selectedState = yield* fs.readFileString(selectedStatePath);

        yield* run(staleLauncher);
        assert.equal(yield* fs.readFileString(statePath), oldHomeState);
        assert.equal(yield* fs.readFileString(selectedStatePath), selectedState);
        assert.equal(yield* fs.readFileString(unit.path), selectedUnit, replacement);
        assert.equal(unit.loadedContents, selectedUnit, replacement);
      }),
  );

  it.effect("waits without exiting and restarts once the other owner releases the T3 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-reclaim-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const ownerPath = path.join(root, "userdata", "server-owner.sqlite");
      yield* fs.makeDirectory(path.dirname(ownerPath), { recursive: true });
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        [
          `const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(ownerPath)});`,
          `try { db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"); }`,
          `catch { process.exit(${SERVER_EXIT_CODE_STATE_DIR_OWNED}); }`,
          'process.send("owner");',
          "setInterval(() => {}, 1_000);",
        ].join("\n"),
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      using otherOwner = new NodeSqlite.DatabaseSync(ownerPath);
      otherOwner.exec("BEGIN EXCLUSIVE;");
      const refused = Promise.withResolvers<void>();
      const owned = Promise.withResolvers<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
            if (String(chunk).includes("owns this T3 home")) refused.resolve();
            return true;
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          spawnHook.current = (child) => child.once("message", () => owned.resolve());
        }),
        () =>
          Effect.sync(() => {
            spawnHook.current = undefined;
          }),
      );
      const spawnsBefore = spawnedChildren.length;
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { stateDirOwnerPollMs: 10 },
      );
      let completed = false;
      const running = launcher.run().finally(() => {
        completed = true;
      });
      yield* Effect.promise(() => refused.promise);
      assert.isFalse(completed);
      otherOwner.close();
      yield* Effect.promise(() => owned.promise);
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
      assert.strictEqual(spawnedChildren.length - spawnsBefore, 2);
    }),
  );

  it.effect(
    "keeps a pending update while owned and rolls a failed resumed trial back to the other owner's writes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-reclaim-update-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const ownerPath = path.join(root, "userdata", "server-owner.sqlite");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        const startsPath = path.join(root, "starts.log");
        yield* fs.makeDirectory(path.dirname(ownerPath), { recursive: true });
        yield* fs.writeFileString(databasePath, "before update");
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            [
              `const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(ownerPath)});`,
              `try { db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"); }`,
              `catch { process.exit(${SERVER_EXIT_CODE_STATE_DIR_OWNED}); }`,
              "const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);",
              `require("node:fs").appendFileSync(${JSON.stringify(startsPath)}, context.childVersion + "\\n");`,
              'if (context.update?.status === "pending") {',
              `  require("node:fs").writeFileSync(${JSON.stringify(databasePath)}, "migrated by failed trial");`,
              "  process.exit(1);",
              "}",
              'process.send("active");',
              "setInterval(() => {}, 1_000);",
            ].join("\n"),
          );
        }
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
            update: {
              id: "update-1",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              dbPath: databasePath,
              status: "pending",
            },
          }),
        );
        using otherOwner = new NodeSqlite.DatabaseSync(ownerPath);
        otherOwner.exec("BEGIN EXCLUSIVE;");
        const refused = Promise.withResolvers<void>();
        const active = Promise.withResolvers<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
              if (String(chunk).includes("owns this T3 home")) refused.resolve();
              return true;
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            spawnHook.current = (child) =>
              child.on("message", (message) => message === "active" && active.resolve());
          }),
          () =>
            Effect.sync(() => {
              spawnHook.current = undefined;
            }),
        );
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          { stateDirOwnerPollMs: 10 },
        );
        const running = launcher.run();
        yield* Effect.promise(() => refused.promise);
        const idle = yield* Effect.promise(() => readServiceState(statePath));
        assert.strictEqual(idle.activeVersion, "1.0.0");
        assert.strictEqual(idle.update?.status, "pending");
        assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", "update-1")));

        yield* fs.writeFileString(databasePath, "written by the other owner");
        otherOwner.close();
        yield* Effect.promise(() => active.promise);
        yield* Effect.promise(() => launcher.stop("SIGTERM"));
        yield* Effect.promise(() => running);

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.strictEqual(state.activeVersion, "1.0.0");
        assert.strictEqual(state.update?.status, "rolled-back");
        assert.strictEqual(yield* fs.readFileString(startsPath), "1.1.0\n1.0.0\n");
        assert.strictEqual(yield* fs.readFileString(databasePath), "written by the other owner");
      }),
  );

  it.effect("fails a pending update when its backup cannot be dropped while owned", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-stale-backup-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const ownerPath = path.join(root, "userdata", "server-owner.sqlite");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(ownerPath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before update");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.1.0"),
        `process.exit(${SERVER_EXIT_CODE_STATE_DIR_OWNED});\n`,
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
          update: {
            id: "update-1",
            fromVersion: "1.0.0",
            targetVersion: "1.1.0",
            dbPath: databasePath,
            status: "pending",
          },
        }),
      );
      const refused = Promise.withResolvers<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
            if (String(chunk).includes("owns this T3 home")) refused.resolve();
            return true;
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          failRm.path = path.join(root, "runtime", "db-backup", "update-1");
        }),
        () =>
          Effect.sync(() => {
            failRm.path = undefined;
          }),
      );
      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      const running = launcher.run();
      yield* Effect.promise(() => refused.promise);
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.strictEqual(state.activeVersion, "1.0.0");
      assert.strictEqual(state.update?.status, "failed");
    }),
  );

  it.effect("treats the T3 home as owned while the lock or a pre-lock server holds it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-owned-" });
      const stateDir = path.join(root, "userdata");
      const recordPath = path.join(stateDir, "server-runtime.json");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      assert.isFalse(yield* Effect.promise(() => stateDirOwned(root)));

      using owner = new NodeSqlite.DatabaseSync(path.join(stateDir, "server-owner.sqlite"));
      owner.exec("BEGIN EXCLUSIVE;");
      assert.isTrue(yield* Effect.promise(() => stateDirOwned(root)));
      owner.close();

      const record = { version: 1, pid: process.pid, port: 1, origin: "", startedAt: "" };
      yield* fs.writeFileString(recordPath, JSON.stringify(record));
      assert.isTrue(yield* Effect.promise(() => stateDirOwned(root)));
      yield* fs.writeFileString(recordPath, JSON.stringify({ ...record, ownerId: "lock-aware" }));
      assert.isFalse(yield* Effect.promise(() => stateDirOwned(root)));
      // Pre-lock records carry no identity proof: while their PID lives, the real legacy server
      // and a reused PID are indistinguishable, so the home stays owned either way — only a dead
      // PID clears it. The wall-clock rejection of old records no longer exists.
      yield* fs.writeFileString(
        recordPath,
        JSON.stringify({ ...record, startedAt: "1970-01-01T00:00:00Z" }),
      );
      assert.isTrue(yield* Effect.promise(() => stateDirOwned(root)));
      yield* fs.writeFileString(recordPath, JSON.stringify({ ...record, pid: 2 ** 22 + 1 }));
      assert.isFalse(yield* Effect.promise(() => stateDirOwned(root)));
    }),
  );

  const commitUpdate = (
    render = renderBootServiceUnit,
    missingUnit = false,
    legacyInstall = false,
    unitName = "t3code.service",
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // `<` cannot exist in a Windows path at all, so that host exercises `!` instead.
      const marker = HostProcess.Platform.defaultValue() === "win32" ? "!test!" : "<test>";
      const root = yield* fs.makeTempDirectoryScoped({ prefix: `t3-service 100% & ${marker}-` });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const activatedPath = path.join(root, "activated");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const unit = yield* fakeServiceUnit(fs, path, root, "1.0.0", render, unitName);
      if (missingUnit) yield* fs.remove(unit.path);
      const childSource = `
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
assert.equal(context.protocol, ${SERVICE_LAUNCHER_PROTOCOL});
if (context.update?.status === "pending") {
  const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
  assert.equal(state.activeVersion, "1.0.0");
  assert.equal(state.update.status, "pending");
  ${
    missingUnit
      ? `assert.equal(existsSync(${JSON.stringify(unit.path)}), false);`
      : `assert.equal(readFileSync(${JSON.stringify(unit.path)}, "utf8"), ${JSON.stringify(unit.loadedContents)});`
  }
  process.on("message", (message) => {
    if (message.type === "committed") {
      const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
      assert.equal(state.protocol, ${SERVICE_LAUNCHER_PROTOCOL});
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update.status, "committed");
      writeFileSync(${JSON.stringify(activatedPath)}, message.updateId);
      process.exit(0);
    }
  });
  process.send({ type: "prepared", updateId: context.update.id });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(databasePath)} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      // The old CLI installs the new runtime but writes state with its own protocol.
      yield* fs.writeFileString(
        statePath,
        `${JSON.stringify(
          {
            protocol: legacyInstall ? 3 : SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          },
          null,
          2,
        )}\n`,
      );
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { serviceUnit: unit },
      );
      const failure = yield* Effect.promise(() =>
        launcher.run().then(
          () => "launcher unexpectedly completed",
          (cause: unknown) => String(cause),
        ),
      );
      assert.include(failure, "Active child exited unexpectedly (0)");
      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update?.status, "committed");
      assert.equal(yield* fs.readFileString(activatedPath), state.update?.id);
      const recover = () =>
        Effect.gen(function* () {
          const fresh = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
            { serviceUnit: unit },
          );
          const running = fresh.run();
          yield* Effect.promise(() => fresh.stop("SIGTERM"));
          yield* Effect.promise(() => running);
        });
      return { fs, root, unit, recover };
    });

  it.effect.each([
    {
      name: "systemd after a protocol-3 local upgrade",
      render: renderBootServiceUnit,
      legacyInstall: true,
      unitName: "t3code.service",
    },
    {
      name: "launchd",
      legacyInstall: false,
      unitName: "t3code.service",
      render: (plan: Parameters<typeof renderBootServicePlist>[0]) =>
        renderBootServicePlist(plan, {
          homeDir: "/Users/test & <user>",
          environmentPath: "/usr/bin:/custom/runtime/versions/1.0.0",
        }),
    },
    {
      name: "Task Scheduler",
      legacyInstall: false,
      unitName: "t3code-task.xml",
      render: (plan: Parameters<typeof renderBootServiceTask>[0]) =>
        renderBootServiceTask(
          { ...plan, program: [`${plan.program[0]}.exe`, "__service-launcher"] },
          { userId: "PC\\theo", homeDir: "C:\\Users\\theo", conhostPath: "conhost.exe" },
        ),
    },
  ])(
    "commits and repoints $name only after the trial reports prepared",
    ({ render, legacyInstall, unitName }) =>
      Effect.gen(function* () {
        const { root, unit } = yield* commitUpdate(render, false, legacyInstall, unitName);
        const expected = render(unitPlanFor(render)(root, "1.1.0"));
        const rewritten = yield* Effect.promise(() => NodeFSP.readFile(unit.path));
        assert.equal(decodeServiceUnit(rewritten), expected);
        if (unit.path.endsWith(".xml")) {
          // Everything schtasks is offered starts with the UTF-16LE BOM.
          assert.deepEqual([...rewritten.subarray(0, 2)], [0xff, 0xfe]);
        }
        assert.equal(unit.loadedContents, expected);
        assert.equal(unit.reloads, 1);
      }),
  );

  it.effect(
    "registers an unrepointed legacy task file as UTF-16LE when a committed update restarts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-测试服务-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const unitPath = `${root}/unit/t3code-task.xml`;
        yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
        // The installer wrote the unit for 1.1.0 with the update, so the startup repoint
        // finds nothing to change; the file is still the installer's undeclared UTF-8.
        const unitXml = renderBootServiceTask(
          {
            ...unitPlan(root, "1.1.0"),
            program: [`${unitPlan(root, "1.1.0").program[0]}.exe`, "__service-launcher"],
          },
          { userId: "PC\\theo", homeDir: "C:\\Users\\theo", conhostPath: "conhost.exe" },
        );
        yield* fs.writeFileString(unitPath, unitXml);
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.1.0",
            update: {
              id: "update-1",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              status: "committed",
            },
          }),
        );

        let created: { readonly xmlPath: string; readonly bytes: Uint8Array } | undefined;
        const schtasks = async (...args: ReadonlyArray<string>) => {
          if (args[0] === "/Create") {
            created = { xmlPath: args[2] ?? "", bytes: await NodeFSP.readFile(args[2] ?? "") };
          }
          return { stdout: unitXml };
        };
        const unit = {
          path: unitPath,
          reload: () => registerServiceTask(unitPath, "t3code-PC-theo", schtasks),
        };
        // The runtime directory stays absent on purpose: the child fails to start, but the
        // repoint and registration still run through the same finally path as production.
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          { serviceUnit: unit },
        );
        yield* Effect.promise(() =>
          expect(launcher.run()).rejects.toThrow("runtime is missing or incomplete"),
        );

        assert.isDefined(created);
        assert.deepEqual([...created!.bytes.subarray(0, 2)], [0xff, 0xfe]);
        const registered = decodeServiceUnit(created!.bytes);
        assert.equal(registered, unitXml);
        assert.include(registered, root);
        assert.isFalse(serviceTaskIsDisabled(registered));
        // Nothing repointed, so nothing rewrote the legacy file either.
        assert.equal(yield* fs.readFileString(unitPath), unitXml);
        assert.deepEqual(yield* fs.readDirectory(path.dirname(unitPath)), ["t3code-task.xml"]);
      }),
  );

  it.effect(
    "keeps a durable commit through unit failure and retries a failed reload on restart",
    () =>
      Effect.gen(function* () {
        const { fs, root, unit, recover } = yield* commitUpdate(renderBootServiceUnit, true);
        assert.equal(unit.reloads, 0);
        const original = renderBootServiceUnit(systemdUnitPlan(root, "1.0.0"));
        const expected = renderBootServiceUnit(systemdUnitPlan(root, "1.1.0"));
        assert.equal(unit.loadedContents, original);
        yield* fs.writeFileString(unit.path, original);
        unit.failReload = true;
        yield* recover();
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.reloads, 1);
        assert.equal(unit.loadedContents, original);

        unit.failReload = false;
        yield* recover();
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);
        assert.equal(unit.reloads, 2);
      }),
  );

  it.effect("rolls back invalid trials with the startup environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-rollback-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const observationsPath = path.join(root, "environment-observations.jsonl");
      const envPath = path.join(root, SERVICE_ENV_FILE);
      yield* fs.writeFileString(envPath, "T3CODE_TEST_SERVICE_TOKEN=initial\n");
      vi.stubEnv("T3CODE_HOME", root);
      vi.stubEnv("T3CODE_TEST_SERVICE_TOKEN", "inherited");
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
import { appendFileSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({
  token: process.env.T3CODE_TEST_SERVICE_TOKEN,
  update: context.update?.status ?? "active",
}) + "\\n");
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: "wrong-update" });
} else if (context.update === undefined) {
  writeFileSync(${JSON.stringify(envPath)}, "T3CODE_TEST_SERVICE_TOKEN=changed\\n");
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const unit = yield* fakeServiceUnit(fs, path, root, "0.9.0");

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        {
          serviceUnit: unit,
          environment: yield* Effect.promise(() => readServiceEnvironment(root)),
        },
      );
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(
        yield* fs.readFileString(unit.path),
        renderBootServiceUnit(systemdUnitPlan(root, "1.0.0")),
      );
      assert.equal(unit.reloads, 1);
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        "invalid-prepared",
      );
      const observations = (yield* fs.readFileString(observationsPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(observations, [
        { token: "initial", update: "active" },
        { token: "initial", update: "pending" },
        { token: "initial", update: "rolled-back" },
      ]);
      assert.equal((yield* HostProcess.Environment).T3CODE_TEST_SERVICE_TOKEN, "inherited");
      assert.equal(yield* fs.readFileString(envPath), "T3CODE_TEST_SERVICE_TOKEN=changed\n");
    }),
  );

  it.effect.each(["file", "symlink", "dangling symlink"] as const)(
    "restores the database when a migrating trial exits, with the database a %s",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-db-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        const databaseFile =
          kind === "file" ? databasePath : path.join(root, "data", "original.sqlite");
        const linkTarget = kind === "dangling symlink" ? "../original.sqlite" : databaseFile;
        const original = "database before migration";
        yield* fs.makeDirectory(path.dirname(databaseFile), { recursive: true });
        if (kind === "dangling symlink") {
          yield* fs.makeDirectory(path.join(root, "data", "sub"));
          yield* fs.symlink(path.join(root, "data", "sub"), path.dirname(databasePath));
        } else {
          yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        }
        yield* fs.writeFileString(databaseFile, original);
        if (kind !== "file") yield* fs.symlink(linkTarget, databasePath);
        const encodedDatabasePath = JSON.stringify(databasePath);
        const childSource = `
import { realpathSync, unlinkSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(context.update.dbPath, "database after migration");
  writeFileSync(context.update.dbPath + "-wal", "trial wal");
  writeFileSync(context.update.dbPath + "-shm", "trial shm");
  ${kind === "dangling symlink" ? "unlinkSync(realpathSync(context.update.dbPath));" : ""}
  process.exit(1);
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            childSource,
          );
        }
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );

        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        yield* Effect.promise(() =>
          launcher.run().then(
            () => Promise.reject(new Error("launcher unexpectedly completed")),
            () => Promise.resolve(),
          ),
        );

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(state.update?.status, "rolled-back");
        assert.equal(yield* fs.readFileString(databaseFile), original);
        // Windows stores the separators it prefers in the link itself; the spelling is not load-bearing.
        if (kind !== "file") {
          const link = (yield* fs.readLink(databasePath)).replaceAll("\\", "/");
          assert.equal(link, linkTarget.replaceAll("\\", "/"));
        }
        assert.isFalse(yield* fs.exists(path.join(root, "original.sqlite")));
        assert.isFalse(yield* fs.exists(`${databasePath}-wal`));
        assert.isFalse(yield* fs.exists(`${databasePath}-shm`));
        const updateId = state.update?.id;
        assert.isDefined(updateId);
        assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", updateId)));
      }),
  );

  it.effect.each(["wal", "delete"] as const)(
    "backs up a %s-mode database (online when WAL) and restores its final state",
    (journalMode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-online-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        const observationsPath = path.join(root, "observations.json");
        yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        // POSIX resolves the symlink at open, so -wal/-shm live beside the target; Windows
        // names them after the literal open path, so beside this symlink. Either way the backup
        // must restore them where the server wrote them.
        yield* fs.symlink("actual.sqlite", databasePath);
        const seed = new NodeSqlite.DatabaseSync(databasePath);
        seed.exec(`
        PRAGMA journal_mode = ${journalMode};
        CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
        INSERT INTO events (payload) SELECT 'before the update ' || i FROM n;
      `);
        seed.close();

        const encoded = JSON.stringify({ root, databasePath, observationsPath, journalMode });
        const childSource = `
import { readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const paths = ${encoded};
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(paths.observationsPath + ".trial", JSON.stringify(
    readdirSync(paths.root + "/runtime/db-backup/" + context.update.id).sort(),
  ));
  const trial = new DatabaseSync(context.update.dbPath);
  trial.exec("PRAGMA journal_mode = " + paths.journalMode + "; INSERT INTO events (payload) VALUES ('trial');");
  trial.close();
  process.exit(1);
} else if (context.update === undefined) {
  const db = new DatabaseSync(paths.databasePath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = " + paths.journalMode + ";");
  const insert = db.prepare("INSERT INTO events (payload) VALUES (?)");
  const writer = setInterval(() => insert.run("written while serving"), 1);
  process.once("SIGTERM", () => {
    clearInterval(writer);
    insert.run("last write before stopping");
    const backupRoot = paths.root + "/runtime/db-backup";
    writeFileSync(paths.observationsPath, JSON.stringify({
      backupsAtStop: readdirSync(backupRoot).map((entry) => readdirSync(backupRoot + "/" + entry)),
      rows: db.prepare("SELECT count(*) AS n FROM events").get().n,
    }));
    db.close();
    process.exit(0);
  });
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath });
} else {
  process.exit(0);
}
`;
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            childSource,
          );
        }
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );

        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          {
            backupSpaceProbe: { canClone: async () => false },
          },
        );
        yield* Effect.promise(() =>
          launcher.run().then(
            () => Promise.reject(new Error("launcher unexpectedly completed")),
            () => Promise.resolve(),
          ),
        );

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.update?.status, "rolled-back");
        const observed = JSON.parse(yield* fs.readFileString(observationsPath));
        // A WAL database's main file is copied before the server is asked to stop; others fall back offline.
        assert.deepEqual(observed.backupsAtStop, journalMode === "wal" ? [["database"]] : []);
        assert.isAbove(observed.rows, 501);
        // Only the online copy holds no -shm: the offline fallback copies the one the server left.
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(`${observationsPath}.trial`)),
          journalMode === "wal" ? ["database", "database-wal"] : ["database"],
        );
        const restored = new NodeSqlite.DatabaseSync(databasePath);
        try {
          assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
          assert.equal(
            restored.prepare("SELECT count(*) AS n FROM events").get()?.n,
            observed.rows,
          );
          assert.equal(
            restored
              .prepare(
                "SELECT count(*) AS n FROM events WHERE payload = 'last write before stopping'",
              )
              .get()?.n,
            1,
          );
        } finally {
          restored.close();
        }
      }),
  );

  const requestRejectedUpdate = (backupSpaceProbe: Partial<BackupSpaceProbe>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-space-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const replyPath = path.join(root, "rejection.txt");
      const trialMarker = path.join(root, "trial-started");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({ databasePath, replyPath, trialMarker });
      const childSource = `
import { writeFileSync } from "node:fs";
const paths = ${encoded};
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(paths.trialMarker, "started");
  process.exit(1);
} else if (context.update === undefined) {
  process.on("message", (message) => {
    if (message.type === "update-rejected") {
      writeFileSync(paths.replyPath, message.reason);
      process.exit(0);
    }
  });
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { backupSpaceProbe },
      );
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      return {
        reason: yield* fs.readFileString(replyPath),
        trialStarted: yield* fs.exists(trialMarker),
        state: yield* Effect.promise(() => readServiceState(statePath)),
      };
    });

  it.effect("refuses a backup that cannot fit and leaves the server running", () =>
    Effect.gen(function* () {
      const { reason, trialStarted, state } = yield* requestRejectedUpdate({
        readFreeBytes: () => Promise.resolve(0),
        canClone: () => Promise.resolve(true),
      });

      assert.include(reason, "Not enough free disk space");
      assert.include(reason, "The server was not stopped");
      assert.isFalse(trialStarted);
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("refuses the update when free space cannot be checked", () =>
    Effect.gen(function* () {
      const { reason, trialStarted, state } = yield* requestRejectedUpdate({
        readFreeBytes: () => Promise.reject(new Error("statfs unavailable")),
      });

      assert.include(
        reason,
        "Could not check that the database backup fits before updating: statfs unavailable",
      );
      assert.isFalse(trialStarted);
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("holds its lock while it serves and stops the server over IPC, marker set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-control-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const reportPath = path.join(root, "stopped-with-marker");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({
        databasePath,
        reportPath,
        markerPath: path.join(root, "runtime", SERVICE_STOP_MARKER_FILE),
      });
      const childSource = `
const fs = require("node:fs");
const paths = ${encoded};
process.on("message", (message) => {
  if (message.type !== "stop") return;
  fs.writeFileSync(paths.reportPath, String(fs.existsSync(paths.markerPath)));
  process.exit(0);
});
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath });
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const lockPath = serviceLauncherLockPath(root);
      const serving = Promise.withResolvers<void>();
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        {
          lockPath,
          stopChildOverIpc: true,
          // The update request proves the child is up; refusing it leaves the server running.
          backupSpaceProbe: {
            readFreeBytes: () => {
              serving.resolve();
              return Promise.resolve(0);
            },
            canClone: () => Promise.resolve(false),
          },
        },
      );
      const running = launcher.run();
      yield* Effect.promise(() => Promise.race([serving.promise, running]));

      assert.isTrue(yield* Effect.promise(() => serviceLauncherIsRunning(lockPath)));
      // What losing the task's console does.
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
      assert.equal(yield* fs.readFileString(reportPath), "true");
      assert.isFalse(yield* Effect.promise(() => serviceLauncherIsRunning(lockPath)));
    }),
  );

  it.effect("leaves a pending update alone when stopped while it starts up", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-startup-stop-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      // Recovery would roll this back: the target runtime is missing.
      const pending = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        update: {
          id: "update-1",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath: path.join(root, "userdata", "state.sqlite"),
          status: "pending",
        },
      } as const;
      yield* Effect.promise(() => writeServiceState(statePath, pending));
      const lockPath = serviceLauncherLockPath(root);
      const launcher = new Launcher(root, pending, { lockPath });

      const running = launcher.run();
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);

      // The lock is released only once the launcher is done with the home.
      assert.isFalse(yield* Effect.promise(() => serviceLauncherIsRunning(lockPath)));
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), pending);
    }),
  );

  it.effect("records no update when the server exits during the backup check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-exit-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({ databasePath });
      const childSource = `
const paths = ${encoded};
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath }, () =>
  process.exit(3),
);
setInterval(() => {}, 1_000);
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        {
          backupSpaceProbe: {
            readFreeBytes: () => {
              const child = spawnedChildren.at(-1)!;
              return new Promise((resolve) => {
                if (!child.connected) resolve(Number.MAX_SAFE_INTEGER);
                else child.once("disconnect", () => resolve(Number.MAX_SAFE_INTEGER));
              });
            },
          },
        },
      );
      const failure = yield* Effect.promise(() =>
        launcher.run().then(
          () => new Error("launcher unexpectedly completed"),
          (cause: unknown) => cause as Error,
        ),
      );

      assert.include(failure.message, "Active child exited unexpectedly (3)");
      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("reclaims partial backups left by killed updates before checking space", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-orphan-" });
      const databasePath = path.join(root, "state.sqlite");
      yield* writeSparseFile(databasePath, 10 * 1024 ** 3);
      const backupRoot = path.join(root, "runtime", "db-backup");
      const orphan = path.join(backupRoot, "earlier-update.staging");
      const completed = path.join(backupRoot, "completed-update");
      yield* fs.makeDirectory(orphan, { recursive: true });
      yield* fs.writeFileString(path.join(orphan, "database"), "partial copy");
      yield* fs.makeDirectory(completed);
      yield* fs.writeFileString(path.join(completed, "database"), "complete copy");

      // The orphan is what keeps this disk too full for a full copy.
      const blocker = yield* Effect.promise(() =>
        databaseBackupBlocker(root, databasePath, {
          readFreeBytes: () => Promise.resolve((NodeFS.existsSync(orphan) ? 8 : 11) * 1024 ** 3),
          canClone: () => Promise.resolve(false),
        }),
      );

      assert.isUndefined(blocker);
      assert.isFalse(yield* fs.exists(orphan));
      assert.isTrue(yield* fs.exists(path.join(completed, "database")));
    }),
  );

  it.effect("checks database backup space against clone or full-copy needs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-blocker-" });
      const databasePath = path.join(root, "state.sqlite");
      yield* writeSparseFile(databasePath, 10 * 1024 ** 3);
      const check = (free: number, cloneable: boolean) =>
        Effect.promise(() =>
          databaseBackupBlocker(root, databasePath, {
            readFreeBytes: () => Promise.resolve(free),
            canClone: () => Promise.resolve(cloneable),
          }),
        );

      assert.isUndefined(yield* check(11 * 1024 ** 3, false));
      assert.isUndefined(yield* check(1.5 * 1024 ** 3, true));
      assert.include((yield* check(0.5 * 1024 ** 3, true)) ?? "", "1.0 GB needed, 0.5 GB free");
      const blocker = yield* check(8 * 1024 ** 3, false);
      assert.include(blocker ?? "", "Not enough free disk space");
      assert.include(blocker ?? "", "10.8 GB needed, 8.0 GB free");
      assert.include(blocker ?? "", "The server was not stopped");
    }),
  );
});
