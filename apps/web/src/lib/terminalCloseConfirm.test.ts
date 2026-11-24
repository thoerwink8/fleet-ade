import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { confirmMock, readLocalApiMock } = vi.hoisted(() => {
  const confirmMock = vi.fn<(message: string, options?: unknown) => Promise<boolean>>();
  const readLocalApiMock = vi.fn<
    () =>
      | {
          dialogs: { confirm: (message: string, options?: unknown) => Promise<boolean> };
        }
      | undefined
  >();
  return { confirmMock, readLocalApiMock };
});

vi.mock("~/localApi", () => ({
  readLocalApi: () => readLocalApiMock(),
}));

import { confirmTerminalClose, isTerminalCloseConfirmPending } from "./terminalCloseConfirm";

describe("terminal close confirmation", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    readLocalApiMock.mockReset();
    readLocalApiMock.mockReturnValue({ dialogs: { confirm: confirmMock } });
  });

  it("clears pending state and resolves false when the dialog rejects", async () => {
    let reject: (reason?: unknown) => void = () => undefined;
    confirmMock.mockImplementation(
      () =>
        new Promise<boolean>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );

    const confirmation = confirmTerminalClose([{ label: "Terminal 1", running: true }]);
    expect(isTerminalCloseConfirmPending()).toBe(true);

    reject(new Error("dialog failed"));
    await expect(confirmation).resolves.toBe(false);
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it.each([
    { name: "an idle terminal", terminals: [{ label: "终端 1", running: false }] },
    {
      name: "several idle terminals",
      terminals: [
        { label: "终端 1", running: false },
        { label: "终端 2", running: false },
      ],
    },
    { name: "no terminals", terminals: [] },
  ])("closes $name without asking", async ({ terminals }) => {
    await expect(confirmTerminalClose(terminals)).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a running terminal",
      terminals: [{ label: "npm run dev", running: true }],
      title: "关闭这个终端？",
      message: "里面还在运行 “npm run dev”，关掉会终止它，终端里的历史输出也会清除。",
    },
    {
      name: "one running among idle terminals",
      terminals: [
        { label: "终端 1", running: false },
        { label: "vite build", running: true },
      ],
      title: "关闭 2 个终端？",
      message: "其中还在运行 “vite build”，关掉会终止它，终端里的历史输出也会清除。",
    },
    {
      name: "a terminal whose state is unknown",
      terminals: [{ label: "终端 1", running: null }],
      title: "关闭这个终端？",
      message: "里面可能还有程序在运行，关掉会终止它，终端里的历史输出也会清除。",
    },
  ])("asks about $name and names what ends", async ({ terminals, title, message }) => {
    confirmMock.mockResolvedValue(false);
    await expect(confirmTerminalClose(terminals)).resolves.toBe(false);
    expect(confirmMock).toHaveBeenCalledWith(message, {
      title,
      confirmLabel: "终止并关闭",
      variant: "destructive",
    });
  });
});
