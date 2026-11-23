import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedError<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices = DesktopWindow.DesktopWindow;

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action, {
    reveal: action !== "paste-as-text",
  });
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

const runMainContentsCommand = Effect.fn("desktop.menu.runMainContentsCommand")(function* (
  command: DesktopWindow.MainWindowContentsCommand,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.runMainContentsCommand(command);
});

/** @public */
export const make = Effect.gen(function* () {
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    // Chromium and the renderer already handle this chord; injecting another paste duplicates text.
    const pasteAsTextClick = (
      _item: Electron.MenuItem,
      _window: Electron.BaseWindow | undefined,
      event: Electron.KeyboardEvent,
    ) => {
      if (event.triggeredByAccelerator === true) return;
      runMenuEffect("paste-as-text", dispatchMenuAction("paste-as-text"));
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) => () => {
      runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
    };
    const mainContentsClick = (command: DesktopWindow.MainWindowContentsCommand) => () => {
      runMenuEffect(command, runMainContentsCommand(command));
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: environment.displayName,
        submenu: [
          { role: "about", label: `关于 ${environment.displayName}` },
          {
            label: "设置…",
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: `隐藏 ${environment.displayName}` },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: `退出 ${environment.displayName}` },
        ],
      });
    }

    template.push(
      {
        label: "文件",
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: "设置…",
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          {
            label: "关闭开发者工具",
            accelerator: "CmdOrCtrl+W",
            visible: false,
            click: () => {
              Electron.webContents
                .getAllWebContents()
                .find((contents) => !contents.isDestroyed() && contents.isDevToolsFocused())
                ?.closeDevTools();
            },
          },
          // Cmd/Ctrl+W belongs to the renderer's tab close; it must never close the window.
          environment.platform === "darwin"
            ? { label: "关闭窗口", click: (_item, window) => window?.close() }
            : { role: "quit" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          {
            label: "粘贴为纯文本",
            accelerator: "CmdOrCtrl+Shift+V",
            click: pasteAsTextClick,
          },
          { role: "delete" },
          { type: "separator" },
          { role: "selectAll" },
          ...(environment.platform === "darwin"
            ? [
                { type: "separator" as const },
                {
                  label: "语音",
                  submenu: [{ role: "startSpeaking" as const }, { role: "stopSpeaking" as const }],
                },
              ]
            : []),
        ],
      },
      {
        label: "查看",
        submenu: [
          /* Native reload/DevTools/zoom roles target focused guests; these commands must target the app. */
          { label: "重新加载", accelerator: "CmdOrCtrl+R", click: mainContentsClick("reload") },
          {
            label: "强制重新加载",
            accelerator: "Shift+CmdOrCtrl+R",
            click: mainContentsClick("forceReload"),
          },
          {
            label: "切换开发者工具",
            accelerator: environment.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
            click: mainContentsClick("toggleDevTools"),
          },
          { type: "separator" },
          { label: "实际大小", accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
          { label: "放大", accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
          {
            label: "放大",
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
            click: zoomClick("in"),
          },
          ...(environment.platform === "darwin"
            ? [
                {
                  label: "放大",
                  accelerator: "CmdOrCtrl+Shift+=",
                  visible: false,
                  click: zoomClick("in"),
                },
              ]
            : []),
          { label: "缩小", accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
          // Keypad codes do not match number-row accelerators.
          {
            label: "实际大小",
            accelerator: "CmdOrCtrl+num0",
            visible: false,
            click: zoomClick("reset"),
          },
          {
            label: "放大",
            accelerator: "CmdOrCtrl+numadd",
            visible: false,
            click: zoomClick("in"),
          },
          {
            label: "缩小",
            accelerator: "CmdOrCtrl+numsub",
            visible: false,
            click: zoomClick("out"),
          },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        // Electron's default Window submenu adds a Ctrl+W close role off macOS.
        role: "windowMenu",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          ...(environment.platform === "darwin"
            ? [{ type: "separator" as const }, { role: "front" as const }]
            : []),
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
