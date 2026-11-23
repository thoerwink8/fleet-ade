// @effect-diagnostics nodeBuiltinImport:off -- Effect's Node FileSystem yields, and Chromium opens GPU caches on the first event-loop turn.
import * as NodeFS from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import { readPairingAppLink } from "@t3tools/shared/remote";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

const systemErrorTag = (cause: unknown): PlatformError.SystemErrorTag => {
  switch ((cause as NodeJS.ErrnoException | undefined)?.code) {
    case "EEXIST":
      return "AlreadyExists";
    case "ENOENT":
      return "NotFound";
    case "EACCES":
    case "EPERM":
      return "PermissionDenied";
    default:
      return "Unknown";
  }
};

const syncFs = <A>(method: string, path: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) =>
      PlatformError.systemError({
        _tag: systemErrorTag(cause),
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
        cause,
      }),
  });

/** Synchronous file access so the profile lock and GPU cache clear finish before the first turn. */
export const synchronousFileSystemLayer = Layer.succeed(
  FileSystem.FileSystem,
  FileSystem.makeNoop({
    exists: (path) =>
      syncFs("exists", path, () => {
        NodeFS.accessSync(path);
        return true;
      }).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(false),
        ),
      ),
    readFileString: (path) =>
      syncFs("readFileString", path, () => NodeFS.readFileSync(path, "utf8")),
    makeDirectory: (path, options) =>
      syncFs("makeDirectory", path, () => {
        NodeFS.mkdirSync(path, { recursive: options?.recursive ?? false });
      }),
    remove: (path, options) =>
      syncFs("remove", path, () =>
        NodeFS.rmSync(path, {
          recursive: options?.recursive ?? false,
          force: options?.force ?? false,
        }),
      ),
    writeFileString: (path, data, options) =>
      syncFs("writeFileString", path, () =>
        NodeFS.writeFileSync(path, data, { flag: options?.flag ?? "w" }),
      ),
  }),
);

export class DesktopInstance extends Context.Service<
  DesktopInstance,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      ElectronWindow.ElectronWindow | DesktopWebLinks.DesktopWebLinks
    >;
  }
>()("@t3tools/desktop/app/DesktopInstance") {}

const isAppLink = (value: string): boolean =>
  promptLinkAppPath(value) !== null || readPairingAppLink(value) !== null;

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const userDataPath = yield* DesktopUserData.resolveUserDataPath(environment).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  yield* electronApp.setPath("userData", userDataPath);

  // A second process on this profile quits asynchronously, so interrupt before the runtime is built.
  if (!(yield* electronApp.requestSingleInstanceLock)) {
    yield* electronApp.quit;
    return yield* Effect.interrupt;
  }
  // Chromium opens these caches at the first event-loop turn, before ready.
  yield* DesktopUserData.clearStaleGpuCaches({
    userDataPath,
    electronVersion: process.versions.electron ?? "",
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const pendingSecondInstances: Array<readonly string[]> = [];
  let handleSecondInstance = (argv: readonly string[]) => {
    pendingSecondInstances.push(argv);
  };
  yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
    handleSecondInstance(argv);
  });
  // macOS hands a launch link to open-url, which can fire before configure runs.
  const pendingOpenUrls: Array<string> = [];
  let handleOpenUrl = (url: string) => {
    pendingOpenUrls.push(url);
    return true;
  };
  yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
    if (handleOpenUrl(url)) event.preventDefault();
  });

  return DesktopInstance.of({
    configure: Effect.gen(function* () {
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);
      const openAppLink = (value: string | undefined) => {
        if (!value || !isAppLink(value)) return false;
        void runPromise(webLinks.receive(value));
        return true;
      };
      const args = yield* HostProcess.Arguments;
      args.some((value) => openAppLink(value));
      handleOpenUrl = (url) => openAppLink(url);
      for (const url of pendingOpenUrls.splice(0)) handleOpenUrl(url);
      handleSecondInstance = (argv) => {
        if (argv?.some((value) => openAppLink(value))) return;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) yield* electronWindow.reveal(mainWindow.value);
          }),
        );
      };
      for (const argv of pendingSecondInstances.splice(0)) handleSecondInstance(argv);
    }).pipe(Effect.withSpan("desktop.instance.configure")),
  });
});

export const layer = Layer.effect(DesktopInstance, make);
