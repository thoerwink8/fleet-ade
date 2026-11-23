import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it, vi } from "vite-plus/test";
import { readSystemProxy, refreshSystemProxy } from "./systemProxy.ts";

type ProxyReadCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileMock = (...args: ReadonlyArray<unknown>) => unknown;

type ChildProcessModule = { readonly execFile: ExecFileMock; readonly [key: string]: unknown };
const nativeProbe = vi.hoisted(() => ({
  execFile: vi.fn<ExecFileMock>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<ChildProcessModule>();
  return { ...original, execFile: nativeProbe.execFile };
});
const windowsProxyOutput = (proxy: string) =>
  `ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    ${proxy}\n`;

describe("system proxy refresh", () => {
  effectIt.effect("coalesces spawn refreshes and publishes a later system change", () =>
    Effect.gen(function* () {
      const pending = Promise.withResolvers<void>();
      let refreshCount = 0;
      nativeProbe.execFile.mockImplementation((...args: ReadonlyArray<unknown>) => {
        const callback = args[args.length - 1] as ProxyReadCallback | undefined;
        if (callback !== undefined) {
          refreshCount += 1;
          void pending.promise.then(() =>
            callback(
              null,
              windowsProxyOutput(
                refreshCount === 1 ? "http://proxy-a.test:8080" : "http://proxy-b.test:8080",
              ),
              "",
            ),
          );
        }
        return undefined;
      });

      try {
        const now = yield* Clock.currentTimeMillis;
        const first = refreshSystemProxy("win32", true, now);
        const second = refreshSystemProxy("win32", true, now);
        expect(nativeProbe.execFile).toHaveBeenCalledTimes(1);
        pending.resolve();
        expect(yield* Effect.promise(() => first)).toMatchObject({
          proxyUrl: "http://proxy-a.test:8080",
        });
        expect(yield* Effect.promise(() => second)).toMatchObject({
          proxyUrl: "http://proxy-a.test:8080",
        });
        expect(readSystemProxy("win32").proxyUrl).toBe("http://proxy-a.test:8080");
        const changed = refreshSystemProxy("win32", false, now + 2_001);
        expect(nativeProbe.execFile).toHaveBeenCalledTimes(2);
        expect(yield* Effect.promise(() => changed)).toMatchObject({
          proxyUrl: "http://proxy-b.test:8080",
        });
        expect(readSystemProxy("win32").proxyUrl).toBe("http://proxy-b.test:8080");
      } finally {
        nativeProbe.execFile.mockReset();
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it("keeps the Linux direct-connection behavior", () => {
    expect(readSystemProxy("linux").proxyUrl).toBeNull();
  });
});
