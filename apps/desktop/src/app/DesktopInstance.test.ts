// @effect-diagnostics nodeBuiltinImport:off - The temp profile directory is created before the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { afterAll } from "vite-plus/test";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopInstance from "./DesktopInstance.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

const appDataDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-instance-"));
afterAll(() => {
  NodeFS.rmSync(appDataDirectory, { recursive: true, force: true });
});

const ignoreWebLinks = DesktopWebLinks.DesktopWebLinks.of({
  receive: () => Effect.void,
  setRendererReady: () => Effect.void,
});

const layerDesktopInstance = (
  isDevelopment = true,
  events: string[] = [],
  platform: NodeJS.Platform = "darwin",
  lockGranted = true,
  listeners = new Map<string, (...args: unknown[]) => void>(),
) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    appDataDirectory,
    isDevelopment,
    platform,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
    requestSingleInstanceLock: Effect.sync(() => {
      events.push("requestSingleInstanceLock");
      return lockGranted;
    }),
    quit: Effect.sync(() => {
      events.push("quit");
    }),
    on: (name: string, listener: (...args: unknown[]) => void) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push(`on:${name}`);
          listeners.set(name, listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(name);
          }),
      ).pipe(Effect.asVoid),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopInstance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePathLayer.layerPosix,
        DesktopInstance.synchronousFileSystemLayer,
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
      ),
    ),
  );
};

const userDataPath = (isDevelopment: boolean) =>
  NodePath.join(appDataDirectory, isDevelopment ? "t3code-dev" : "t3code-v2");

describe("DesktopInstance", () => {
  it.each([
    { name: "packaged macOS", isDevelopment: false, platform: "darwin" as const },
    { name: "packaged Linux", isDevelopment: false, platform: "linux" as const },
    { name: "development", isDevelopment: true, platform: "linux" as const },
  ])(
    "takes the profile lock before startup can yield to the event loop ($name)",
    ({ isDevelopment, platform }) => {
      const events: string[] = [];
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The assertion IS that the layer builds synchronously; it.effect would mask a regression to async.
      Effect.runSync(
        Effect.scoped(Layer.build(layerDesktopInstance(isDevelopment, events, platform))),
      );

      assert.deepEqual(events, [
        `setPath:userData:${userDataPath(isDevelopment)}`,
        "requestSingleInstanceLock",
        "on:second-instance",
        "on:open-url",
      ]);
    },
  );

  it.effect.each(["before configure", "after configure"] as const)(
    "reveals the running window when a second instance launches %s",
    (entry) => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const revealed = Promise.withResolvers<unknown>();
      const window = { id: 1 };
      const electronWindow = {
        currentMainOrFirst: Effect.succeedSome(window),
        reveal: (value: unknown) => Effect.sync(() => revealed.resolve(value)),
      } as unknown as ElectronWindow.ElectronWindow["Service"];

      return Effect.gen(function* () {
        const launch = yield* DesktopInstance.DesktopInstance;
        if (entry === "before configure") listeners.get("second-instance")?.({}, ["t3"]);
        yield* launch.configure;
        if (entry === "after configure") listeners.get("second-instance")!({}, ["t3"]);
        assert.strictEqual(yield* Effect.promise(() => revealed.promise), window);
      }).pipe(
        Effect.scoped,
        Effect.provide(layerDesktopInstance(true, [], "darwin", true, listeners)),
        Effect.provideService(HostProcess.Arguments, ["t3"]),
        Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
        Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
      );
    },
  );

  it.effect("delivers each queued startup link once, before later links", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const received: string[] = [];
    const first = "t3code://new?prompt=first";
    const second = "t3code://threads/env-1/thread-1";
    const later = "t3code://new?prompt=later";
    const launchPair = "t3code://pair?pairingUrl=https%3A%2F%2Fvps.example.com%2F%23token%3Dabc";
    const delivered = Promise.withResolvers<void>();

    return Effect.gen(function* () {
      const launch = yield* DesktopInstance.DesktopInstance;
      listeners.get("second-instance")?.({}, ["t3", first]);
      listeners.get("second-instance")?.({}, ["t3", second]);
      listeners.get("open-url")?.({ preventDefault: () => undefined }, launchPair);
      assert.deepEqual(received, []);

      yield* launch.configure;
      listeners.get("second-instance")!({}, ["t3", later]);
      yield* Effect.promise(() => delivered.promise);

      assert.deepEqual(received, [launchPair, first, second, later]);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopInstance(true, [], "darwin", true, listeners)),
      Effect.provideService(HostProcess.Arguments, ["t3"]),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url) =>
            Effect.sync(() => {
              received.push(url);
              if (url === later) delivered.resolve();
            }),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  });

  it.effect.each(["darwin", "win32", "linux"] as const)(
    "quits a second launch before initializing the application runtime on %s",
    (platform) =>
      Effect.gen(function* () {
        const events: string[] = [];
        const runtime = layerDesktopInstance(false, events, platform, false).pipe(
          Layer.flatMap(() =>
            Layer.effectDiscard(
              Effect.sync(() => {
                events.push("initializeApplicationRuntime");
              }),
            ),
          ),
        );
        const exit = yield* Effect.exit(Effect.scoped(Layer.build(runtime)));

        assert.isTrue(Exit.hasInterrupts(exit));
        assert.deepEqual(events, [
          `setPath:userData:${userDataPath(false)}`,
          "requestSingleInstanceLock",
          "quit",
        ]);
      }),
  );
});

it.effect.each(["startup", "open-url", "early-second-instance"] as const)(
  "delivers an app link through the desktop %s handler",
  (entry) => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const received: string[] = [];
    const link = "t3code://new?prompt=from-entry";
    const delivered = Promise.withResolvers<void>();
    return Effect.gen(function* () {
      const launch = yield* DesktopInstance.DesktopInstance;
      if (entry === "early-second-instance") {
        listeners.get("second-instance")?.({}, ["t3", link]);
      }
      yield* launch.configure;
      if (entry === "open-url") {
        let prevented = 0;
        listeners.get("open-url")!({ preventDefault: () => void (prevented += 1) }, link);
        assert.strictEqual(prevented, 1);
      }
      yield* Effect.promise(() => delivered.promise);
      assert.deepEqual(received, [link]);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopInstance(true, [], "darwin", true, listeners)),
      Effect.provideService(HostProcess.Arguments, entry === "startup" ? ["t3", link] : ["t3"]),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url) =>
            Effect.sync(() => {
              received.push(url);
              delivered.resolve();
            }),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  },
);

it.effect("hands app links to the renderer and leaves other links alone", () =>
  Effect.gen(function* () {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const received: Array<string> = [];
    const pairLink = "t3code://pair?pairingUrl=https%3A%2F%2Fvps.example.com%2F%23token%3Dabc";
    const delivered = Promise.withResolvers<void>();
    yield* Effect.gen(function* () {
      const launch = yield* DesktopInstance.DesktopInstance;
      yield* launch.configure;
      const open = (url: string) => {
        let prevented = 0;
        listeners.get("open-url")!({ preventDefault: () => void (prevented += 1) }, url);
        return prevented;
      };
      assert.strictEqual(open("https://example.com/page"), 0);
      assert.strictEqual(open("t3code://new?prompt=hi"), 1);
      assert.strictEqual(open("t3code://threads/env-1/thread-1"), 1);
      assert.strictEqual(open(pairLink), 1);
      assert.strictEqual(open("t3code://pair"), 0);
      assert.strictEqual(open("mailto:hello@example.com"), 0);
      assert.strictEqual(open("t3code://somewhere-else"), 0);
      yield* Effect.promise(() => delivered.promise);
      assert.deepStrictEqual(received, [
        "t3code://new?prompt=hi",
        "t3code://threads/env-1/thread-1",
        pairLink,
      ]);
    }).pipe(
      Effect.provide(layerDesktopInstance(true, [], "darwin", true, listeners)),
      Effect.provideService(HostProcess.Arguments, ["t3"]),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url) =>
            Effect.sync(() => {
              received.push(url);
              if (received.length === 3) delivered.resolve();
            }),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  }),
);

it.layer(NodeServices.layer)("synchronous profile reads", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "fails instead of treating an unreadable profile as missing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-instance-fs-",
        });
        yield* fileSystem.chmod(root, 0o000);
        yield* Effect.addFinalizer(() => fileSystem.chmod(root, 0o700).pipe(Effect.orDie));

        const exit = yield* Effect.exit(
          DesktopUserData.resolveUserDataPath({
            appDataDirectory: root,
            isDevelopment: false,
            platform: "win32",
          }).pipe(Effect.provide(DesktopInstance.synchronousFileSystemLayer)),
        );

        assert.isTrue(Exit.isFailure(exit));
      }),
  );
});
