import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

import { listen, resolveStartupRecoveryOffer } from "./DesktopStartupRecovery.ts";

describe("resolveStartupRecoveryOffer", () => {
  it("names the last version that started when this build has not", () => {
    expect(resolveStartupRecoveryOffer("0.1.3", "0.1.2")).toEqual({
      _tag: "Reinstall",
      version: "0.1.2",
    });
  });

  it("falls back when this version already started or nothing has", () => {
    expect(resolveStartupRecoveryOffer("0.1.3", "0.1.3")).toEqual({ _tag: "Releases" });
    expect(resolveStartupRecoveryOffer("0.1.3", null)).toEqual({ _tag: "Releases" });
  });
});

it.effect.each([
  { visible: false, started: false, closeMain: false },
  { visible: true, started: false, closeMain: false },
  { visible: true, started: true, closeMain: false },
  { visible: true, started: false, closeMain: true },
])("closes recovery safely with closeMain=$closeMain", ({ visible, started, closeMain }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const remembered = yield* Deferred.make<void>();
      const failureLogged = Promise.withResolvers<void>();
      const shouldRecover = !visible || !started;
      const closed = Promise.withResolvers<void>();
      const loaded: string[] = [];
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const mainListeners = new Map<string, () => void>();
      let closeCount = 0;
      let mainVisible = visible;
      const main = {
        isDestroyed: () => false,
        isVisible: () => mainVisible,
        on: (event: string, listener: () => void) => mainListeners.set(event, listener),
        once: (event: string, listener: () => void) => mainListeners.set(event, listener),
      } as unknown as Electron.BrowserWindow;
      const mainRef = yield* Ref.make(Option.some(main));
      const recovery = {
        isDestroyed: () => false,
        close: () => {
          closeCount++;
          closed.resolve();
        },
        loadURL: (url: string) => {
          loaded.push(url);
          return Promise.resolve();
        },
        once: () => {},
        webContents: { setWindowOpenHandler: () => {}, on: () => {} },
      } as unknown as Electron.BrowserWindow;
      const state = yield* DesktopState.DesktopState;
      if (started) yield* SubscriptionRef.set(state.primaryBackendStartup, { _tag: "Ready" });
      const failureLogger = Logger.make(({ message }) => {
        const text = Array.isArray(message) ? message.map(String).join(" ") : String(message);
        if (text.includes("primary backend failing to start")) failureLogged.resolve();
      });
      yield* listen.pipe(
        Effect.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({
              readFileString: () => Effect.succeed("0.1.2"),
              writeFileString: () => Deferred.succeed(remembered, undefined).pipe(Effect.asVoid),
            }),
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              appVersion: "0.1.3",
              stateDir: "/task/state",
              logDir: "/task/logs",
              path: { join: (...parts: string[]) => parts.join("/") },
            } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
            Layer.succeed(ElectronApp.ElectronApp, {
              on: (event: string, listener: (...args: readonly unknown[]) => void) =>
                Effect.sync(() => {
                  appListeners.set(event, listener);
                }),
            } as unknown as ElectronApp.ElectronApp["Service"]),
            Layer.succeed(
              ElectronShell.ElectronShell,
              {} as ElectronShell.ElectronShell["Service"],
            ),
            Layer.succeed(ElectronTheme.ElectronTheme, {
              shouldUseDarkColors: Effect.succeed(false),
            } as ElectronTheme.ElectronTheme["Service"]),
            Layer.succeed(ElectronWindow.ElectronWindow, {
              main: Ref.get(mainRef),
              create: () => Effect.succeed(recovery),
            } as unknown as ElectronWindow.ElectronWindow["Service"]),
          ),
        ),
        Effect.provideService(References.MinimumLogLevel, "Warn"),
        Effect.provide(Logger.layer([failureLogger])),
      );
      appListeners.get("browser-window-created")?.({}, main);
      if (started) yield* Deferred.await(remembered);
      yield* SubscriptionRef.set(state.primaryBackendStartup, {
        _tag: "Failing",
        reason: "Server failed before readiness",
        output: "Failure details",
      });
      yield* Effect.promise(() => failureLogged.promise);
      expect(loaded.length).toBe(shouldRecover ? 1 : 0);
      if (shouldRecover) {
        expect(decodeURIComponent(loaded[0]!)).toContain("Failure details");
        if (closeMain) yield* Ref.set(mainRef, Option.none());
        yield* SubscriptionRef.set(state.primaryBackendStartup, { _tag: "Ready" });
        yield* Deferred.await(remembered);
        if (closeMain || !visible) {
          expect(closeCount).toBe(0);
          if (closeMain) {
            yield* Ref.set(mainRef, Option.some(main));
            mainVisible = false;
            appListeners.get("browser-window-created")?.({}, main);
          }
          mainListeners.get("ready-to-show")?.();
          expect(closeCount).toBe(0);
          mainVisible = true;
          const show = mainListeners.get("show");
          expect(show).toBeDefined();
          show!();
        }
        yield* Effect.promise(() => closed.promise);
        expect(closeCount).toBe(1);
      }
    }),
  ).pipe(Effect.provide(DesktopState.layer)),
);
